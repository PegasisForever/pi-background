import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, getShellConfig, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Sandbox } from "./agent-job.ts";
import { parseSandbox, runAgent } from "./agent-job.ts";
import { runCommand } from "./command-job.ts";
import * as jobs from "./jobs.ts";
import { log } from "./log.ts";
import { block, header, labelled, type Shown, shown } from "./shown.ts";

/**
 * Read on every call, never cached, so `PI_CODING_AGENT_DIR` is honoured wherever it is set.
 * The same rule holds for the jobs directory in `jobs.ts`.
 */
const stateDir = (): string => join(getAgentDir(), "state");
const CONFIG_NAME = "pi-background.json";
/** Caps reasoning plus output, so it must survive the model's thinking. */
const CLASSIFIER_MAX_TOKENS = 2048;
const MAX_NUDGES_PER_TURN = 5;
/** A classification was measured at 1.8 s; this only has to bound a stalled connection. */
const CLASSIFIER_TIMEOUT_MS = 60_000;
const NUDGE_PROMPT =
	"Below is an assistant message that ended a turn. If it promised a next action that it is " +
	"going to do (only includes next actions the assistant is going to do, not include the next " +
	"action it says the user is going to do), reply with that action in at most 15 words. " +
	"Otherwise reply with exactly: NO";

const ConfigSchema = Type.Object(
	{
		maxDepth: Type.Optional(Type.Integer({ minimum: 1 })),
		nudgeModel: Type.Optional(Type.String({ pattern: "^[^/]+/.+$" })),
		nudgeThinking: Type.Optional(
			Type.Union([
				Type.Literal("minimal"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("xhigh"),
				Type.Literal("max"),
			]),
		),
		isolated: Type.Optional(
			Type.Object(
				{ create: Type.String(), instructions: Type.String() },
				{ additionalProperties: false },
			),
		),
		logFile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		debug: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
type Raw = Static<typeof ConfigSchema>;

/** The settings, with every default already filled in, so nothing downstream repeats them. */
interface Config extends Raw {
	logFile: string;
	debug: boolean;
}

const defaultLogFile = (): string => join(getAgentDir(), "pi-background.log");

function readConfig(cwd: string): Config {
	const merged: Record<string, unknown> = {};
	const sources: string[] = [];
	for (const path of [join(getAgentDir(), CONFIG_NAME), join(cwd, CONFIG_DIR_NAME, CONFIG_NAME)]) {
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
		sources.push(path);
		Object.assign(merged, parse(path, raw));
	}
	const wrong = problem(merged);
	if (wrong !== undefined) throw new Error(`${sources.join(" + ")}: ${wrong}`);
	if ((merged.nudgeModel === undefined) !== (merged.nudgeThinking === undefined)) {
		throw new Error(`${CONFIG_NAME}: nudgeModel and nudgeThinking must be set together`);
	}
	const raw = merged as Raw;
	return {
		...raw,
		logFile: typeof raw.logFile === "string" ? raw.logFile : defaultLogFile(),
		debug: raw.debug ?? false,
	};
}

/**
 * What is wrong with a config file, in one sentence, or undefined when nothing is (C7). A schema
 * checker on its own says "must not have additional properties" and never names the key, which is
 * the one thing you need to fix a typo, so the unknown key is found here instead.
 */
function problem(value: Record<string, unknown>): string | undefined {
	const allowed = Object.keys(ConfigSchema.properties);
	const unknown = Object.keys(value).find((key) => !allowed.includes(key));
	if (unknown !== undefined) return `unknown key "${unknown}". The keys are ${allowed.join(", ")}.`;
	const error = [...Value.Errors(ConfigSchema, value)][0];
	if (error === undefined) return undefined;
	const path = error.instancePath.split("/").filter((step) => step !== "");
	if (path.length === 0) return error.message;
	let at: unknown = value;
	for (const step of path) at = (at as Record<string, unknown> | undefined)?.[step];
	return `"${path.join(".")}" is ${JSON.stringify(at)}, which that key does not take.`;
}

function parse(path: string, text: string): Record<string, unknown> {
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		throw new Error(
			`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Field 22 of /proc/self/stat, after the comm field's closing parenthesis. */
function procStart(): string {
	const stat = readFileSync("/proc/self/stat", "utf8");
	const field = stat
		.slice(stat.lastIndexOf(")") + 1)
		.trim()
		.split(/\s+/)[19];
	if (!field) throw new Error("pi-background: could not read starttime from /proc/self/stat");
	return field;
}

const assistantText = (content: readonly { type: string }[]): string =>
	content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");

const TitleParam = Type.String({ description: "Short title for this job, shown in the job list" });
const ExpectedParam = Type.Number({
	minimum: 1,
	description:
		"Roughly how long you expect this to take, in seconds. Nothing is killed at that mark: " +
		"if it is still running you are told so, and you decide whether to let it continue.",
});

export default function (pi: ExtensionAPI) {
	pi.registerFlag("jobs-depth", { type: "string", description: "Internal: remaining subagent depth" });

	let config: Config = { logFile: defaultLogFile(), debug: false };
	let depthRemaining = 1;
	let isChild = false;
	let nudgesThisTurn = 0;
	let runtime: ModelRuntime | undefined;
	const statePath = join(stateDir(), `${process.pid}.json`);
	const started = procStart();

	/**
	 * Human-only: a count in pi's footer, and a durable listing from /jobs. The key is the
	 * extension's own name, so `pi-powerline-footer` can lift it into a segment of its own.
	 */
	function refreshStatus(ctx: ExtensionContext): void {
		const live = jobs.running();
		const commands = live.filter((j) => j.kind === "command").length;
		const agents = live.length - commands;
		const parts = [
			commands > 0 ? `${commands} command${commands > 1 ? "s" : ""}` : undefined,
			agents > 0 ? `${agents} subagent${agents > 1 ? "s" : ""}` : undefined,
		].filter((p) => p !== undefined);
		ctx.ui.setStatus(jobs.NAME, parts.length ? parts.join(", ") : undefined);
	}

	function refreshActivity(ctx: ExtensionContext): void {
		refreshStatus(ctx);
		const body = JSON.stringify({
			pid: process.pid,
			procStart: started,
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			status: !ctx.isIdle() || jobs.activeCount() > 0 ? "active" : "idle",
		});
		writeFileSync(`${statePath}.tmp`, body);
		renameSync(`${statePath}.tmp`, statePath);
	}

	async function classify(text: string): Promise<string> {
		runtime ??= await ModelRuntime.create();
		const [provider, ...rest] = config.nudgeModel!.split("/");
		const model = runtime.getModel(provider as string, rest.join("/"));
		if (!model) throw new Error(`nudgeModel not found: ${config.nudgeModel}`);
		const reply = await runtime.completeSimple(
			model,
			{
				systemPrompt: NUDGE_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
			},
			{
				reasoning: config.nudgeThinking,
				cacheRetention: "none",
				maxTokens: CLASSIFIER_MAX_TOKENS,
				signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS),
			},
		);
		// completeSimple resolves on provider errors instead of rejecting.
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			throw new Error(`nudge classifier failed: ${reply.errorMessage ?? reply.stopReason}`);
		}
		const answer = assistantText(reply.content).trim();
		if (answer === "") {
			throw new Error(
				`nudge classifier produced no text: ${config.nudgeModel} at thinking "${config.nudgeThinking}" within ${CLASSIFIER_MAX_TOKENS} tokens`,
			);
		}
		return answer === "NO" ? "" : answer;
	}

	async function nudge(ctx: ExtensionContext): Promise<void> {
		if (isChild || !config.nudgeModel) return;
		if (nudgesThisTurn >= MAX_NUDGES_PER_TURN || jobs.activeCount() > 0) return;
		const leaf = ctx.sessionManager.getLeafEntry();
		const msg = leaf?.type === "message" ? leaf.message : undefined;
		if (msg?.role !== "assistant") return;
		if (msg.stopReason === "error" || msg.stopReason === "aborted") return;
		const text = assistantText(msg.content).trim();
		if (!text) return;

		const action = await classify(text);
		if (action === "") return;
		nudgesThisTurn += 1;
		log(config, "nudge", { action, nth: nudgesThisTurn });
		pi.sendUserMessage(`You said you would ${action}, but did not. Continue.`);
	}

	pi.registerEntryRenderer<Shown>(`${jobs.NAME}-listing`, (entry, _options, theme) =>
		block(theme, entry.data ?? { lines: [] }),
	);

	pi.registerMessageRenderer<Shown>(jobs.NAME, (message, _options, theme) =>
		labelled(theme, jobs.NAME, message.details?.lines ?? []),
	);

	pi.registerCommand("jobs", {
		description: "List running jobs (shown to you only, never sent to the model)",
		handler: async () => {
			pi.appendEntry<Shown>(`${jobs.NAME}-listing`, { lines: jobs.table(), heading: true });
		},
	});

	/** Both readers are served from one job: text for the model, lines for the TUI. */
	const answer = (job: jobs.Job) => ({
		content: [{ type: "text" as const, text: jobs.started(job) }],
		details: { lines: [`Expected: ${jobs.expectedText(job)}`] },
	});

	function registerTools(): void {
		const isolated = config.isolated;
		pi.registerTool<typeof BashParams, Shown>({
			name: "bash",
			label: "bash",
			description:
				`Run a shell command. A command you expect to take less than ${jobs.FOREGROUND_MAX_SECONDS} ` +
				"seconds runs while you wait, and returns the end of its output with the exit code. " +
				"Anything longer, and any service, starts in the background at once and is delivered to " +
				"you when it ends, so end your turn rather than polling or sleeping. A command that " +
				"passes your estimate is not stopped: it moves to the background and you are told when " +
				"it ends, with a job id that job_list and job_stop take. Nothing is ever killed by the " +
				"clock — only job_stop ends a command early. The whole output is always written to a " +
				"file whose path you are given; read it when the end is not enough.",
			promptSnippet: "Run shell commands (ls, grep, find, etc.); a long one moves to the background",
			parameters: BashParams,
			async execute(_id, params, signal, _onUpdate, toolCtx) {
				const cwd = params.cwd ?? toolCtx.cwd;
				const seconds = params.expectedSeconds;
				const foreground = seconds !== null && seconds < jobs.FOREGROUND_MAX_SECONDS;
				const job = jobs.start(
					{ kind: "command", title: params.title, cwd, expectedSeconds: seconds, foreground },
					(j) => runCommand(j, params.command, cwd),
				);
				if (!foreground) return answer(job);

				const how = await jobs.waitInForeground(job, seconds, signal);
				// The command can end in the same tick the wait expires, so its status is the authority.
				if (job.status !== "running") {
					return {
						content: [{ type: "text" as const, text: jobs.finished(job) }],
						details: { lines: jobs.finishedForYou(job) },
					};
				}
				const overran = how === "overran";
				jobs.detach(job, seconds, overran);
				return {
					content: [{ type: "text" as const, text: jobs.handedOff(job, overran) }],
					details: { lines: jobs.handedOffForYou(job, overran) },
				};
			},
			renderCall: (params, theme) => header(theme, "bash", params.title),
			renderResult: (result, _options, theme) => shown(result, theme),
		});

		if (depthRemaining > 0) {
			const RunAgentParams = Type.Object({
				task: Type.String({ description: "The complete instruction for the subagent" }),
				title: TitleParam,
				expectedSeconds: ExpectedParam,
				cwd: Type.Optional(Type.String({ description: "Working directory" })),
				// Offered only when a sandbox provider is configured, so there is nothing to refuse.
				...(isolated
					? {
							isolation: Type.Optional(
								Type.Union([Type.Literal("local"), Type.Literal("isolated")], {
									description: "isolated runs in a fresh sandbox",
								}),
							),
						}
					: {}),
			});

			pi.registerTool<typeof RunAgentParams, Shown>({
				name: "run_agent",
				label: "Run agent",
				description:
					"Start a subagent on a task and return immediately. The result is delivered to you " +
					"automatically when it finishes, so end your turn rather than polling or sleeping. " +
					"The subagent starts with no context: put everything it needs in the task. It returns " +
					"a job id, which job_list, job_stop and resume_agent take." +
					(isolated ? `\n\n${isolated.instructions}` : ""),
				parameters: RunAgentParams,
				async execute(_id, params, _signal, _onUpdate, toolCtx) {
					let sandbox: Sandbox | undefined;
					if (isolated && params.isolation === "isolated") {
						const shell = getShellConfig();
						const run = await pi.exec(shell.shell, [...shell.args, isolated.create]);
						if (run.code !== 0) throw new Error(`isolated.create failed: ${run.stderr.trim()}`);
						sandbox = parseSandbox(run.stdout);
					}
					const cwd = sandbox?.cwd ?? params.cwd ?? toolCtx.cwd;
					return answer(
						jobs.start(
							{
								kind: "agent",
								title: params.title,
								cwd,
								expectedSeconds: params.expectedSeconds,
								sandboxId: sandbox?.id,
								ssh: sandbox?.ssh,
							},
							(j) =>
								runAgent(j, {
									task: params.task,
									cwd,
									depthRemaining,
									sessionDir: j.dir,
									sessionId: j.id,
									ssh: sandbox?.ssh,
								}),
						),
					);
				},
				renderCall: (params, theme) => header(theme, "run_agent", params.title),
				renderResult: (result, _options, theme) => shown(result, theme),
			});

			pi.registerTool<typeof ResumeAgentParams, Shown>({
				name: "resume_agent",
				label: "Resume agent",
				description:
					"Continue a finished subagent with a follow-up task. It keeps the original job's " +
					"context, directory and host, so it takes neither cwd nor isolation. It returns a new " +
					"job id, which job_list, job_stop and resume_agent take.",
				parameters: ResumeAgentParams,
				async execute(_id, params) {
					const previous = jobs.get(params.jobId);
					if (!previous) throw new Error(`no such job: ${params.jobId}`);
					if (previous.kind !== "agent") throw new Error(`job ${previous.id} is not a subagent`);
					if (previous.status === "running") {
						throw new Error(`job ${previous.id} is still running; stop it or wait for it`);
					}
					if (jobs.running().some((j) => j.sessionOf === previous.sessionOf)) {
						throw new Error(`another job is already continuing ${previous.id}`);
					}
					return answer(
						jobs.start(
							{
								kind: "agent",
								title: params.title,
								cwd: previous.cwd,
								expectedSeconds: params.expectedSeconds,
								sandboxId: previous.sandboxId,
								ssh: previous.ssh,
								sessionOf: previous.sessionOf,
							},
							(j) =>
								runAgent(j, {
									task: params.task,
									cwd: previous.cwd,
									depthRemaining,
									sessionDir: previous.dir,
									sessionId: previous.id,
									ssh: previous.ssh,
								}),
						),
					);
				},
				renderCall: (params, theme) => header(theme, "resume_agent", params.title),
				renderResult: (result, _options, theme) => shown(result, theme),
			});
		}

		pi.registerTool<typeof NoParams, Shown>({
			name: "job_list",
			label: "List jobs",
			description:
				"Every job this session still has running, grouped by kind, with elapsed time and the " +
				"duration you expected. A finished job is not listed: it reported itself when it ended.",
			parameters: NoParams,
			async execute() {
				return {
					content: [{ type: "text", text: jobs.listing() }],
					details: { lines: jobs.table(), heading: true },
				};
			},
			renderCall: (_params, theme) => header(theme, "job_list"),
			renderResult: (result, _options, theme) => shown(result, theme),
		});

		pi.registerTool<typeof JobStopParams, Shown>({
			name: "job_stop",
			label: "Stop job",
			description: "Stop a running job by its id — a shell command or a subagent.",
			parameters: JobStopParams,
			async execute(_id, params) {
				const before = jobs.get(params.id);
				if (!before) throw new Error(`no such job: ${params.id}`);
				const wasRunning = before.status === "running";
				await jobs.stop(params.id);
				return {
					content: [{ type: "text", text: jobs.stopped(before, wasRunning) }],
					details: { lines: [] },
				};
			},
			renderCall: (params, theme) => header(theme, "job_stop", jobs.get(params.id)?.title ?? params.id),
			renderResult: (result, _options, theme) => shown(result, theme),
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		config = readConfig(ctx.cwd);
		const flag = pi.getFlag("jobs-depth");
		isChild = typeof flag === "string";
		if (isChild) {
			depthRemaining = Number(flag);
			if (!Number.isInteger(depthRemaining) || depthRemaining < 0) {
				throw new Error(
					`pi-background: --jobs-depth must be a whole number, got "${flag as string}"`,
				);
			}
		} else {
			depthRemaining = config.maxDepth ?? 1;
		}
		mkdirSync(stateDir(), { recursive: true });
		jobs.init(
			pi,
			() => refreshActivity(ctx),
			(event, data) => log(config, event, data),
		);
		registerTools();
		refreshActivity(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(jobs.NAME, undefined);
		await jobs.shutdown();
		rmSync(statePath);
	});

	pi.on("agent_start", async (_event, ctx) => refreshActivity(ctx));

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			await nudge(ctx);
		} finally {
			refreshActivity(ctx);
		}
	});

	// Our own nudge arrives as "extension"; a person types "interactive", a client sends "rpc".
	pi.on("input", async (event) => {
		if (event.source !== "extension") nudgesThisTurn = 0;
	});
}

const BashParams = Type.Object({
	command: Type.String({ description: "Shell command" }),
	title: TitleParam,
	cwd: Type.Optional(Type.String({ description: "Working directory" })),
	expectedSeconds: Type.Union([Type.Number({ minimum: 1 }), Type.Null()], {
		description:
			"Roughly how long you expect this to take, in seconds. It decides whether you wait for " +
			"the command or it starts in the background. Nothing is killed at that mark: if the " +
			"command is still running you are told so, and you decide whether to let it continue. " +
			"Pass null for a service such as a dev server, which you are not waiting on.",
	}),
});

const ResumeAgentParams = Type.Object({
	jobId: Type.String({ description: "Job id of the finished subagent to continue" }),
	task: Type.String({ description: "The follow-up instruction for the subagent" }),
	title: TitleParam,
	expectedSeconds: ExpectedParam,
});

const NoParams = Type.Object({});
const JobStopParams = Type.Object({ id: Type.String({ description: "Job id to stop" }) });

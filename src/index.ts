import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getShellConfig,
	ModelRuntime,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { parseSandbox, runAgent } from "./agent-job.ts";
import type { Sandbox } from "./agent-job.ts";
import { runCommand } from "./command-job.ts";
import * as jobs from "./jobs.ts";

const STATE_DIR = join(getAgentDir(), "state");
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
	},
	{ additionalProperties: false },
);
type Config = Static<typeof ConfigSchema>;

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
		Object.assign(merged, JSON.parse(raw) as Record<string, unknown>);
	}
	if (!Value.Check(ConfigSchema, merged)) {
		const problems = [...Value.Errors(ConfigSchema, merged)]
			.map((e) => `${e.instancePath || "/"} ${e.message}`)
			.join("; ");
		throw new Error(`${sources.join(" + ")}: ${problems}`);
	}
	if ((merged.nudgeModel === undefined) !== (merged.nudgeThinking === undefined)) {
		throw new Error(`${CONFIG_NAME}: nudgeModel and nudgeThinking must be set together`);
	}
	return merged;
}

/** Field 22 of /proc/self/stat, after the comm field's closing parenthesis. */
function procStart(): string {
	const stat = readFileSync("/proc/self/stat", "utf8");
	const field = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
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

/** What a tool tells the TUI and never tells the model. */
interface Shown {
	lines: string[];
	/** The first line is a table heading, so it is dimmed rather than read as data. */
	heading?: boolean;
}

const fill = (box: Box, theme: Theme, colour: "customMessageText" | "toolOutput", shown: Shown) => {
	shown.lines.forEach((line, i) =>
		box.addChild(new Text(theme.fg(shown.heading && i === 0 ? "muted" : colour, line), 0, 0)),
	);
	return box;
};

/** A block of our own: pi does not wrap a custom renderer, so it pads and tints itself. */
const block = (theme: Theme, shown: Shown): Component =>
	fill(new Box(1, 1, (t: string) => theme.bg("customMessageBg", t)), theme, "customMessageText", shown);

/** Lines inside pi's tool shell, which already pads. A second Box would indent them again. */
const rows = (theme: Theme, shown: Shown): Component =>
	fill(new Box(0, 0), theme, "toolOutput", shown);

const header = (theme: Theme, name: string, title?: string): Component =>
	new Text(theme.fg("toolTitle", theme.bold(name)) + (title ? ` ${title}` : ""), 0, 0);

const shown = (result: { details?: Shown }, theme: Theme): Component =>
	rows(theme, result.details ?? { lines: [] });

export default function (pi: ExtensionAPI) {
	pi.registerFlag("jobs-depth", { type: "string", description: "Internal: remaining subagent depth" });

	let config: Config = {};
	let depthRemaining = 1;
	let isChild = false;
	let nudgesThisTurn = 0;
	let runtime: ModelRuntime | undefined;
	const statePath = join(STATE_DIR, `${process.pid}.json`);
	const started = procStart();

	/** Human-only: a count under the editor, and a durable listing from /jobs. */
	function refreshStatus(ctx: ExtensionContext): void {
		const live = jobs.running();
		const commands = live.filter((j) => j.kind === "command").length;
		const agents = live.length - commands;
		const parts = [
			commands > 0 ? `${commands} command${commands > 1 ? "s" : ""}` : undefined,
			agents > 0 ? `${agents} subagent${agents > 1 ? "s" : ""}` : undefined,
		].filter((p) => p !== undefined);
		ctx.ui.setWidget("pi-background", parts.length ? [parts.join(", ")] : undefined, {
			placement: "belowEditor",
		});
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
		if (!msg || msg.role !== "assistant") return;
		if (msg.stopReason === "error" || msg.stopReason === "aborted") return;
		const text = assistantText(msg.content).trim();
		if (!text) return;

		const action = await classify(text);
		if (action === "") return;
		nudgesThisTurn += 1;
		pi.sendUserMessage(`You said you would ${action}, but did not. Continue.`);
	}

	pi.registerEntryRenderer<Shown>("pi-background-listing", (entry, _options, theme) =>
		block(theme, entry.data ?? { lines: [] }),
	);

	pi.registerMessageRenderer<Shown>("pi-background", (message, _options, theme) => {
		const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[pi-background]")), 0, 0));
		box.addChild(new Spacer(1));
		for (const line of message.details?.lines ?? []) {
			box.addChild(new Text(theme.fg("customMessageText", line), 0, 0));
		}
		return box;
	});

	pi.registerCommand("jobs", {
		description: "List running jobs (shown to you only, never sent to the model)",
		handler: async () => {
			pi.appendEntry<Shown>("pi-background-listing", { lines: jobs.table(), heading: true });
		},
	});

	/** Both readers are served from one job: text for the model, lines for the TUI. */
	const answer = (job: jobs.Job) => ({
		content: [{ type: "text" as const, text: jobs.started(job) }],
		details: { lines: [`Expected: ${jobs.expectedText(job)}`] },
	});

	function registerTools(): void {
		const isolated = config.isolated;
		pi.registerTool<typeof RunCommandParams, Shown>({
			name: "run_command",
			label: "Run command",
			description:
				"Start a shell command in the background and return immediately. Give expectedSeconds a " +
				"number for work you are waiting on: the result is delivered to you automatically when it " +
				"ends, so end your turn rather than polling or sleeping. Give it null for a service that " +
				"runs until stopped; you are told if it stops on its own. Nothing is ever killed by the " +
				"clock — only job_stop ends a job early. It returns a job id, which job_list and job_stop " +
				"take.",
			parameters: RunCommandParams,
			async execute(_id, params, _signal, _onUpdate, toolCtx) {
				const cwd = params.cwd ?? toolCtx.cwd;
				return answer(
					jobs.start(
						{ kind: "command", title: params.title, cwd, expectedSeconds: params.expectedSeconds },
						(j) => runCommand(j, params.command, cwd),
					),
				);
			},
			renderCall: (params, theme) => header(theme, "run_command", params.title),
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
			renderCall: (params, theme) =>
				header(theme, "job_stop", jobs.get(params.id)?.title ?? params.id),
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
				throw new Error(`pi-background: --jobs-depth must be a whole number, got "${flag as string}"`);
			}
		} else {
			depthRemaining = config.maxDepth ?? 1;
		}
		mkdirSync(STATE_DIR, { recursive: true });
		jobs.init(pi, () => refreshActivity(ctx));
		registerTools();
		refreshActivity(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget("pi-background", undefined);
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

const RunCommandParams = Type.Object({
	command: Type.String({ description: "Shell command" }),
	title: TitleParam,
	cwd: Type.Optional(Type.String({ description: "Working directory" })),
	expectedSeconds: Type.Union([Type.Number({ minimum: 1 }), Type.Null()], {
		description:
			"Roughly how long you expect this to take, in seconds. Nothing is killed at that mark: " +
			"if the command is still running you are told so, and you decide whether to let it " +
			"continue. Pass null for a service such as a dev server, which you are not waiting on.",
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

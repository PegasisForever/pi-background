import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getShellConfig,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { parseSandbox, runAgent } from "./agent-job.ts";
import { runCommand } from "./command-job.ts";
import * as jobs from "./jobs.ts";

const STATE_DIR = join(getAgentDir(), "state");
const CONFIG_NAME = "pi-jobs.json";
/** Caps reasoning plus output, so it must survive the model's thinking. */
const CLASSIFIER_MAX_TOKENS = 2048;
const MAX_NUDGES_PER_TURN = 5;
/** A classification was measured at 1.8 s; this only has to bound a stalled connection. */
const CLASSIFIER_TIMEOUT_MS = 60_000;
const NUDGE_PROMPT =
	"Below is an assistant message that ended a turn. If it promised a next action that it did " +
	"not perform, reply with that action in at most 15 words. Otherwise reply with exactly: NO";

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
	if (!field) throw new Error("pi-jobs: could not read starttime from /proc/self/stat");
	return field;
}

const assistantText = (content: readonly { type: string }[]): string =>
	content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");

const firstLine = (text: string): string => {
	const line = text.trim().split("\n", 1)[0] as string;
	return line.length > 120 ? `${line.slice(0, 120)}…` : line;
};

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
		ctx.ui.setWidget("pi-jobs", parts.length ? [parts.join(", ")] : undefined, {
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

	pi.registerEntryRenderer<{ lines: string[] }>("pi-jobs-listing", (entry, _options, theme) => {
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		for (const line of entry.data?.lines ?? []) box.addChild(new Text(line, 0, 0));
		return box;
	});

	pi.registerCommand("jobs", {
		description: "List running jobs (shown to you only, never sent to the model)",
		handler: async () => {
			const live = jobs.running();
			pi.appendEntry("pi-jobs-listing", {
				lines: live.length === 0 ? ["No jobs running."] : live.map((j) => jobs.summarise(j)),
			});
		},
	});

	function registerTools(): void {
		const isolated = config.isolated;
		pi.registerTool({
			name: "run_command",
			label: "Run command",
			description:
				"Start a shell command in the background and return immediately. Give timeoutSeconds a " +
				"number for work you are waiting on: the result is delivered to you automatically when it " +
				"ends, so end your turn rather than polling or sleeping. Give it null for a service that " +
				"runs until stopped and never notifies. It returns a job id, which job_list and job_stop take.",
			parameters: Type.Object({
				command: Type.String({ description: "Shell command" }),
				cwd: Type.Optional(Type.String({ description: "Working directory" })),
				timeoutSeconds: Type.Union([Type.Number({ minimum: 1 }), Type.Null()], {
					description:
						"Seconds to wait, as pi's bash tool counts them. Pass null for a service such as a " +
						"dev server: it runs until stopped and never notifies.",
				}),
			}),
			async execute(_id, params, _signal, _onUpdate, toolCtx) {
				const cwd = params.cwd ?? toolCtx.cwd;
				const job = jobs.start(
					{ kind: "command", label: firstLine(params.command), cwd, timeoutSeconds: params.timeoutSeconds },
					(j) => runCommand(j, params.command, cwd),
				);
				return { content: [{ type: "text", text: jobs.describe(job) }], details: {} };
			},
		});

		if (depthRemaining > 0) {
			pi.registerTool({
				name: "run_agent",
				label: "Run agent",
				description:
					"Start a subagent on a task and return immediately. The result is delivered to you " +
					"automatically when it finishes, so end your turn rather than polling or sleeping. " +
					"The subagent starts with no context: put everything it needs in the task. It returns a " +
					"job id, which job_list and job_stop take." +
					(isolated ? `\n\n${isolated.instructions}` : ""),
				parameters: Type.Object({
					task: Type.String({ description: "The complete instruction for the subagent" }),
					timeoutSeconds: Type.Number({
						minimum: 1,
						description: "Seconds to wait before giving up, as pi's bash tool counts them",
					}),
					cwd: Type.Optional(Type.String({ description: "Working directory; not allowed with resumeFrom" })),
					resumeFrom: Type.Optional(Type.String({ description: "Job id to continue" })),
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
				}),
				async execute(_id, params, _signal, _onUpdate, toolCtx) {
					const previous = params.resumeFrom ? jobs.get(params.resumeFrom) : undefined;
					if (params.resumeFrom) {
						if (!previous) throw new Error(`no such job: ${params.resumeFrom}`);
						if (previous.status === "running") {
							throw new Error(`job ${previous.id} is still running; stop it or wait for it`);
						}
						if (params.isolation) {
							throw new Error("resumeFrom continues the original job's host; drop isolation");
						}
						if (params.cwd) {
							throw new Error("resumeFrom continues the original job's directory; drop cwd");
						}
						if (jobs.list().some((j) => j.status === "running" && j.sessionOf === previous.sessionOf)) {
							throw new Error(`another job is already continuing ${previous.id}`);
						}
					}
					let sandbox;
					if (isolated && params.isolation === "isolated") {
						const shell = getShellConfig();
						const run = await pi.exec(shell.shell, [...shell.args, isolated.create]);
						if (run.code !== 0) throw new Error(`isolated.create failed: ${run.stderr.trim()}`);
						sandbox = parseSandbox(run.stdout);
					}
					const ssh = sandbox?.ssh ?? previous?.ssh;
					const cwd = sandbox?.cwd ?? previous?.cwd ?? params.cwd ?? toolCtx.cwd;
					const job = jobs.start(
						{
							kind: "agent",
							label: firstLine(params.task),
							cwd,
							timeoutSeconds: params.timeoutSeconds,
							sandboxId: sandbox?.id ?? previous?.sandboxId,
							ssh,
							sessionOf: previous?.sessionOf,
						},
						(j) =>
							runAgent(j, {
								task: params.task,
								cwd,
								depthRemaining,
								sessionDir: previous?.dir ?? j.dir,
								sessionId: previous?.id ?? j.id,
								ssh,
							}),
					);
					return { content: [{ type: "text", text: jobs.describe(job) }], details: {} };
				},
			});
		}

		pi.registerTool({
			name: "job_list",
			label: "List jobs",
			description:
				"Every job this session started with run_command or run_agent: status, elapsed, output " +
				"paths and sandbox ids.",
			parameters: Type.Object({}),
			async execute() {
				const all = jobs.list();
				const text = all.length === 0 ? "no jobs" : all.map(jobs.describe).join("\n\n");
				return { content: [{ type: "text", text }], details: {} };
			},
		});

		pi.registerTool({
			name: "job_stop",
			label: "Stop job",
			description: "Stop a running job by its id — a shell command or a subagent.",
			parameters: Type.Object({ id: Type.String() }),
			async execute(_id, params) {
				const job = await jobs.stop(params.id);
				if (!job) throw new Error(`no such job: ${params.id}`);
				return { content: [{ type: "text", text: jobs.describe(job) }], details: {} };
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		config = readConfig(ctx.cwd);
		const flag = pi.getFlag("jobs-depth");
		isChild = typeof flag === "string";
		if (isChild) {
			depthRemaining = Number(flag);
			if (!Number.isInteger(depthRemaining) || depthRemaining < 0) {
				throw new Error(`pi-jobs: --jobs-depth must be a whole number, got "${flag as string}"`);
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
		ctx.ui.setWidget("pi-jobs", undefined);
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

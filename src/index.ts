import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, getShellConfig, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Static, TObject } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Sandbox } from "./agent-job.ts";
import { parseSandbox, runAgent } from "./agent-job.ts";
import { runCommand } from "./command-job.ts";
import * as jobs from "./jobs.ts";
import { block, header, labelled, type Shown, shown } from "./shown.ts";

const STATE_DIR = join(getAgentDir(), "state");
const CONFIG_NAME = "settings.json";
/** Our own name, as the key our settings sit under inside that file. */
const NAME = jobs.NAME;
/** Caps reasoning plus output, so it must survive the model's thinking. */
const CLASSIFIER_MAX_TOKENS = 2048;
const MAX_NUDGES_PER_TURN = 5;
/** A classification was measured at 1.8 s; this only has to bound a stalled connection. */
const CLASSIFIER_TIMEOUT_MS = 60_000;
const NUDGE_PROMPT =
	"Below is an assistant message that ended a turn. If the assistant stated it will do something " +
	"next itself, reply with that action in at most 15 words. A stated decision counts, such as 'I " +
	"will', 'I will now', 'Let me', 'I am going to'. Otherwise reply with exactly: NO. A question, a " +
	"request for permission or confirmation, a conditional offer such as 'if you want', 'should I', " +
	"'I can', or 'tell me if', or an action it says the user will do is not a decision. When in " +
	"doubt, reply NO.";

const ConfigSchema = Type.Object(
	{
		maxDepth: Type.Optional(Type.Integer({ minimum: 1 })),
		// One object, so "a model with no effort" is unrepresentable rather than checked for.
		nudge: Type.Optional(
			Type.Object(
				{
					model: Type.String({ pattern: "^[^/]+/.+$" }),
					effort: Type.Union([
						Type.Literal("minimal"),
						Type.Literal("low"),
						Type.Literal("medium"),
						Type.Literal("high"),
						Type.Literal("xhigh"),
						Type.Literal("max"),
					]),
				},
				{ additionalProperties: false },
			),
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

/**
 * Our settings live under our own name in Pi's `settings.json`, the file `pi-powerline-footer`
 * already uses, rather than in a file of our own. Global first, then the project's, shallow merged
 * so the project wins — the order Pi's own `SettingsManager` uses. Pi re-reads this file and spreads
 * it before every write it makes (`core/settings-manager.js:381`), so a key it does not know about
 * survives a theme change.
 */
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
		const ours = section(path, parse(path, raw));
		if (ours === undefined) continue;
		sources.push(path);
		Object.assign(merged, ours);
	}
	const wrong = problem(merged);
	if (wrong !== undefined) throw new Error(`${sources.join(" + ")}: "${NAME}": ${wrong}`);
	return merged;
}

/** Our object out of one settings file, or undefined when that file says nothing about us. */
function section(path: string, settings: Record<string, unknown>): Record<string, unknown> | undefined {
	const ours = settings[NAME];
	if (ours === undefined) return undefined;
	if (ours === null || typeof ours !== "object" || Array.isArray(ours))
		throw new Error(`${path}: "${NAME}" must be a JSON object.`);
	return ours as Record<string, unknown>;
}

/**
 * What is wrong with a config file, in one sentence, or undefined when nothing is (C7). A schema
 * checker on its own says "must not have additional properties" and never names the key, which is
 * the one thing you need to fix a typo, so missing and unknown keys are found here instead.
 */
function problem(value: Record<string, unknown>): string | undefined {
	const named = keyProblem(ConfigSchema, value, []);
	if (named !== undefined) return named;
	const error = [...Value.Errors(ConfigSchema, value)][0];
	if (error === undefined) return undefined;
	const path = error.instancePath.split("/").filter((step) => step !== "");
	if (path.length === 0) return error.message;
	let at: unknown = value;
	for (const step of path) at = (at as Record<string, unknown> | undefined)?.[step];
	return `"${path.join(".")}" is ${JSON.stringify(at)}, which that key does not take.`;
}

/** Unknown and missing keys, by name, at every level of the schema — `nudge` and `isolated` are
 * objects too, and "nudge is {...}, which that key does not take" does not say what is wrong. */
function keyProblem(schema: TObject, value: unknown, at: string[]): string | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const where = at.length === 0 ? "" : `"${at.join(".")}": `;
	const allowed = Object.keys(schema.properties);
	const unknown = Object.keys(record).find((key) => !allowed.includes(key));
	if (unknown !== undefined) return `${where}unknown key "${unknown}". The keys are ${allowed.join(", ")}.`;
	const missing = (schema.required ?? []).find((key) => record[key] === undefined);
	if (missing !== undefined) return `${where}"${missing}" is required.`;
	for (const [key, child] of Object.entries(schema.properties)) {
		const nested = child as TObject;
		if (nested.type !== "object") continue;
		const deeper = keyProblem(nested, record[key], [...at, key]);
		if (deeper !== undefined) return deeper;
	}
	return undefined;
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

const TitleParam = Type.String({ description: "Short title for this job, shown in the job list" });
const ExpectedParam = Type.Number({
	minimum: 1,
	description:
		"Roughly how long you expect this to take, in seconds. Nothing is killed at that mark: " +
		"if it is still running you are told so, and you decide whether to let it continue.",
});

export default function (pi: ExtensionAPI) {
	pi.registerFlag("jobs-depth", { type: "string", description: "Internal: remaining subagent depth" });

	// At load, from `process.cwd()`, because the factory gets no context object and because Pi drops an
	// extension whose factory throws and says so (`core/extensions/loader.js:483`), where it swallows a
	// throw from a handler and carries on. Read in `session_start`, a one-character typo left the
	// session running on defaults it was never told it had fallen back to.
	const config: Config = readConfig(process.cwd());
	let depthRemaining = config.maxDepth ?? 1;
	let isChild = false;
	let nudgesThisTurn = 0;
	let runtime: ModelRuntime | undefined;
	/** True while `drainIfHeadless` is waiting out background work (headless only, §5.4). */
	let draining = false;
	/** Set at the top of `session_shutdown`; the drain checks it before running dependents. */
	let sessionEnding = false;
	/** Resolved by `poke` on every transition that can end quiescence; re-armed each time. */
	let woken: Promise<void> = Promise.resolve();
	let wake: () => void = () => {};
	const poke = (): void => {
		const w = wake;
		woken = new Promise<void>((resolve) => (wake = resolve));
		w();
	};
	const statePath = join(STATE_DIR, `${process.pid}.json`);
	const started = procStart();

	/**
	 * Human-only: a count in pi's footer, and a durable listing from /jobs. The key is the
	 * extension's own name, so `pi-powerline-footer` can lift it into a segment of its own.
	 */
	function refreshStatus(ctx: ExtensionContext): void {
		const live = jobs.backgrounded();
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
			status: isQuiescent(ctx) ? "idle" : "active",
		});
		writeFileSync(`${statePath}.tmp`, body);
		renameSync(`${statePath}.tmp`, statePath);
	}

	/**
	 * The extension's own settled: the host is idle, nothing is queued, and no awaited job is
	 * running. Services are excluded by design — a service never finishes, so waiting for one
	 * would wait forever (§1, §8). One predicate for the drain, the activity file and the
	 * nudge guard, so the three cannot disagree about what settled means.
	 */
	const isQuiescent = (ctx: ExtensionContext): boolean =>
		ctx.isIdle() && !ctx.hasPendingMessages() && jobs.activeCount() === 0;

	const isHeadless = (ctx: ExtensionContext): boolean => ctx.mode === "print" || ctx.mode === "json";

	/**
	 * Headless drain (§5.4). In `print`/`json` mode the host would otherwise exit as soon as the
	 * first prompt settles and `session_shutdown` would abort still-running jobs. Waiting here —
	 * inside `agent_settled`, which the host awaits before `prompt()` resolves — holds the
	 * process open until every awaited job has reported through the normal notification path.
	 * Event-driven, no timers: each side of the race resolves on a real transition (a job
	 * settling, or `poke()` on a turn or registry change), so there is no sleep to tune and no
	 * stability counter (C10). The empty-list branch matters: `Promise.all([])` resolves at
	 * once, and racing it bare would spin while a notification turn runs.
	 */
	async function drainIfHeadless(ctx: ExtensionContext): Promise<void> {
		if (!isHeadless(ctx) || draining) return;
		if (jobs.activeCount() === 0) return;
		draining = true;
		// Past pokes are already reflected in the synchronous state above; only future
		// transitions may wake the loop, or the first iteration would spin on this.
		woken = new Promise<void>((resolve) => (wake = resolve));
		try {
			for (;;) {
				if (isQuiescent(ctx)) return;
				const awaited = jobs.backgrounded().filter((j) => j.expectedSeconds !== null);
				if (awaited.length > 0) {
					await Promise.race([Promise.all(awaited.map((j) => j.settled)), woken]);
				} else {
					await woken;
				}
			}
		} finally {
			draining = false;
		}
	}

	async function classify(nudge: NonNullable<Config["nudge"]>, text: string): Promise<string> {
		runtime ??= await ModelRuntime.create();
		const [provider, ...rest] = nudge.model.split("/");
		const model = runtime.getModel(provider as string, rest.join("/"));
		if (!model) throw new Error(`nudge.model not found: ${nudge.model}`);
		const reply = await runtime.completeSimple(
			model,
			{
				systemPrompt: NUDGE_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
			},
			{
				reasoning: nudge.effort,
				cacheRetention: "none",
				maxTokens: CLASSIFIER_MAX_TOKENS,
				signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS),
			},
		);
		// completeSimple resolves on provider errors instead of rejecting.
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			throw new Error(`nudge classifier failed: ${reply.errorMessage ?? reply.stopReason}`);
		}
		const answer = contentText(reply.content, "").trim();
		if (answer === "") {
			throw new Error(
				`nudge classifier produced no text: ${nudge.model} at effort "${nudge.effort}" within ${CLASSIFIER_MAX_TOKENS} tokens`,
			);
		}
		// The classifier is told to answer exactly NO, but cheap models add a full stop or
		// change the case, and either variant sent as a nudge reads "You said you would NO." —
		// so the check is the verdict with trailing stops removed, case folded.
		const verdict = answer.replace(/[.\s]+$/g, "").toUpperCase();
		return verdict === "NO" ? "" : answer;
	}

	async function nudge(ctx: ExtensionContext): Promise<void> {
		if (!config.nudge) return;
		if (nudgesThisTurn >= MAX_NUDGES_PER_TURN || jobs.activeCount() > 0) return;
		const leaf = ctx.sessionManager.getLeafEntry();
		const msg = leaf?.type === "message" ? leaf.message : undefined;
		if (msg?.role !== "assistant") return;
		if (msg.stopReason === "error" || msg.stopReason === "aborted") return;
		const text = contentText(msg.content, "").trim();
		if (!text) return;

		const action = await classify(config.nudge, text);
		if (action === "") return;
		nudgesThisTurn += 1;
		pi.sendUserMessage(`You said you would ${action}, but did not. Continue.`);
	}

	pi.registerEntryRenderer<Shown>(`${jobs.NAME}-listing`, (entry, _options, theme) =>
		block(theme, entry.data ?? { lines: [] }),
	);

	pi.registerMessageRenderer<Shown>(jobs.NAME, (message, _options, theme) =>
		labelled(theme, jobs.NAME, message.details?.lines ?? []),
	);

	pi.registerCommand("jobs", {
		description: "List background jobs (shown to you only, never sent to the model)",
		handler: async () => {
			pi.appendEntry<Shown>(`${jobs.NAME}-listing`, { lines: jobs.table(), heading: true });
		},
	});

	/**
	 * A subagent cannot start one of its own beyond the configured depth. The refusal happens here,
	 * when the tool is called, rather than by withholding the tool: what exists must not depend on
	 * a config file that can fail to load.
	 */
	function refuseWithoutDepth(): void {
		if (depthRemaining > 0) return;
		throw new Error("This session has no subagent depth left, so it cannot start one. Do the work here.");
	}

	/** Both readers are served from one job: text for the model, lines for the TUI. */
	const answer = (job: jobs.Job) => ({
		content: [{ type: "text" as const, text: jobs.started(job) }],
		details: { lines: [`Expected: ${jobs.expectedText(job)}`] },
	});

	/**
	 * The parent's model, so a subagent runs on the same one the session is running on instead of
	 * whatever the child would pick as its startup default. A tool call cannot exist without a
	 * model, so a missing one is a state that should not be reached — refused rather than turned
	 * into a child on some other model (C10). Everything else about the child stays its own
	 * (§3.3): no tools, no role, no prompt injection travels with it.
	 */
	function parentModel(ctx: ExtensionContext): {
		model: { provider: string; id: string };
		thinking?: string;
	} {
		const model = ctx.model;
		if (!model) {
			throw new Error("This session has no model, so it cannot start a subagent on the same one.");
		}
		return { model: { provider: model.provider, id: model.id }, thinking: ctx.thinkingLevel };
	}

	/**
	 * Registered before any handler runs, and never from inside one. Pi catches a handler throw and
	 * carries on, so a tool registered in `session_start` disappears for the whole session the first
	 * time anything there fails — a typo in the config file would leave the model with no tools and
	 * a system prompt that still names them. Nothing here may depend on the config: what a tool does
	 * with a missing setting is decided when it is called, and said out loud (C7).
	 */
	function registerTools(): void {
		pi.registerTool<typeof BashParams, Shown>({
			name: "bash",
			label: "bash",
			description:
				`Run a shell command. A command you expect to take less than ${jobs.FOREGROUND_MAX_SECONDS} ` +
				"seconds runs while you wait, and returns its output with the exit code. " +
				"Anything longer, and any service, starts in the background at once and is delivered to " +
				"you when it ends, so end your turn rather than polling or sleeping. A command that " +
				"passes your estimate is not stopped: it moves to the background and you are told when " +
				"it ends, with a job id that job_list and job_stop take. Nothing is ever killed by the " +
				"clock — only job_stop ends a command early. A long output is cut to its end, and the " +
				"result then names the file holding all of it; a result that names no file is whole.",
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

		pi.registerTool<typeof RunAgentParams, Shown>({
			name: "run_agent",
			label: "Run agent",
			description:
				"Start a subagent on a task and return immediately. The result is delivered to you " +
				"automatically when it finishes, so end your turn rather than polling or sleeping. " +
				"The subagent starts with no context: put everything it needs in the task. It returns " +
				'a job id, which job_list, job_stop and resume_agent take. Pass isolation "isolated" ' +
				"to run it in a fresh sandbox; what to do with that sandbox afterwards comes back with " +
				"the job id.",
			parameters: RunAgentParams,
			async execute(_id, params, signal, _onUpdate, toolCtx) {
				refuseWithoutDepth();
				// Before the sandbox create, so a session that cannot name a model never makes one (§12.1).
				const inherited = parentModel(toolCtx);
				let sandbox: Sandbox | undefined;
				if (params.isolation === "isolated") {
					const isolated = config.isolated;
					if (!isolated) {
						throw new Error(
							`No sandbox provider is configured, so isolation "isolated" cannot be used. Set "isolated" in ${CONFIG_NAME}, or leave isolation out and the subagent runs here.`,
						);
					}
					const shell = getShellConfig();
					const run = await pi.exec(shell.shell, [...shell.args, isolated.create], { signal });
					if (run.code !== 0) throw new Error(`isolated.create failed: ${run.stderr.trim()}`);
					sandbox = parseSandbox(run.stdout);
				}
				const cwd = sandbox?.cwd ?? params.cwd ?? toolCtx.cwd;
				const job = jobs.start(
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
							...inherited,
						}),
				);
				const started = answer(job);
				// The sandbox instructions say how to clean one up, so they belong where a sandbox was
				// actually made — not in a description every turn pays for whether or not one is used.
				if (sandbox && config.isolated) {
					started.content[0] = {
						type: "text" as const,
						text: `${started.content[0]?.text ?? ""}\n\n${config.isolated.instructions}`,
					};
				}
				return started;
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
			async execute(_id, params, _signal, _onUpdate, toolCtx) {
				refuseWithoutDepth();
				const inherited = parentModel(toolCtx);
				const previous = jobs.get(params.jobId);
				if (!previous) throw new Error(`no such job: ${params.jobId}`);
				if (previous.kind !== "agent") throw new Error(`job ${previous.id} is not a subagent`);
				if (previous.status === "running") {
					throw new Error(`job ${previous.id} is still running; stop it or wait for it`);
				}
				if (jobs.backgrounded().some((j) => j.sessionOf === previous.sessionOf)) {
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
								...inherited,
							}),
					),
				);
			},
			renderCall: (params, theme) => header(theme, "resume_agent", params.title),
			renderResult: (result, _options, theme) => shown(result, theme),
		});

		pi.registerTool<typeof NoParams, Shown>({
			name: "job_list",
			label: "List jobs",
			description:
				"Every job this session has running in the background, grouped by kind, with elapsed " +
				"time and the duration you expected. A finished job is not listed: it reported itself " +
				"when it ended.",
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

		pi.registerTool<typeof JobServiceParams, Shown>({
			name: "job_service",
			label: "Make service",
			description:
				"Turn a running command into a service, which has no expected duration: you are told " +
				"if it stops, and never that it is taking longer than you thought. Use it when you " +
				"gave a dev server, a watcher or a tail an expectedSeconds by mistake. The command " +
				"itself is not touched.",
			parameters: JobServiceParams,
			async execute(_id, params) {
				const job = jobs.get(params.id);
				if (!job) throw new Error(`no such job: ${params.id}`);
				if (job.kind !== "command") {
					throw new Error(`job ${job.id} is a subagent, which always has an expected duration`);
				}
				if (job.status !== "running") throw new Error(`job ${job.id} is no longer running`);
				const already = job.expectedSeconds === null;
				if (!already) jobs.makeService(job);
				return {
					content: [{ type: "text", text: jobs.served(job, already) }],
					details: { lines: [] },
				};
			},
			renderCall: (params, theme) =>
				header(theme, "job_service", jobs.get(params.id)?.title ?? params.id),
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
				await jobs.stop(before);
				return {
					content: [{ type: "text", text: jobs.stopped(before, wasRunning) }],
					details: { lines: [] },
				};
			},
			renderCall: (params, theme) => header(theme, "job_stop", jobs.get(params.id)?.title ?? params.id),
			renderResult: (result, _options, theme) => shown(result, theme),
		});
	}

	registerTools();

	pi.on("session_start", async (_event, ctx) => {
		const flag = pi.getFlag("jobs-depth");
		isChild = typeof flag === "string";
		if (isChild) {
			depthRemaining = Number(flag);
			if (!Number.isInteger(depthRemaining) || depthRemaining < 0) {
				throw new Error(
					`pi-background: --jobs-depth must be a whole number, got "${flag as string}"`,
				);
			}
		}
		mkdirSync(STATE_DIR, { recursive: true });
		// pi caches the extension module process-wide (see jobs.init), so per-session flags
		// are reset here, not declared fresh.
		sessionEnding = false;
		jobs.init(pi, () => {
			refreshActivity(ctx);
			poke();
		});
		refreshActivity(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionEnding = true;
		ctx.ui.setStatus(jobs.NAME, undefined);
		const services =
			ctx.mode === "print" || ctx.mode === "json"
				? jobs.backgrounded().filter((j) => j.expectedSeconds === null)
				: [];
		await jobs.shutdown();
		// Services never drain (§5.4), so in headless mode this is their only record: no
		// transcript entry, no notification, only the job directory. Say so loudly (C7).
		// TUI stays quiet — the footer teardown is the record there, and stderr would land
		// on the live screen.
		for (const service of services) {
			console.error(`[${jobs.NAME}] Service "${service.title}" (${service.id}) stopped at shutdown.`);
		}
		rmSync(statePath, { force: true });
	});

	pi.on("agent_start", async (_event, ctx) => {
		refreshActivity(ctx);
		poke();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			// In headless mode this holds the session open until background work reports;
			// afterwards settled means what §8 says it means, and the nudge can rely on it.
			// Re-entrant while draining (nested notification turns settle too): the outer loop
			// re-checks, so nested calls must neither drain again nor nudge mid-drain.
			await drainIfHeadless(ctx);
			// Teardown won the race (a signal during the drain): stay quiet, the session
			// is going away and a nudge would send a user message into it.
			if (sessionEnding || draining) return;
			await nudge(ctx);
		} finally {
			refreshActivity(ctx);
			poke();
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

const RunAgentParams = Type.Object({
	task: Type.String({ description: "The complete instruction for the subagent" }),
	title: TitleParam,
	expectedSeconds: ExpectedParam,
	cwd: Type.Optional(Type.String({ description: "Working directory" })),
	isolation: Type.Optional(
		Type.Union([Type.Literal("local"), Type.Literal("isolated")], {
			description: "isolated runs in a fresh sandbox; needs a sandbox provider to be configured",
		}),
	),
});

const ResumeAgentParams = Type.Object({
	jobId: Type.String({ description: "Job id of the finished subagent to continue" }),
	task: Type.String({ description: "The follow-up instruction for the subagent" }),
	title: TitleParam,
	expectedSeconds: ExpectedParam,
});

const NoParams = Type.Object({});
const JobStopParams = Type.Object({ id: Type.String({ description: "Job id to stop" }) });
const JobServiceParams = Type.Object({
	id: Type.String({ description: "Job id of the running command that is really a service" }),
});

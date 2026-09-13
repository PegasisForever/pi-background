import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getAgentDir,
	truncateTail,
} from "@earendil-works/pi-coding-agent";

export type JobKind = "command" | "agent";
export type JobStatus = "running" | "done" | "failed" | "stopped";

export interface Job {
	id: string;
	kind: JobKind;
	title: string;
	cwd: string;
	dir: string;
	expectedSeconds: number | null;
	status: JobStatus;
	exitCode?: number | null;
	reason?: string;
	startedAt: number;
	endedAt?: number;
	sandboxId?: string;
	ssh?: string;
	sessionOf: string;
	stop: AbortController;
	outputFd: number;
	settled: Promise<void>;
	/** The model is waiting on this command's result, so it needs no message when it ends. */
	foreground: boolean;
	/** Fires at every multiple of expectedSeconds while the job is still running. */
	overrun?: NodeJS.Timeout;
	overrunAt?: number;
}

/** A job that overruns by a second must not report every second. */
const QUIET_MS = 5 * 60 * 1000;

/** A command you expect to be shorter than this runs while the model waits. */
export const FOREGROUND_MAX_SECONDS = 180;

/**
 * How much of a command's output the model is shown is Pi's decision, not ours (C5): the same
 * `DEFAULT_MAX_LINES` and `DEFAULT_MAX_BYTES` its own bash tool cuts at, imported rather than
 * copied, so ours follows if Pi changes them.
 */

/** What you see in the terminal: a glance, not the output. Pi shows five lines of its own. */
const SHOWN_LINES = 5;
const SHOWN_BYTES = 1000;

/**
 * Only the end of the file is read: a build log is large. One byte wider than Pi's byte limit, and
 * the `+ 1` is the whole point — it is what makes the limit, and never the read, the thing that
 * cuts. Two consequences hang on it. A window that exceeds the limit is always reported as
 * truncated, so `truncated` is true of the whole file and not merely of the window; and the
 * fragment of a line the window opens on can never be reached by a cut that takes whole lines from
 * the end, so it is always dropped rather than shown. Neither wants slack. Wider is only a longer
 * read.
 */
const TAIL_WINDOW = DEFAULT_MAX_BYTES + 1;

export interface Outcome {
	status: Exclude<JobStatus, "running">;
	exitCode?: number | null;
	reason?: string;
}

/** The extension's own name: the tag on every injected message, and the name in every path. */
export const NAME = "pi-background";

const JOBS_ROOT = join(getAgentDir(), "jobs");

const jobs = new Map<string, Job>();
let api: ExtensionAPI;
let onChange: () => void;
let shuttingDown = false;

export function init(pi: ExtensionAPI, activityRefresh: () => void): void {
	api = pi;
	onChange = activityRefresh;
	// pi caches the extension module across /new, /resume and /fork, so this is not fresh.
	shuttingDown = false;
}

const list = (): Job[] => [...jobs.values()];
export const get = (id: string): Job | undefined => jobs.get(id);
/**
 * Every job a reader is told about: the footer, `/jobs` and `job_list` all draw from this one list,
 * so no listing can be given a different rule by accident.
 *
 * A command the model is still waiting for is left out. It is running, but every reader already
 * knows about it — the model is holding the call, and you are watching the tool call it came from —
 * and a command that takes a second would otherwise put a count in your footer for that second and
 * take it away again. `detach` clears the flag, so a command appears at the moment it outlives the
 * wait, which is the moment it becomes news.
 */
export const backgrounded = (): Job[] => list().filter((j) => j.status === "running" && !j.foreground);
/** A service is not waited on, so it must not hold the session busy or silence a nudge. */
export const activeCount = (): number => backgrounded().filter((j) => j.expectedSeconds !== null).length;

const outputPath = (job: Job): string => join(job.dir, "output");
const resultPath = (job: Job): string => join(job.dir, "result");

export interface StartOptions {
	kind: JobKind;
	title: string;
	cwd: string;
	expectedSeconds: number | null;
	sandboxId?: string;
	ssh?: string;
	sessionOf?: string;
	/** The caller waits for this command in front of the model. Only `bash` does. */
	foreground?: boolean;
}

/** Creates the job and its runner together, so a job can never exist untracked. */
export function start(options: StartOptions, run: (job: Job) => Promise<Outcome>): Job {
	const id = uuidv7();
	const dir = join(JOBS_ROOT, id);
	mkdirSync(dir, { recursive: true });
	const stop = new AbortController();
	const { promise, resolve } = Promise.withResolvers<void>();
	const job: Job = {
		id,
		kind: options.kind,
		title: options.title,
		cwd: options.cwd,
		dir,
		expectedSeconds: options.expectedSeconds,
		status: "running",
		startedAt: Date.now(),
		sandboxId: options.sandboxId,
		ssh: options.ssh,
		sessionOf: options.sessionOf ?? id,
		// Nothing but job_stop ends a job early, so the abort controller is the whole story.
		stop,
		outputFd: openSync(join(dir, "output"), "a"),
		settled: promise,
		foreground: options.foreground ?? false,
	};
	jobs.set(id, job);
	// A foreground job's clock starts when the wait ends, because that report is the first overrun.
	if (options.expectedSeconds !== null && !job.foreground) {
		job.overrun = setInterval(() => reportOverrun(job), options.expectedSeconds * 1000);
	}

	void (async () => {
		onChange();
		let outcome: Outcome;
		try {
			outcome = await run(job);
		} catch (err) {
			outcome = { status: "failed", reason: text(err) };
		}
		try {
			finalise(job, abortOutcome(job) ?? outcome);
		} finally {
			resolve();
		}
	})();

	return job;
}

export type Wait = "ended" | "overran" | "detached";

/**
 * The foreground wait: the command ends, the estimate passes, or the human stops waiting.
 * pi's signal means "stop waiting", never "stop the command" — only job_stop does that.
 */
export function waitInForeground(job: Job, seconds: number, signal?: AbortSignal): Promise<Wait> {
	if (signal?.aborted) return Promise.resolve("detached");
	const { promise, resolve } = Promise.withResolvers<Wait>();
	const timer = setTimeout(() => resolve("overran"), seconds * 1000);
	const detached = () => resolve("detached");
	signal?.addEventListener("abort", detached);
	void job.settled.then(() => resolve("ended"));
	return promise.finally(() => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", detached);
	});
}

/** The wait is over and the command is still running: it carries on without a waiter. */
export function detach(job: Job, seconds: number, overran: boolean): void {
	job.foreground = false;
	// An overrun was just reported to the model, so the five-minute floor starts from here.
	if (overran) job.overrunAt = Date.now();
	job.overrun = setInterval(() => reportOverrun(job), seconds * 1000);
}

/** An abort outranks whatever the runner reported, which is some flavour of "killed". */
const abortOutcome = (job: Job): Outcome | undefined =>
	job.stop.signal.aborted ? { status: "stopped" } : undefined;

/** The job keeps running: this tells the model it has overrun and lets it decide. */
function reportOverrun(job: Job): void {
	const now = Date.now();
	if (shuttingDown || job.status !== "running") return;
	if (job.overrunAt !== undefined && now - job.overrunAt < QUIET_MS) return;
	job.overrunAt = now;
	send(overrun(job), overrunForYou(job));
}

export const write = (job: Job, chunk: Buffer | string): void => appendFileSync(job.outputFd, chunk);

function finalise(job: Job, outcome: Outcome): void {
	job.status = outcome.status;
	job.exitCode = outcome.exitCode;
	job.reason = outcome.reason;
	job.endedAt = Date.now();
	closeSync(job.outputFd);
	clearInterval(job.overrun);
	if (shuttingDown) return;
	onChange();
	// The model already has the answer: job_stop returned it, or a foreground wait did.
	if (job.status === "stopped" || job.foreground) return;
	send(notification(job), notificationForYou(job));
}

const send = (content: string, lines: string[]): void => {
	api.sendMessage(
		{ customType: NAME, content, details: { lines }, display: true },
		{ deliverAs: "followUp", triggerTurn: true },
	);
};

export async function stop(job: Job): Promise<void> {
	if (job.status !== "running") return;
	job.stop.abort();
	await job.settled;
}

export async function shutdown(): Promise<void> {
	shuttingDown = true;
	const live = backgrounded();
	for (const job of live) job.stop.abort();
	await Promise.all(live.map((j) => j.settled));
	jobs.clear();
}

export function elapsed(job: Job): string {
	const s = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export const expectedText = (job: Job): string =>
	job.expectedSeconds === null ? "none" : `${job.expectedSeconds}s`;

const OUTCOME: Record<Exclude<JobStatus, "running">, string> = {
	done: "finished",
	failed: "failed",
	stopped: "stopped",
};

const noun = (job: Job): string => (job.kind === "command" ? "Command" : "Agent");

/** The result of a background start: a service, a long command, or an agent. */
export function started(job: Job): string {
	const lines = [
		job.expectedSeconds === null
			? `${noun(job)} ${job.title} is started in the background. You will be notified if it stops.`
			: `${noun(job)} ${job.title} is started in the background. You will be notified when it finishes, and again if it is still running after ${job.expectedSeconds}s.`,
		`Its job id is ${job.id}.`,
	];
	if (job.kind === "command") lines.push(`Its output is collected at ${outputPath(job)}.`);
	if (job.sandboxId) lines.push(`It is running in sandbox ${job.sandboxId}.`);
	return lines.join("\n");
}

/** The result of a command that ended while the model waited. It sends no message afterwards. */
export function finished(job: Job): string {
	const lines = [
		tail(job) || "(no output)",
		"",
		`The command exited with code ${job.exitCode ?? "none"} after ${elapsed(job)}.`,
	];
	if (job.reason) lines.push(`It ended because ${job.reason}.`);
	return lines.join("\n");
}

/** The result of a command the model stopped waiting for. It keeps running. */
export function handedOff(job: Job, overran: boolean): string {
	const body = tail(job);
	const lines = body ? [body, ""] : [];
	lines.push(
		overran
			? `Command ${job.title} is still running after ${elapsed(job)}, longer than the ${job.expectedSeconds}s you expected.`
			: `Command ${job.title} is still running after ${elapsed(job)}; you stopped waiting for it.`,
		"It has not been stopped and is now in the background.",
		`Its job id is ${job.id}.`,
		`Its whole output is collected at ${outputPath(job)}.`,
		"You will be notified when it ends.",
	);
	return lines.join("\n");
}

/** The result of job_list: running jobs only, grouped by kind. */
export function listing(): string {
	const live = backgrounded();
	if (live.length === 0) return "No jobs are running.";
	const groups: string[] = [];
	for (const [kind, label] of [
		["command", "background command"],
		["agent", "agent"],
	] as const) {
		const of = live.filter((j) => j.kind === kind);
		if (of.length === 0) continue;
		const header =
			of.length > 1 ? `${of.length} ${label}s are in progress:` : `One ${label} is in progress:`;
		groups.push([header, ...of.map(entry)].join("\n\n"));
	}
	return groups.join("\n\n");
}

function entry(job: Job): string {
	const lines = [
		job.expectedSeconds === null
			? `${noun(job)} ${job.title} has been running for ${elapsed(job)}, with no estimate.`
			: `${noun(job)} ${job.title} has been running for ${elapsed(job)}, against the ${job.expectedSeconds}s you expected.`,
		`Its job id is ${job.id}.`,
	];
	if (job.kind === "command") lines.push(`Its output is collected at ${outputPath(job)}.`);
	if (job.sandboxId) lines.push(`It is running in sandbox ${job.sandboxId}.`);
	return lines.join("\n");
}

/** The result of job_stop. */
export function stopped(job: Job, wasRunning: boolean): string {
	const lines = [
		wasRunning
			? `Job ${job.title} is stopped after ${elapsed(job)}.`
			: `Job ${job.title} had already ${OUTCOME[job.status as Exclude<JobStatus, "running">]} after ${elapsed(job)}.`,
	];
	lines.push(
		job.kind === "command"
			? `Its output is at ${outputPath(job)}.`
			: `Its response is at ${resultPath(job)}.`,
	);
	return lines.join("\n");
}

/** The message a finished job sends to the model. */
export function notification(job: Job): string {
	const status = job.status as Exclude<JobStatus, "running">;
	const lines = [
		job.kind === "command"
			? `Background command ${job.title} ${OUTCOME[status]} after ${elapsed(job)}, with exit code ${job.exitCode ?? "none"}.`
			: `Agent ${job.title} ${OUTCOME[status]} after ${elapsed(job)}.`,
	];
	if (job.reason) lines.push(`It ended because ${job.reason}.`);
	lines.push(`Its job id is ${job.id}.`);
	if (job.kind === "command") {
		lines.push("", "Its output:", "", tail(job) || "(no output)", "");
	} else if (size(resultPath(job)) > 0) {
		lines.push("", `Read the agent's response at ${resultPath(job)}.`);
	}
	return `<${NAME}>\n${lines.join("\n")}\n</${NAME}>`;
}

/** Sent at each multiple of expectedSeconds while the job is still going. */
export function overrun(job: Job): string {
	return [
		`<${NAME}>`,
		`${noun(job)} ${job.title} is still running after ${elapsed(job)}, longer than the ${job.expectedSeconds}s you expected.`,
		"It has not been stopped. Leave it running, or stop it with job_stop.",
		`Its job id is ${job.id}.`,
		`</${NAME}>`,
	].join("\n");
}

/**
 * The end of the output for you, as display lines, with a blank line before whatever follows it.
 * Shorter than the model's half and cut on its own: the model is reading the output and you are
 * glancing at it, and 2000 lines of a build log in your scrollback is not a glance. A command that
 * printed nothing shows nothing: the absence is the answer.
 */
const shownTail = (job: Job): string[] => {
	const body = truncateTail(readTail(outputPath(job), TAIL_WINDOW), {
		maxLines: SHOWN_LINES,
		maxBytes: SHOWN_BYTES,
	}).content.trim();
	return body ? [...body.split("\n"), ""] : [];
};

/** A foreground command that ended, for a person. */
export const finishedForYou = (job: Job): string[] => [
	...shownTail(job),
	`Finished in ${elapsed(job)}.`,
	`Exit code: ${job.exitCode ?? "none"}`,
];

/** A foreground command that outlived the wait, for a person. */
export const handedOffForYou = (job: Job, overran: boolean): string[] => [
	...shownTail(job),
	overran
		? `Still running after ${elapsed(job)}, expected ${job.expectedSeconds}s.`
		: `Still running after ${elapsed(job)}; you stopped waiting.`,
	"Now in the background.",
];

/** The same, for a person. */
export const overrunForYou = (job: Job): string[] => [
	`${noun(job)} ${job.title} still running after ${elapsed(job)}, expected ${job.expectedSeconds}s.`,
];

/** The same completion, for a person: no id, no paths. */
export function notificationForYou(job: Job): string[] {
	const status = job.status as Exclude<JobStatus, "running">;
	// An agent's output is pi's JSON event stream, which is no more readable to you than to it.
	const lines = job.kind === "command" ? shownTail(job) : [];
	lines.push(
		job.kind === "command"
			? `Background command ${job.title} ${OUTCOME[status]} in ${elapsed(job)}.`
			: `Agent ${job.title} ${OUTCOME[status]} in ${elapsed(job)}.`,
	);
	if (job.kind === "command") lines.push(`Exit code: ${job.exitCode ?? "none"}`);
	if (job.reason) lines.push(`Exit reason: ${job.reason}`);
	return lines;
}

const HEADINGS = ["job id", "type", "title", "elapsed", "expected"];
/** The last two columns hold durations, which read wrong ragged. */
const RIGHT = [false, false, false, true, true];

/**
 * Every running job as a table, for a person reading /jobs or watching job_list.
 * The first row is the heading; an empty table is one line and no heading.
 */
export function table(): string[] {
	const live = backgrounded();
	if (live.length === 0) return ["No background jobs."];
	const cells = live.map((j) => [j.id, j.kind, j.title, elapsed(j), expectedText(j)]);
	const width = HEADINGS.map((h, i) =>
		Math.max(h.length, ...cells.map((row) => (row[i] as string).length)),
	);
	const line = (row: string[]): string =>
		row
			.map((cell, i) =>
				RIGHT[i] ? cell.padStart(width[i] as number) : cell.padEnd(width[i] as number),
			)
			.join("  ")
			.trimEnd();
	return [line(HEADINGS), ...cells.map(line)];
}

/**
 * The end of a command's output for the model, cut where Pi cuts its own, and followed by a line
 * naming what was lost and where the rest is — but only when something was lost and the job is
 * over. A path beside output the model already holds in full is a sentence it pays for and can only
 * waste a read on (C8); a path on a job that is still running is its caller's sentence to write,
 * in the present tense, because more output is coming whatever this cut did.
 *
 * `status` is the same field `index.ts` branches on to choose between `finished` and `handedOff`,
 * so the two cannot disagree and nothing has to be passed in to say which case this is.
 */
export function tail(job: Job): string {
	const path = outputPath(job);
	const cut = truncateTail(readTail(path, TAIL_WINDOW), {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	const text = cut.content.trim();
	if (!cut.truncated || job.status === "running") return text;
	// Bytes, where Pi says lines: it counts the lines of the whole output because it held the whole
	// output in hand. Ours is on disk and only its end was read, so the honest number is the one
	// `statSync` has already given us (C5, C7).
	return `${text}\n\nThis is the last ${formatSize(cut.outputBytes)} of ${formatSize(size(path))}. The whole output is at ${path}.`;
}

/** The end of a file, without reading the whole of it: a build log is large. */
export function readTail(path: string, maxBytes: number): string {
	const total = size(path);
	const from = Math.max(0, total - maxBytes);
	const length = total - from;
	if (length === 0) return "";
	const buffer = Buffer.alloc(length);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buffer, 0, length, from);
	} finally {
		closeSync(fd);
	}
	return buffer.toString("utf8");
}

const size = (path: string): number => {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
};

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err));

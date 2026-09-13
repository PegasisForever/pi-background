import { appendFileSync, closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
	signal: AbortSignal;
	outputFd: number;
	settled: Promise<void>;
	/** Fires at every multiple of expectedSeconds while the job is still running. */
	overrun?: NodeJS.Timeout;
	overrunAt?: number;
}

/** A job that overruns by a second must not report every second. */
const QUIET_MS = 5 * 60 * 1000;

export interface Outcome {
	status: Exclude<JobStatus, "running">;
	exitCode?: number | null;
	reason?: string;
}

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

export const list = (): Job[] => [...jobs.values()];
export const get = (id: string): Job | undefined => jobs.get(id);
export const running = (): Job[] => list().filter((j) => j.status === "running");
/** A service is not waited on, so it must not hold the session busy or silence a nudge. */
export const activeCount = (): number =>
	running().filter((j) => j.expectedSeconds !== null).length;

export const outputPath = (job: Job): string => join(job.dir, "output");
export const resultPath = (job: Job): string => join(job.dir, "result");

export interface StartOptions {
	kind: JobKind;
	title: string;
	cwd: string;
	expectedSeconds: number | null;
	sandboxId?: string;
	ssh?: string;
	sessionOf?: string;
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
		stop,
		// Nothing but job_stop ends a job early, so the abort controller is the whole story.
		signal: stop.signal,
		outputFd: openSync(join(dir, "output"), "a"),
		settled: promise,
	};
	jobs.set(id, job);
	if (options.expectedSeconds !== null) {
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
	// A stopped job was stopped by the model, which already has job_stop's answer.
	if (job.status === "stopped") return;
	send(notification(job), notificationForYou(job));
}

const send = (content: string, lines: string[]): void => {
	api.sendMessage(
		{ customType: "pi-background", content, details: { lines }, display: true },
		{ deliverAs: "followUp", triggerTurn: true },
	);
};

export async function stop(id: string): Promise<Job | undefined> {
	const job = jobs.get(id);
	if (job?.status === "running") {
		job.stop.abort();
		await job.settled;
	}
	return job;
}

export async function shutdown(): Promise<void> {
	shuttingDown = true;
	const live = running();
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

/** The result of run_command, run_agent and resume_agent. */
export function started(job: Job): string {
	const lines = [
		job.expectedSeconds === null
			? `${noun(job)} ${job.title} is started in the background. You will be notified if it stops.`
			: `${noun(job)} ${job.title} is started in the background, you will be notified when it finishes, and again if it is still running after ${job.expectedSeconds}s.`,
		`job id: ${job.id}`,
	];
	if (job.kind === "command") lines.push(`The command output is piped to: ${outputPath(job)}`);
	if (job.sandboxId) lines.push(`sandbox: ${job.sandboxId}`);
	return lines.join("\n");
}

/** The result of job_list: running jobs only, grouped by kind. */
export function listing(): string {
	const live = running();
	if (live.length === 0) return "no jobs running";
	const groups: string[] = [];
	for (const [kind, label] of [
		["command", "background command"],
		["agent", "agent"],
	] as const) {
		const of = live.filter((j) => j.kind === kind);
		if (of.length === 0) continue;
		const header = `${of.length} in progress ${label}${of.length > 1 ? "s" : ""}:`;
		groups.push([header, ...of.map(entry)].join("\n\n"));
	}
	return groups.join("\n\n");
}

function entry(job: Job): string {
	const lines = [job.id, `title: ${job.title}`];
	if (job.kind === "command") lines.push(`output path: ${outputPath(job)}`);
	if (job.sandboxId) lines.push(`sandbox: ${job.sandboxId}`);
	lines.push(`elapsed: ${elapsed(job)}`, `expected: ${expectedText(job)}`);
	return lines.join("\n");
}

/** The result of job_stop. */
export function stopped(job: Job, wasRunning: boolean): string {
	const lines = [
		wasRunning
			? `Job ${job.title} is stopped.`
			: `Job ${job.title} had already ended: ${OUTCOME[job.status as Exclude<JobStatus, "running">]}.`,
		`elapsed: ${elapsed(job)}`,
	];
	lines.push(
		job.kind === "command"
			? `output path: ${outputPath(job)}`
			: `response path: ${resultPath(job)}`,
	);
	return lines.join("\n");
}

/** The message a finished job sends to the model. */
export function notification(job: Job): string {
	const status = job.status as Exclude<JobStatus, "running">;
	const lines = [
		job.kind === "command"
			? `Background command ${job.title} ${OUTCOME[status]}.`
			: `Agent ${job.title} ${OUTCOME[status]}.`,
		`job id: ${job.id}`,
		`elapsed: ${elapsed(job)}`,
	];
	if (job.kind === "command") lines.push(`exit code: ${job.exitCode ?? "none"}`);
	if (job.reason) lines.push(`exit reason: ${job.reason}`);
	if (job.kind === "command") {
		lines.push(`read the command output at: ${outputPath(job)}`);
	} else if (size(resultPath(job)) > 0) {
		lines.push("", `read the agent response at: ${resultPath(job)}`);
	}
	return `<pi-background>\n${lines.join("\n")}\n</pi-background>`;
}

/** Sent at each multiple of expectedSeconds while the job is still going. */
export function overrun(job: Job): string {
	return [
		"<pi-background>",
		`${noun(job)} ${job.title} is still running after ${elapsed(job)}, longer than the ${job.expectedSeconds}s you expected.`,
		`job id: ${job.id}`,
		"It has not been stopped. Leave it running, or stop it with job_stop.",
		"</pi-background>",
	].join("\n");
}

/** The same, for a person. */
export const overrunForYou = (job: Job): string[] => [
	`${noun(job)} ${job.title} still running after ${elapsed(job)}, expected ${job.expectedSeconds}s.`,
];

/** The same completion, for a person: no id, no paths. */
export function notificationForYou(job: Job): string[] {
	const status = job.status as Exclude<JobStatus, "running">;
	const lines = [
		job.kind === "command"
			? `Background command ${job.title} ${OUTCOME[status]} in ${elapsed(job)}.`
			: `Agent ${job.title} ${OUTCOME[status]} in ${elapsed(job)}.`,
	];
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
	const live = running();
	if (live.length === 0) return ["No jobs running."];
	const cells = live.map((j) => [
		j.id,
		j.kind === "command" ? "command" : "agent",
		j.title,
		elapsed(j),
		expectedText(j),
	]);
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

const size = (path: string): number => {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
};

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err));

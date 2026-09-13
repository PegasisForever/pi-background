import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type JobKind = "command" | "agent";
export type JobStatus = "running" | "done" | "failed";

export interface Job {
	id: string;
	kind: JobKind;
	label: string;
	cwd: string;
	dir: string;
	timeoutSeconds: number | null;
	status: JobStatus;
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
}

export interface Outcome {
	status: Exclude<JobStatus, "running">;
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
const isAwaited = (job: Job): boolean => job.timeoutSeconds !== null;
export const running = (): Job[] => list().filter((j) => j.status === "running");
export const activeCount = (): number =>
	list().filter((j) => j.status === "running" && isAwaited(j)).length;

export interface StartOptions {
	kind: JobKind;
	label: string;
	cwd: string;
	timeoutSeconds: number | null;
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
		label: options.label,
		cwd: options.cwd,
		dir,
		timeoutSeconds: options.timeoutSeconds,
		status: "running",
		startedAt: Date.now(),
		sandboxId: options.sandboxId,
		ssh: options.ssh,
		sessionOf: options.sessionOf ?? id,
		stop,
		signal:
			options.timeoutSeconds === null
				? stop.signal
				: AbortSignal.any([stop.signal, AbortSignal.timeout(options.timeoutSeconds * 1000)]),
		outputFd: openSync(join(dir, "output"), "a"),
		settled: promise,
	};
	jobs.set(id, job);

	void (async () => {
		onChange();
		let outcome: Outcome;
		try {
			outcome = await run(job);
		} catch (err) {
			const detail = text(err);
			const why = job.stop.signal.aborted ? "stopped" : "timeout";
			// Keep the error only when it says more than "the abort we asked for".
			outcome = job.signal.aborted
				? { status: "failed", reason: detail === "aborted" ? why : `${why} (${detail})` }
				: { status: "failed", reason: detail };
		}
		try {
			finalise(job, outcome);
		} finally {
			resolve();
		}
	})();

	return job;
}

export const write = (job: Job, chunk: Buffer | string): void => appendFileSync(job.outputFd, chunk);

function finalise(job: Job, outcome: Outcome): void {
	job.status = outcome.status;
	job.reason = outcome.reason;
	job.endedAt = Date.now();
	closeSync(job.outputFd);
	if (shuttingDown) return;
	onChange();
	if (isAwaited(job)) {
		api.sendMessage(
			{ customType: "pi-jobs", content: `<pi-jobs>\n${describe(job)}\n</pi-jobs>`, display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}
}

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
	const running = list().filter((j) => j.status === "running");
	for (const job of running) job.stop.abort();
	await Promise.all(running.map((j) => j.settled));
	jobs.clear();
}

export function elapsed(job: Job): string {
	const s = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** One line per job, for a person reading /jobs. No id: they are not the one calling job_stop. */
export const summarise = (job: Job): string =>
	`${(job.kind === "command" ? "cmd" : "agent").padEnd(5)} ${elapsed(job).padStart(6)}  ${job.label}` +
	(job.sandboxId ? `  · ${job.sandboxId}` : "");

export function describe(job: Job): string {
	const outcome =
		job.status === "running" ? "running" : `${job.status}${job.reason ? `: ${job.reason}` : ""}`;
	const sandbox = job.sandboxId ? `\nsandbox: ${job.sandboxId}` : "";
	const result = job.kind === "agent" ? `\nresult: ${join(job.dir, "result")}` : "";
	return `${job.id}  [${outcome}]  ${elapsed(job)}\nran: ${job.label}\noutput: ${join(job.dir, "output")}${result}${sandbox}`;
}

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err));

import { spawn } from "node:child_process";
import { closeSync, createWriteStream, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type Job, type Outcome, write } from "./jobs.ts";

export interface Sandbox {
	id: string;
	ssh: string;
	cwd: string;
}

/** The sandbox already exists by now, so a malformed reply must not lose its id. */
export function parseSandbox(stdout: string): Sandbox {
	const s = JSON.parse(stdout.trim()) as Partial<Sandbox>;
	if (!s.id || !s.ssh || !s.cwd) {
		throw new Error(`isolated.create must print {id, ssh, cwd}: ${stdout.trim()}`);
	}
	if (s.ssh.split(/\s+/)[0] !== "ssh") throw new Error(`isolated.create ssh must start with ssh: ${s.ssh}`);
	return s as Sandbox;
}

export interface AgentRun {
	task: string;
	cwd: string;
	depthRemaining: number;
	sessionDir: string;
	sessionId: string;
	ssh?: string;
}

export function runAgent(job: Job, run: AgentRun): Promise<Outcome> {
	const piArgs = [
		"--mode",
		"json",
		`--jobs-depth=${run.depthRemaining - 1}`,
		"--session-dir",
		run.sessionDir,
		"--session-id",
		run.sessionId,
	];
	const remote = `cd ${quote(run.cwd)} && pi ${piArgs.map(quote).join(" ")}`;
	const [cmd, args] = run.ssh
		? ["ssh", [...run.ssh.split(/\s+/).slice(1), remote]]
		: [process.execPath, [process.argv[1] as string, ...piArgs]];

	return new Promise<Outcome>((resolve) => {
		const child = spawn(cmd as string, args as string[], {
			cwd: run.ssh ? undefined : run.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			signal: job.signal,
		});
		let failure: string | undefined;
		child.stdout.on("data", (chunk: Buffer) => write(job, chunk));
		child.stderr.pipe(createWriteStream(join(job.dir, "stderr")));
		child.stdin.on("error", (err) => (failure ??= err.message));
		child.on("error", (err) => (failure = err.message));
		// 'close' always fires, including after 'error', so it is the only settle point.
		child.on("close", (code, signal) =>
			resolve(
				code === 0 && !failure
					? { status: "done" }
					: { status: "failed", reason: failure ?? (signal ? `killed by ${signal}` : `exit ${code}`) },
			),
		);
		child.stdin.end(run.task);
	}).then((outcome) => {
		// A failed run may legitimately have produced no message; a successful one may not.
		writeFileSync(join(job.dir, "result"), finalText(job, outcome.status === "done"));
		return outcome;
	});
}

/** Enough to hold any final assistant message; a larger one is a loud failure, not a silent loss. */
const TAIL_BYTES = 4 * 1024 * 1024;

function finalText(job: Job, required: boolean): string {
	const path = join(job.dir, "output");
	const size = statSync(path).size;
	const start = Math.max(0, size - TAIL_BYTES);
	const buf = Buffer.alloc(size - start);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buf, 0, buf.length, start);
	} finally {
		closeSync(fd);
	}

	const lines = buf.toString("utf8").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] as string;
		if (line === "" || !line.startsWith("{")) continue;
		let event: JsonAgentSessionEvent;
		try {
			event = JSON.parse(line) as JsonAgentSessionEvent;
		} catch {
			if (i === 0 && start > 0) break; // the window cut this line in half
			throw new Error(`unparsable event in ${path} line ${i}`);
		}
		if (event.type !== "message_end" || event.message.role !== "assistant") continue;
		return event.message.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
	}
	if (required) throw new Error(`no assistant message in the last ${TAIL_BYTES} bytes of ${path}`);
	return "";
}

const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AssistantMessage } from "@earendil-works/pi-ai";
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
	/** The parent's model, when the session has one: the child runs on the same one. */
	model?: { provider: string; id: string };
	/** The parent's thinking level, a pi `--thinking` value such as "high". */
	thinking?: string;
}

export function runAgent(job: Job, run: AgentRun): Promise<Outcome> {
	const piArgs = childArgs(run);
	const remote = `cd ${quote(run.cwd)} && pi ${piArgs.map(quote).join(" ")}`;
	const [cmd, args] = run.ssh
		? ["ssh", [...run.ssh.split(/\s+/).slice(1), remote]]
		: [process.execPath, [process.argv[1] as string, ...piArgs]];

	const events = readEvents(job);
	return new Promise<Outcome>((resolve) => {
		const child = spawn(cmd as string, args as string[], {
			cwd: run.ssh ? undefined : run.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			signal: job.stop.signal,
		});
		let failure: string | undefined;
		child.stdout.on("data", (chunk: Buffer) => {
			write(job, chunk);
			events.push(chunk);
		});
		child.stderr.pipe(createWriteStream(join(job.dir, "stderr")));
		child.stdin.on("error", (err) => (failure ??= err.message));
		child.on("error", (err) => (failure = err.message));
		// 'close' fires after 'error' too, and only once stdout has drained, which is what
		// the last reply needs. It is not guaranteed: a surviving descendant holding the inherited
		// pipes keeps it from firing even after the child is gone (§12.10 of DESIGN.md).
		child.on("close", (code, signal) =>
			resolve(
				code === 0 && !failure
					? { status: "done", exitCode: code }
					: {
							status: "failed",
							exitCode: code,
							reason: failure ?? (signal ? `killed by ${signal}` : `exit ${code}`),
						},
			),
		);
		child.stdin.end(run.task);
	}).then((outcome) => {
		const ended = events.end(outcome);
		writeFileSync(join(job.dir, "result"), ended.text);
		return ended.outcome;
	});
}

/**
 * The child's arguments: everything about the run except the task, which goes to its stdin. With no
 * model the child picks its own default, as any fresh pi run does.
 */
export function childArgs(run: AgentRun): string[] {
	const args = [
		"--mode",
		"json",
		`--jobs-depth=${run.depthRemaining - 1}`,
		"--session-dir",
		run.sessionDir,
		"--session-id",
		run.sessionId,
	];
	if (run.model) {
		args.push("--provider", run.model.provider, "--model", run.model.id);
	}
	if (run.thinking) {
		args.push("--thinking", run.thinking);
	}
	return args;
}

/**
 * The child's stdout, read as it arrives: one pi JSON event per line (§3.4). Two things are kept
 * from it — the last assistant reply, which is the answer, and the latest tool call, which the
 * overrun message reports (§6.2). Reading at the end instead is what lost answers: pi's last line,
 * `agent_end`, repeats the whole conversation, and a long child's is larger than any tail window.
 */
export function readEvents(job: Job): {
	push: (chunk: Buffer) => void;
	end: (outcome: Outcome) => { outcome: Outcome; text: string };
} {
	const path = join(job.dir, "output");
	const decoder = new StringDecoder("utf8");
	let partial = "";
	let line = 0;
	let reply: AssistantMessage | undefined;
	let unparsable: string | undefined;

	const read = (raw: string): void => {
		line++;
		if (raw === "" || !raw.startsWith("{")) return;
		let event: JsonAgentSessionEvent;
		try {
			event = JSON.parse(raw) as JsonAgentSessionEvent;
		} catch {
			unparsable ??= `unparsable event in ${path} line ${line}`;
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") reply = event.message;
		if (event.type === "tool_execution_start") {
			job.toolCall = {
				id: event.toolCallId,
				name: event.toolName,
				args: event.args,
				startedAt: Date.now(),
			};
		}
		if (event.type === "tool_execution_end" && job.toolCall?.id === event.toolCallId) {
			job.toolCall.endedAt = Date.now();
		}
	};

	return {
		push(chunk) {
			const lines = (partial + decoder.write(chunk)).split("\n");
			partial = lines.pop() as string;
			for (const raw of lines) read(raw);
		},
		end(outcome) {
			read(partial + decoder.end());
			const text = (reply?.content ?? [])
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			// A child that failed may legitimately have produced no reply; one that exited 0 may not.
			// pi exits 0 after a provider error too, so its last reply decides, not its exit code.
			if (outcome.status !== "done") return { outcome, text };
			const failed = (reason: string) => ({
				outcome: { ...outcome, status: "failed" as const, reason },
				text,
			});
			if (unparsable) return failed(unparsable);
			if (!reply) return failed(`no assistant message in ${path}`);
			if (reply.stopReason === "error")
				return failed(`its last reply was an error: ${reply.errorMessage}`);
			if (text === "") return failed("its last reply has no text");
			return { outcome, text };
		},
	};
}

const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

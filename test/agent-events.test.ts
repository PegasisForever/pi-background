import assert from "node:assert/strict";
import { test } from "node:test";
import { readEvents } from "../src/agent-job.ts";
import { type Job, overrun } from "../src/jobs.ts";

const agentJob = (): Job =>
	({
		id: "01a00000-0000-7000-8000-000000000000",
		kind: "agent",
		title: "investigator",
		dir: "/jobs/x",
		expectedSeconds: 60,
		startedAt: Date.now() - 120_000,
	}) as Job;

const line = (event: object): Buffer => Buffer.from(`${JSON.stringify(event)}\n`);
const reply = (content: object[], stopReason = "stop", errorMessage?: string) =>
	line({ type: "message_end", message: { role: "assistant", content, stopReason, errorMessage } });
const done = { status: "done" as const, exitCode: 0 };

test("the answer is found when the final agent_end line is larger than any tail window", () => {
	const events = readEvents(agentJob());
	events.push(reply([{ type: "text", text: "the answer" }]));
	events.push(
		line({ type: "agent_end", messages: [{ role: "user", content: "x".repeat(5 * 1024 * 1024) }] }),
	);
	events.push(line({ type: "agent_settled" }));
	assert.deepEqual(events.end(done), { outcome: done, text: "the answer" });
});

test("a line and a character split across chunks are read whole", () => {
	const events = readEvents(agentJob());
	const bytes = reply([{ type: "text", text: "café" }]);
	const cut = bytes.indexOf(Buffer.from("é")) + 1;
	events.push(bytes.subarray(0, cut));
	events.push(bytes.subarray(cut));
	assert.equal(events.end(done).text, "café");
});

test("a child that exits 0 after a provider error has failed, with the provider's message", () => {
	const events = readEvents(agentJob());
	events.push(reply([{ type: "text", text: "partial" }]));
	events.push(reply([], "error", "429 Too Many Requests"));
	assert.deepEqual(events.end(done).outcome, {
		...done,
		status: "failed",
		reason: "its last reply was an error: 429 Too Many Requests",
	});
});

test("a child that exits 0 with an empty last reply has failed", () => {
	const events = readEvents(agentJob());
	events.push(reply([{ type: "thinking", thinking: "only thoughts" }]));
	assert.equal(events.end(done).outcome.reason, "its last reply has no text");
});

test("a child that exits 0 with no reply has failed", () => {
	const events = readEvents(agentJob());
	events.push(line({ type: "agent_start" }));
	assert.equal(events.end(done).outcome.reason, "no assistant message in /jobs/x/output");
});

test("an unparsable event fails the job and names its line", () => {
	const events = readEvents(agentJob());
	events.push(Buffer.from('{"type":"agent_start"}\n{"type":\n'));
	events.push(reply([{ type: "text", text: "answer" }]));
	assert.equal(events.end(done).outcome.reason, "unparsable event in /jobs/x/output line 2");
});

test("a child that failed keeps its own outcome, and whatever reply it had", () => {
	const events = readEvents(agentJob());
	events.push(reply([{ type: "text", text: "half" }]));
	const failed = { status: "failed" as const, exitCode: 1, reason: "exit 1" };
	assert.deepEqual(events.end(failed), { outcome: failed, text: "half" });
});

test("an overrun names the tool call the agent is in, then the last one it made", () => {
	const job = agentJob();
	const events = readEvents(job);
	assert.match(overrun(job), /It has not called a tool yet\./);
	events.push(
		line({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } }),
	);
	assert.match(
		overrun(job),
		/Its current tool call is bash \{"command":"ls"\}, started at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ and running for 0s\./,
	);
	events.push(
		line({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false }),
	);
	assert.match(
		overrun(job),
		/Its last tool call was bash \{"command":"ls"\}, started at .*Z; it ran for 0s and ended 0s ago\./,
	);
	assert.doesNotMatch(overrun(job), /job_service/);
});

test("an overrun cuts long tool arguments", () => {
	const job = agentJob();
	readEvents(job).push(
		line({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "write",
			args: { content: "y".repeat(10_000) },
		}),
	);
	assert.match(overrun(job), /y… \(cut, 9\.8KB in all\), started at/);
});

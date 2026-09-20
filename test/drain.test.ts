import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import factory from "../src/index.ts";

// The factory reads settings from process.cwd() at load, so run from an empty directory: no
// nudge model, no sandbox provider, nothing to reach the network.
process.chdir(mkdtempSync(join(tmpdir(), "pi-background-cwd-")));

interface Sent {
	message: { customType?: string; content?: unknown };
	options?: unknown;
}

interface StubPi {
	handlers: Map<string, Array<(event: object, ctx: ExtensionContext) => Promise<unknown>>>;
	tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
	sent: Sent[];
	userSent: Array<{ content: unknown; options: unknown }>;
	registerFlag: () => void;
	registerEntryRenderer: () => void;
	registerMessageRenderer: () => void;
	registerCommand: () => void;
	registerTool: (def: { name: string }) => void;
	on: (event: string, handler: (event: object, ctx: ExtensionContext) => Promise<unknown>) => void;
	getFlag: () => undefined;
	exec: () => Promise<never>;
	appendEntry: () => void;
	sendMessage: (message: Sent["message"], options?: unknown) => void;
	sendUserMessage: (content: unknown, options?: unknown) => void;
}

function makePi(): StubPi {
	const pi: StubPi = {
		handlers: new Map(),
		tools: new Map(),
		sent: [],
		userSent: [],
		registerFlag: () => {},
		registerEntryRenderer: () => {},
		registerMessageRenderer: () => {},
		registerCommand: () => {},
		registerTool: (def) => {
			pi.tools.set(def.name, def as unknown as { execute: (...args: unknown[]) => Promise<unknown> });
		},
		on: (event, handler) => {
			pi.handlers.set(event, [...(pi.handlers.get(event) ?? []), handler]);
		},
		getFlag: () => undefined,
		exec: () => Promise.reject(new Error("no exec in tests")),
		appendEntry: () => {},
		sendMessage: (message, options) => {
			pi.sent.push({ message, options });
		},
		sendUserMessage: (content, options) => {
			pi.userSent.push({ content, options });
		},
	};
	return pi;
}

function makeCtx(mode: "print" | "json" | "tui" | "rpc"): ExtensionContext {
	return {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: process.cwd(),
		ui: { setStatus: () => {}, notify: () => {} },
		sessionManager: { getSessionId: () => "test-session", getLeafEntry: () => undefined },
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
}

const pi = makePi();
factory(pi as never);

async function emit(name: string, ctx: ExtensionContext): Promise<void> {
	for (const handler of pi.handlers.get(name) ?? []) await handler({}, ctx);
}

async function bash(params: Record<string, unknown>): Promise<string> {
	const tool = pi.tools.get("bash");
	assert.ok(tool, "bash tool is registered");
	const result = (await tool.execute("t1", params, undefined, undefined, {
		cwd: process.cwd(),
	})) as { content: Array<{ text: string }> };
	return result.content[0]?.text ?? "";
}

function jobIdOf(text: string): string {
	const match = text.match(/job id is (\S+?)\./);
	assert.ok(match?.[1], `tool result names a job id:\n${text}`);
	return match[1] as string;
}

test("run_agent refuses when the session has no model to pass down", async () => {
	const tool = pi.tools.get("run_agent");
	assert.ok(tool, "run_agent tool is registered");
	// The stub context carries no model, which cannot happen in a live tool call — the guard is
	// the loud refusal C10 asks for, not a quiet start on some other model.
	await assert.rejects(
		tool.execute("t2", { task: "x", title: "probe", expectedSeconds: 60 }, undefined, undefined, {
			cwd: process.cwd(),
		}),
		/no model/,
	);
});

const outputOf = (id: string): string =>
	readFileSync(join(process.env.PI_CODING_AGENT_DIR as string, "jobs", id, "output"), "utf8");

test("headless drain waits for a background command and reports it", async () => {
	const ctx = makeCtx("print");
	await emit("session_start", ctx);
	const started = await bash({
		command: "sleep 1 && echo drained-ok",
		title: "drain probe",
		expectedSeconds: 300,
	});
	const id = jobIdOf(started);

	const before = Date.now();
	await emit("agent_settled", ctx);
	const elapsed = Date.now() - before;

	// The old behavior returned at once and shutdown aborted the job with no message.
	assert.ok(elapsed >= 800, `settled waited out the job (took ${elapsed}ms)`);
	assert.equal(pi.sent.length, 1, "one completion notification was sent");
	assert.deepEqual(
		pi.sent[0]?.options,
		{ deliverAs: "steer", triggerTurn: true },
		"completions are steering messages, not follow-ups",
	);
	const content = String(pi.sent[0]?.message.content ?? "");
	assert.match(content, /finished/, "notification reports the natural finish");
	assert.match(content, /drained-ok/, "notification carries the job's output");
	assert.match(outputOf(id), /drained-ok/, "full output is on disk");

	await emit("session_shutdown", ctx);
	pi.sent.length = 0;
});

test("interactive settled returns at once while a job keeps running", async () => {
	const ctx = makeCtx("tui");
	await emit("session_start", ctx);
	const started = await bash({
		command: "sleep 5 && echo slow",
		title: "slow probe",
		expectedSeconds: 300,
	});
	jobIdOf(started);

	const before = Date.now();
	await emit("agent_settled", ctx);
	const elapsed = Date.now() - before;

	assert.ok(elapsed < 2000, `settled did not drain in TUI (took ${elapsed}ms)`);
	assert.equal(pi.sent.length, 0, "no completion yet — the job is still running");

	await emit("session_shutdown", ctx);
	pi.sent.length = 0;
});

test("services are excluded from the drain and named loudly at shutdown", async () => {
	const ctx = makeCtx("print");
	await emit("session_start", ctx);
	const started = await bash({
		command: "sleep 30",
		title: "svc probe",
		expectedSeconds: null,
	});
	jobIdOf(started);

	const before = Date.now();
	await emit("agent_settled", ctx);
	assert.ok(Date.now() - before < 2000, "settled did not wait for the service");
	assert.equal(pi.sent.length, 0, "services never notify while running");

	const errors: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	};
	try {
		await emit("session_shutdown", ctx);
	} finally {
		console.error = original;
	}
	assert.ok(
		errors.some((line) => line.includes('Service "svc probe"')),
		`shutdown named the aborted service on stderr: ${JSON.stringify(errors)}`,
	);
	pi.sent.length = 0;
});

test("a follow-up queued while an awaited job runs is held until the job settles", async () => {
	const ctx = makeCtx("tui");
	await emit("session_start", ctx);
	await bash({ command: "sleep 1 && echo hold-done", title: "hold probe", expectedSeconds: 300 });

	const handler = pi.handlers.get("input")?.[0];
	assert.ok(handler, "input handler is registered");
	const result = await handler(
		{ text: "after the build", source: "interactive", streamingBehavior: "followUp" },
		ctx,
	);
	assert.deepEqual(result, { action: "handled" }, "the follow-up is claimed, not queued in pi");
	assert.equal(pi.userSent.length, 0, "nothing is sent while the job runs");

	// Print-mode settled drains the awaited job; the release rides the job-change callback.
	await emit("agent_settled", makeCtx("print"));
	assert.deepEqual(
		pi.userSent.map((m) => m.content),
		["after the build"],
	);
	assert.deepEqual(
		pi.userSent[0]?.options,
		{ expandPromptTemplates: true },
		"an idle release triggers the turn itself",
	);
	await emit("session_shutdown", ctx);
	pi.sent.length = 0;
	pi.userSent.length = 0;
});

test("a follow-up queued before the job starts is still held until the job settles", async () => {
	// The reported timeline: the follow-up is queued mid-turn, before the bash call has created
	// the job; the turn then settles while the job runs; the message must wait for the job.
	const ctx = makeCtx("tui");
	await emit("session_start", ctx);

	const handler = pi.handlers.get("input")?.[0];
	assert.ok(handler, "input handler is registered");
	const result = await handler(
		{ text: "after the build", source: "interactive", streamingBehavior: "followUp" },
		ctx,
	);
	assert.deepEqual(result, { action: "handled" }, "claimed even though no job runs yet");
	assert.equal(pi.userSent.length, 0);

	// Mid-turn: the job starts.
	await bash({ command: "sleep 1 && echo late-job", title: "late job", expectedSeconds: 300 });

	// The turn settles while the job runs.
	await emit("agent_settled", ctx);
	assert.equal(pi.userSent.length, 0, "still held while the job runs");

	// The job ends: print-mode settled drains it, the release rides the job-change callback.
	await emit("agent_settled", makeCtx("print"));
	assert.deepEqual(pi.userSent.map((m) => m.content), ["after the build"]);

	await emit("session_shutdown", ctx);
	pi.sent.length = 0;
	pi.userSent.length = 0;
});

test("a service never blocks a held follow-up's release", async () => {
	const ctx = makeCtx("tui");
	await emit("session_start", ctx);
	await bash({ command: "sleep 30", title: "hold service probe", expectedSeconds: null });

	const handler = pi.handlers.get("input")?.[0];
	assert.ok(handler, "input handler is registered");
	const result = await handler(
		{ text: "carry on", source: "interactive", streamingBehavior: "followUp" },
		ctx,
	);
	assert.deepEqual(result, { action: "handled" }, "claimed; a service is not an awaited job");
	assert.equal(pi.userSent.length, 0);

	// The settle releases it although the service is still running: a service is never
	// waited on (§1), so it cannot be a reason to hold.
	await emit("agent_settled", ctx);
	assert.deepEqual(pi.userSent.map((m) => m.content), ["carry on"]);
	await emit("session_shutdown", ctx); // aborts the service; shutdown is its only record
	pi.sent.length = 0;
	pi.userSent.length = 0;
});

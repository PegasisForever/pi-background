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
	handlers: Map<string, Array<(event: object, ctx: ExtensionContext) => Promise<void>>>;
	tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
	sent: Sent[];
	registerFlag: () => void;
	registerEntryRenderer: () => void;
	registerMessageRenderer: () => void;
	registerCommand: () => void;
	registerTool: (def: { name: string }) => void;
	on: (event: string, handler: (event: object, ctx: ExtensionContext) => Promise<void>) => void;
	getFlag: () => undefined;
	exec: () => Promise<never>;
	appendEntry: () => void;
	sendMessage: (message: Sent["message"], options?: unknown) => void;
	sendUserMessage: () => void;
}

function makePi(): StubPi {
	const pi: StubPi = {
		handlers: new Map(),
		tools: new Map(),
		sent: [],
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
		sendUserMessage: () => {},
	};
	return pi;
}

function makeCtx(mode: "print" | "json" | "tui" | "rpc"): ExtensionContext {
	return {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: process.cwd(),
		ui: { setStatus: () => {} },
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

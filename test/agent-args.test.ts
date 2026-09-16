import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRun } from "../src/agent-job.ts";
import { childArgs } from "../src/agent-job.ts";

const base: AgentRun = {
	task: "do the work",
	cwd: "/tmp/work",
	depthRemaining: 1,
	sessionDir: "/home/me/.pi/agent/jobs/abc",
	sessionId: "abc",
};

test("a child with no model given picks its own default: no model flags", () => {
	const args = childArgs(base);
	assert.equal(args.includes("--provider"), false);
	assert.equal(args.includes("--model"), false);
	assert.equal(args.includes("--thinking"), false);
	assert.deepEqual(args.slice(0, 2), ["--mode", "json"]);
	assert.ok(args.includes("--jobs-depth=0"));
});

test("a child inherits the parent's provider, model and thinking level", () => {
	const args = childArgs({
		...base,
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		thinking: "high",
	});
	const at = (flag: string) => args.indexOf(flag);
	assert.ok(at("--provider") !== -1, "has --provider");
	assert.equal(args[at("--provider") + 1], "anthropic");
	assert.ok(at("--model") !== -1, "has --model");
	assert.equal(args[at("--model") + 1], "claude-sonnet-4-5");
	assert.ok(at("--thinking") !== -1, "has --thinking");
	assert.equal(args[at("--thinking") + 1], "high");
});

test("a model without a thinking level adds no --thinking flag", () => {
	const args = childArgs({ ...base, model: { provider: "openai", id: "gpt-5.5" } });
	assert.equal(args.includes("--thinking"), false);
	assert.equal(args.includes("--provider"), true);
});

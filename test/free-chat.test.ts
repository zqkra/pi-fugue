import { test } from "node:test";
import assert from "node:assert/strict";
import type { Voice } from "../src/types.ts";
import { bgWaitBlockReason, forceBackground } from "../src/free-chat.ts";

function voice(runId: string, state: Voice["state"]): Voice {
	return { runId, name: runId.slice(0, 4), role: "worker", parent: "conductor", origin: "fugue", state };
}

const running = [voice("aaaa1111-run", "running"), voice("bbbb2222-run", "done")];

test("a blocking wait while a voice is active is blocked", () => {
	assert.ok(bgWaitBlockReason({}, running));
	assert.ok(bgWaitBlockReason({ all: true }, running));
	assert.ok(bgWaitBlockReason({ id: "aaaa" }, running));
});

test("non-blocking waits, other runs and idle sessions pass through", () => {
	assert.equal(bgWaitBlockReason({ nonBlocking: true }, running), undefined);
	assert.equal(bgWaitBlockReason({ id: "cccc" }, running), undefined);
	assert.equal(bgWaitBlockReason({ id: "bbbb" }, running), undefined, "settled voice: wait returns at once");
	assert.equal(bgWaitBlockReason({}, [voice("bbbb2222-run", "done")]), undefined);
});

test("foreground launches become background; actions and clarify stay", () => {
	const launch: Record<string, unknown> = { agent: "worker", task: "x", async: false };
	assert.equal(forceBackground(launch), true);
	assert.equal(launch.async, true);
	const implicit: Record<string, unknown> = { agent: "worker", task: "x" };
	assert.equal(forceBackground(implicit), true);
	assert.equal(implicit.async, true);
	const status: Record<string, unknown> = { action: "status", id: "abc" };
	assert.equal(forceBackground(status), false);
	assert.equal("async" in status, false);
	const clarify: Record<string, unknown> = { agent: "worker", task: "x", clarify: true };
	assert.equal(forceBackground(clarify), false);
});

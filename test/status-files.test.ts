import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deriveActivity,
	mapState,
	readOutputTail,
	readPendingQuestion,
	readStatusFile,
	readVoiceFields,
	terminalState,
	type StatusFile,
} from "../src/status-files.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);

async function fixture(name: string): Promise<StatusFile> {
	return JSON.parse(await readFile(new URL(name, FIXTURES), "utf8")) as StatusFile;
}

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "fugue-status-"));
}

test("a real completed status.json maps to voice fields", async () => {
	const status = await fixture("status-complete.json");
	const fields = readVoiceFields(status);
	assert.equal(fields.state, "done");
	assert.equal(fields.laneKey, "probe-voice");
	assert.equal(fields.model, "opencode-go/deepseek-v4.1-flash:low");
	assert.equal(fields.thinking, "low");
	assert.deepEqual(fields.tokens, { input: 2848, output: 528, total: 3376 });
	assert.equal(fields.costUsd, 0.000744);
	assert.equal(typeof fields.startedAt, "number");
	assert.equal(typeof fields.endedAt, "number");
	assert.equal(fields.pid, 542295);
	assert.equal(fields.activity, undefined);
});

test("a real failed status.json maps state and error", async () => {
	const status = await fixture("status-failed.json");
	const fields = readVoiceFields(status);
	assert.equal(fields.state, "failed");
	assert.match(fields.error ?? "", /unavailable child tools/);
});

test("mapState follows the design table", () => {
	assert.equal(mapState("queued"), "queued");
	assert.equal(mapState("running"), "running");
	assert.equal(mapState("running", "needs_attention"), "blocked");
	assert.equal(mapState("paused"), "paused");
	assert.equal(mapState("complete"), "done");
	assert.equal(mapState("failed"), "failed");
	assert.equal(mapState("partial"), "failed");
	assert.equal(mapState("rejected"), "failed");
	assert.equal(mapState("stopped"), "stopped");
	assert.equal(mapState(undefined), "queued");
});

test("terminalState maps result payload states", () => {
	assert.equal(terminalState("complete", true), "done");
	assert.equal(terminalState("failed", false), "failed");
	assert.equal(terminalState("stopped", true), "stopped");
	assert.equal(terminalState(undefined, true), "done");
	assert.equal(terminalState(undefined, false), "failed");
});

test("deriveActivity maps tools, details and relative paths", () => {
	assert.deepEqual(deriveActivity({ state: "running" }), { kind: "thinking" });
	assert.deepEqual(deriveActivity({ state: "running", currentTool: "read", currentPath: "/work/src/db.ts", cwd: "/work" }), {
		kind: "reading",
		detail: "src/db.ts",
	});
	assert.deepEqual(deriveActivity({ state: "running", currentTool: "edit", currentPath: "src/db.ts" }), {
		kind: "writing",
		detail: "src/db.ts",
	});
	assert.deepEqual(deriveActivity({ state: "running", currentTool: "grep" }), { kind: "searching" });
	assert.deepEqual(deriveActivity({ state: "running", currentTool: "subagent" }), { kind: "delegating" });
	const command = "x".repeat(80);
	assert.deepEqual(deriveActivity({ state: "running", currentTool: "bash", currentToolArgs: command }), {
		kind: "running",
		detail: "x".repeat(40),
	});
	assert.equal(deriveActivity({ state: "complete", currentTool: "read" }), undefined);
	assert.equal(deriveActivity({ state: "running", activityState: "needs_attention", currentTool: "read" }), undefined);
});

test("readStatusFile is mtime gated", async () => {
	const root = await tempDir();
	try {
		const asyncDir = join(root, "async-subagent-runs", "run-1");
		await mkdir(asyncDir, { recursive: true });
		const status = await fixture("status-complete.json");
		await writeFile(join(asyncDir, "status.json"), JSON.stringify(status));
		const first = await readStatusFile(asyncDir);
		assert.ok(first);
		assert.equal(first.status.runId, "0a6bb1f0-5767-494f-9f5c-19d7c99fde76");
		assert.equal(await readStatusFile(asyncDir, first.mtimeMs), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("readOutputTail returns the newest output log tail", async () => {
	const root = await tempDir();
	try {
		await writeFile(join(root, "output-0.log"), "one\ntwo\nthree\nfour\n");
		await writeFile(join(root, "output-1.log"), "alpha\nbeta\n");
		assert.deepEqual(await readOutputTail(root, 2), ["alpha", "beta"]);
		assert.deepEqual(await readOutputTail(root, 1), ["beta"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("readPendingQuestion finds the last supervisor request", async () => {
	const root = await tempDir();
	try {
		const events = [
			JSON.stringify({ type: "subagent.run.started" }),
			JSON.stringify({
				type: "subagent.control",
				noticeText: "old",
				event: { type: "needs_attention", reason: "supervisor_request", message: "old question", toolCallId: "q1", ts: 10, runId: "run-1" },
			}),
			JSON.stringify({ type: "subagent.steering.notice" }),
			JSON.stringify({
				type: "subagent.control",
				event: { type: "needs_attention", reason: "supervisor_request", message: "Postgres or SQLite?", toolCallId: "q2", ts: 42, runId: "run-1" },
			}),
		].join("\n");
		await writeFile(join(root, "events.jsonl"), events);
		const question = await readPendingQuestion(root);
		assert.deepEqual(question, { id: "q2", message: "Postgres or SQLite?", at: 42 });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

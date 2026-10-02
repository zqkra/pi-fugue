import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { laneMode, createVoiceTools } from "../src/tools.ts";
import { Store, type BridgeLike } from "../src/store.ts";
import type { VoiceEntry } from "../src/store.ts";

const ctx = {} as ExtensionToolContext;

interface RecordedRequest {
	method: string;
	params: Record<string, unknown>;
}

function spawnBridge(): BridgeLike & { requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	let runIndex = 0;
	return {
		requests,
		async request<T>(method: string, params: object = {}): Promise<T> {
			requests.push({ method, params: params as Record<string, unknown> });
			if (method === "spawn") {
				runIndex += 1;
				return { details: { runId: `run-${runIndex}`, asyncDir: `/tmp/async/run-${runIndex}` } } as T;
			}
			if (method === "resume") return { details: { runId: "resumed-1" } } as T;
			return {} as T;
		},
	};
}

function makeDeps(): { store: Store; bridge: ReturnType<typeof spawnBridge>; persisted: VoiceEntry[] } {
	const bridge = spawnBridge();
	const persisted: VoiceEntry[] = [];
	const store = new Store({
		bridge,
		conductor: {},
		tempRoot: "/tmp/fugue-tools",
		now: () => 1_000_000,
		isProcessAlive: () => true,
		persist: (entry) => persisted.push(entry),
	});
	return { store, bridge, persisted };
}

function tool(name: string, deps: { store: Store; bridge: BridgeLike }) {
	const found = createVoiceTools(() => deps).find((candidate) => candidate.name === name);
	assert.ok(found, `tool ${name}`);
	return found;
}

const theme = {
	fg: (_color: string, text: string) => text,
} as never;

const renderContext = {} as never;

function text(result: { content: unknown[] }): string {
	for (const part of result.content) {
		const candidate = part as { type?: string; text?: string };
		if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text;
	}
	return "";
}

test("laneMode maps roles to pi-subagents lane modes", () => {
	assert.equal(laneMode("worker"), "mutation");
	assert.equal(laneMode("delegate"), "mutation");
	assert.equal(laneMode("reviewer"), "review");
	assert.equal(laneMode("evidence-auditor"), "review");
	assert.equal(laneMode("scout"), "scout");
	assert.equal(laneMode("researcher"), "scout");
	assert.equal(laneMode("oracle"), undefined);
});

test("riff_spawn sends lane keys, never async, and registers every voice", async () => {
	const { store, bridge, persisted } = makeDeps();
	const spawn = tool("riff_spawn", { store, bridge });
	const result = await spawn.execute(
		"call-1",
		{ riffs: [
			{ name: "Auth", role: "worker", task: "implement", model: "opencode-go/deepseek-v4.1-flash:low" },
			{ name: "db scout", role: "oracle", task: "decide" },
		] },
		undefined,
		undefined,
		ctx,
	);
	assert.equal((result.details as { started: number }).started, 2);
	assert.match(text(result), /auth {2}worker {2}opencode-go\/deepseek-v4\.1-flash:low {2}started {2}run run-1/);
	const lanes = bridge.requests.filter((request) => request.method === "spawn").map((request) => request.params.lane as Record<string, unknown>);
	assert.deepEqual(lanes, [
		{ version: 1, key: "auth", mode: "mutation" },
		{ version: 1, key: "db-scout" },
	]);
	assert.equal(bridge.requests[0].params.async, undefined);
	// pi-subagents would stop a background child at 30 min; riffs get 4 h and a clean wrap-up before it.
	assert.equal(bridge.requests[0].params.timeoutMs, 240 * 60_000);
	assert.equal(bridge.requests[0].params.checkpointBeforeDeadlineMs, 5 * 60_000);
	assert.equal(store.voiceByName("auth")?.runId, "run-1");
	assert.equal(store.voiceByName("db-scout")?.role, "oracle");
	assert.equal(persisted.length, 2);
	store.dispose();
});

test("riff_spawn suffixes name collisions for the whole session", async () => {
	const { store, bridge } = makeDeps();
	const spawn = tool("riff_spawn", { store, bridge });
	const request = { riffs: [{ name: "probe", role: "scout", task: "trivial" }] };
	await spawn.execute("call-1", request, undefined, undefined, ctx);
	await spawn.execute("call-2", request, undefined, undefined, ctx);
	const keys = bridge.requests
		.filter((entry) => entry.method === "spawn")
		.map((entry) => (entry.params.lane as { key: string }).key);
	assert.deepEqual(keys, ["probe", "probe-2"]);
	assert.ok(store.voiceByName("probe-2"));
	store.dispose();
});

test("riff_spawn rejects invalid names without calling the bridge", async () => {
	const { store, bridge } = makeDeps();
	const spawn = tool("riff_spawn", { store, bridge });
	const result = await spawn.execute("call-1", { riffs: [{ name: "2fast", role: "scout", task: "x" }] }, undefined, undefined, ctx);
	assert.equal(result.isError, true);
	assert.match(text(result), /error: .*start with a letter/);
	assert.equal(bridge.requests.length, 0);
	store.dispose();
});

test("riff_status lists the roster and one voice in detail", async () => {
	const { store, bridge } = makeDeps();
	const spawn = tool("riff_spawn", { store, bridge });
	await spawn.execute("call-1", { riffs: [{ name: "probe", role: "scout", task: "trivial" }] }, undefined, undefined, ctx);
	const status = tool("riff_status", { store, bridge });
	const roster = await status.execute("call-2", {}, undefined, undefined, ctx);
	assert.match(text(roster), /probe {2}scout {2}queued/);
	const emptyName = await status.execute("call-3", { name: "" }, undefined, undefined, ctx);
	assert.equal(text(emptyName), text(roster));
	const detail = await status.execute("call-4", { name: "probe" }, undefined, undefined, ctx);
	assert.match(text(detail), /probe {2}scout {2}queued/);
	assert.match(text(detail), /task: trivial/);
	assert.match(text(detail), /run: run-1/);
	store.dispose();
});

test("unknown voice names list the known roster", async () => {
	const { store, bridge } = makeDeps();
	const spawn = tool("riff_spawn", { store, bridge });
	await spawn.execute("call-1", { riffs: [{ name: "probe", role: "scout", task: "x" }] }, undefined, undefined, ctx);
	const tell = tool("riff_tell", { store, bridge });
	await assert.rejects(tell.execute("call-2", { name: "nope", message: "x" }, undefined, undefined, ctx), /Unknown riff "nope"\. Known riffs: probe/);
	const stop = tool("riff_stop", { store, bridge });
	await assert.rejects(stop.execute("call-3", { name: "nope" }, undefined, undefined, ctx), /Known riffs: probe/);
	const status = tool("riff_status", { store, bridge });
	await assert.rejects(status.execute("call-4", { name: "nope" }, undefined, undefined, ctx), /Known riffs: probe/);
	assert.equal(store.voiceByName("probe")?.name, "probe");
	store.dispose();
});

test("riff_spawn reports the full run id so completion notices map to names", async () => {
	const runId = "1a2b3c4d-0000-4000-8000-abcdefabcdef";
	const bridge = {
		async request<T>(method: string): Promise<T> {
			assert.equal(method, "spawn");
			return { details: { runId, asyncDir: "/tmp/fugue-tools/run" } } as T;
		},
	};
	const store = new Store({ bridge, conductor: {}, tempRoot: "/tmp/fugue-tools", now: () => 0, isProcessAlive: () => true });
	const spawn = tool("riff_spawn", { store, bridge });
	const result = await spawn.execute("call-1", { riffs: [{ name: "auth", role: "worker", task: "x" }] }, undefined, undefined, ctx);
	assert.match(text(result), new RegExp(`auth {2}worker {2}default model {2}started {2}run ${runId}`));
	assert.equal(store.voice(runId)?.name, "auth");
	store.dispose();
});

test("riff_tell steers a live voice and resumes a settled one", async () => {
	const { store, bridge } = makeDeps();
	const spawn = tool("riff_spawn", { store, bridge });
	await spawn.execute("call-1", { riffs: [{ name: "probe", role: "scout", task: "trivial" }] }, undefined, undefined, ctx);
	const tell = tool("riff_tell", { store, bridge });
	const steered = await tell.execute("call-2", { name: "probe", message: "answer" }, undefined, undefined, ctx);
	assert.equal(text(steered), "steered probe");
	assert.equal(bridge.requests.at(-1)?.method, "steer");
	store.onAsyncComplete({ runId: "run-1", state: "complete", success: true });
	const resumed = await tell.execute("call-3", { name: "probe", message: "again" }, undefined, undefined, ctx);
	assert.equal(text(resumed), "resumed probe");
	assert.equal(bridge.requests.at(-1)?.method, "resume");
	store.dispose();
});

test("riff_stop stops a voice and renderers stay one line", async () => {
	const { store, bridge } = makeDeps();
	const spawn = tool("riff_spawn", { store, bridge });
	await spawn.execute("call-1", { riffs: [{ name: "probe", role: "scout", task: "trivial" }] }, undefined, undefined, ctx);
	const stop = tool("riff_stop", { store, bridge });
	const stopped = await stop.execute("call-2", { name: "probe" }, undefined, undefined, ctx);
	assert.equal(text(stopped), "stopped probe");
	const callLine = spawn.renderCall?.({ riffs: [{ name: "auth", role: "worker", task: "x" }, { name: "db", role: "scout", task: "x" }] } as never, theme, renderContext);
	assert.deepEqual(callLine?.render(120), ["riff_spawn auth worker · db scout"]);
	const resultLine = spawn.renderResult?.(
		{ content: [{ type: "text", text: "2 riffs started" }], details: { action: "spawn", started: 2, voices: [] } } as never,
		{ expanded: false, isPartial: false },
		theme,
		renderContext,
	);
	assert.deepEqual(resultLine?.render(120), ["2 riffs started"]);
	store.dispose();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type BridgeLike, type VoiceEntry } from "../src/store.ts";
import type { StatusFile } from "../src/status-files.ts";
import type { GateReport, RiffWorktree, Voice } from "../src/types.ts";
import { layoutScoreLine } from "../src/ui/score-line.ts";
import { darkTheme, stripAnsi } from "./helpers.ts";

const NOW = 1_000_000;

interface RecordedRequest {
	method: string;
	params: Record<string, unknown>;
}

function fakeBridge(): BridgeLike & { requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	return {
		requests,
		async request<T>(method: string, params: object = {}): Promise<T> {
			requests.push({ method, params: params as Record<string, unknown> });
			if (method === "resume") return { details: { runId: "resumed-1" } } as T;
			return {} as T;
		},
	};
}

function makeStore(
	root: string,
	overrides: Partial<ConstructorParameters<typeof Store>[0]> = {},
): { store: Store; bridge: ReturnType<typeof fakeBridge>; persisted: VoiceEntry[] } {
	const bridge = fakeBridge();
	const persisted: VoiceEntry[] = [];
	const store = new Store({
		bridge,
		conductor: { model: "deepseek-v4.1-flash", thinking: "high" },
		tempRoot: root,
		now: () => NOW,
		isProcessAlive: () => true,
		persist: (entry) => persisted.push(entry),
		...overrides,
	});
	return { store, bridge, persisted };
}

async function writeStatus(root: string, runId: string, status: StatusFile): Promise<string> {
	const asyncDir = join(root, "async-subagent-runs", runId);
	await mkdir(asyncDir, { recursive: true });
	await writeFile(join(asyncDir, "status.json"), JSON.stringify(status));
	return asyncDir;
}

function runningStatus(overrides: Partial<StatusFile> = {}): StatusFile {
	return {
		state: "running",
		pid: 4242,
		cwd: "/work",
		lastUpdate: NOW - 1000,
		startedAt: NOW - 5000,
		steps: [{ agent: "worker", status: "running", currentTool: "read", currentPath: "/work/src/db.ts", tokens: { input: 10, output: 5, total: 15 } }],
		...overrides,
	};
}

/**
 * A `contact_supervisor` ask as pi-subagents leaves it: the open request file, the
 * control record in events.jsonl (which keeps the question after the answer), and
 * `status.json` (pass `activityState: "needs_attention"` to runningStatus).
 */
async function writePendingAsk(root: string, runId: string, agent: string, asyncDir: string, message: string): Promise<string> {
	const requests = join(root, "supervisor-channels", `${runId}-${agent}-0`, "requests");
	await mkdir(requests, { recursive: true });
	const request = join(requests, "q1.json");
	await writeFile(request, JSON.stringify({ id: "q1", message, createdAt: NOW }));
	await writeFile(
		join(asyncDir, "events.jsonl"),
		`${JSON.stringify({ type: "subagent.control", event: { type: "needs_attention", reason: "supervisor_request", message, toolCallId: "q1", ts: NOW, runId } })}\n`,
	);
	return request;
}

test("snapshots are immutable, versions bump, and subscribers notify once per batch", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store } = makeStore(root);
		const first = store.snapshot();
		const versions: number[] = [];
		store.subscribe(() => versions.push(store.snapshot().version));
		store.registerVoice({ runId: "a", name: "auth", role: "worker", origin: "fugue" });
		store.registerVoice({ runId: "b", name: "db", role: "scout", origin: "fugue" });
		assert.equal(first.voices.length, 0);
		assert.equal(first.version, 0);
		assert.equal(versions.length, 0);
		await Promise.resolve();
		assert.deepEqual(versions, [2]);
		assert.equal(store.snapshot().voices.length, 2);
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("hydrate takes the latest entry per runId and keeps roster order", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store } = makeStore(root);
		store.hydrate([
			{ runId: "run-1", name: "probe", role: "scout", parent: "conductor", origin: "fugue", startedAt: 100, state: "queued" },
			{
				runId: "run-1",
				name: "probe",
				role: "scout",
				parent: "conductor",
				origin: "fugue",
				startedAt: 100,
				state: "done",
				endedAt: 900,
				summary: "found it",
				tokens: { input: 1, output: 2, total: 3 },
				costUsd: 0.01,
			},
			{ runId: "run-2", name: "probe", role: "scout", parent: "conductor", origin: "fugue", startedAt: 200 },
			{ runId: "run-3", name: "db", role: "worker", parent: "conductor", origin: "subagent", startedAt: 150 },
		]);
		const voices = store.snapshot().voices;
		assert.deepEqual(
			voices.map((voice) => [voice.runId, voice.name, voice.state]),
			[["run-1", "probe", "done"], ["run-2", "probe", "queued"], ["run-3", "db", "queued"]],
		);
		assert.equal(store.voice("run-1")?.summary, "found it");
		assert.deepEqual(store.voice("run-1")?.tokens, { input: 1, output: 2, total: 3 });
		assert.equal(store.voice("run-1")?.costUsd, 0.01);
		assert.equal(store.voiceByName("probe")?.runId, "run-2");
		assert.equal(store.polling(), true);
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a hydrated live voice without run files settles stopped and is persisted", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store, persisted } = makeStore(root);
		store.hydrate([{ runId: "run-1", name: "probe", role: "scout", parent: "conductor", origin: "fugue", startedAt: NOW - 1000, state: "running" }]);
		assert.equal(store.polling(), true);
		await store.refreshAll();
		const voice = store.voice("run-1");
		assert.equal(voice?.state, "stopped");
		assert.equal(voice?.error, "run files missing (machine restarted?)");
		assert.equal(store.polling(), false);
		const last = persisted.at(-1);
		assert.equal(last?.runId, "run-1");
		assert.equal(last?.state, "stopped");
		assert.equal(last?.error, "run files missing (machine restarted?)");
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a freshly registered voice without a status file is left queued", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store } = makeStore(root);
		store.registerVoice({ runId: "run-1", name: "probe", role: "scout", origin: "fugue", asyncDir: join(root, "async-subagent-runs", "run-1") });
		await store.refreshAll();
		assert.equal(store.voice("run-1")?.state, "queued");
		assert.equal(store.polling(), true);
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("settling persists the final state for reboot recovery", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store, persisted } = makeStore(root);
		store.registerVoice({ runId: "run-1", name: "probe", role: "scout", origin: "fugue" });
		store.onAsyncComplete({
			runId: "run-1",
			state: "complete",
			success: true,
			summary: "found it",
			timestamp: NOW,
			results: [{ usage: { input: 5, output: 7, cost: 0.02 } }],
		});
		const last = persisted.at(-1);
		assert.equal(last?.state, "done");
		assert.equal(last?.summary, "found it");
		assert.deepEqual(last?.tokens, { input: 5, output: 7, total: 12 });
		assert.equal(last?.costUsd, 0.02);
		assert.equal(last?.endedAt, NOW);
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("setConductor publishes model and thinking changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store } = makeStore(root);
		store.setConductor({ model: "claude-opus-5-5", thinking: "high" });
		assert.deepEqual(store.snapshot().conductor, { model: "claude-opus-5-5", thinking: "high" });
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a raw async-started run is renamed from its status lane key and persisted once", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store, persisted } = makeStore(root);
		await writeStatus(root, "raw-1", runningStatus({ lane: { key: "probe-x" } }));
		store.onAsyncStarted({ id: "raw-1", asyncDir: join(root, "async-subagent-runs", "raw-1"), agent: "scout" });
		assert.equal(store.voice("raw-1")?.name, "scout");
		assert.equal(persisted.length, 0);
		await store.refreshAll();
		const voice = store.voice("raw-1");
		assert.equal(voice?.name, "probe-x");
		assert.equal(voice?.state, "running");
		assert.deepEqual(voice?.activity, { kind: "reading", detail: "src/db.ts" });
		assert.equal(persisted.length, 1);
		assert.equal(persisted[0].name, "probe-x");
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("status refresh updates state, tokens, cost, and polling stops when all settle", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store } = makeStore(root);
		store.registerVoice({ runId: "run-1", name: "probe", role: "scout", origin: "fugue", asyncDir: join(root, "async-subagent-runs", "run-1") });
		assert.equal(store.polling(), true);
		await writeStatus(root, "run-1", {
			state: "complete",
			pid: 4242,
			startedAt: NOW - 5000,
			endedAt: NOW - 1000,
			lastUpdate: NOW - 1000,
			totalTokens: { input: 20, output: 8, total: 28 },
			totalCost: { costUsd: 0.0012 },
			steps: [{ agent: "scout", status: "complete", model: "deepseek-v4.1-flash", thinking: "low" }],
		});
		await store.refreshAll();
		const voice = store.voice("run-1");
		assert.equal(voice?.state, "done");
		assert.deepEqual(voice?.tokens, { input: 20, output: 8, total: 28 });
		assert.equal(voice?.costUsd, 0.0012);
		assert.equal(voice?.model, "deepseek-v4.1-flash");
		assert.equal(voice?.endedAt, NOW - 1000);
		assert.equal(store.polling(), false);
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a dead runner pid with a stale status fails the voice", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store } = makeStore(root, { isProcessAlive: () => false });
		store.registerVoice({ runId: "run-1", name: "probe", role: "scout", origin: "fugue", asyncDir: join(root, "async-subagent-runs", "run-1") });
		await writeStatus(root, "run-1", runningStatus({ lastUpdate: NOW - 60_000, startedAt: NOW - 90_000 }));
		await store.refreshAll();
		const voice = store.voice("run-1");
		assert.equal(voice?.state, "failed");
		assert.equal(voice?.error, "runner exited");
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a supervisor request blocks the voice, records an edge, and clears on running", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store } = makeStore(root);
		store.registerVoice({ runId: "run-1", name: "db", role: "scout", origin: "fugue", asyncDir: join(root, "async-subagent-runs", "run-1") });
		// The control event only carries a generic text; the open request file holds the real question.
		const requests = join(root, "supervisor-channels", "run-1-scout-0", "requests");
		await mkdir(requests, { recursive: true });
		await writeFile(join(requests, "q1.json"), JSON.stringify({ id: "q1", message: "Postgres or SQLite?", createdAt: NOW }));
		store.onControlEvent({
			event: { type: "needs_attention", reason: "supervisor_request", message: "scout is waiting for a supervisor reply", toolCallId: "q1", ts: NOW, runId: "run-1" },
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(store.voice("run-1")?.state, "blocked");
		assert.equal(store.voice("run-1")?.question?.message, "Postgres or SQLite?");
		assert.deepEqual(store.snapshot().edges.map((edge) => [edge.from, edge.to, edge.kind]), [["run-1", "conductor", "asked"]]);
		await writeStatus(root, "run-1", runningStatus());
		await store.refreshAll();
		assert.equal(store.voice("run-1")?.state, "running");
		assert.equal(store.voice("run-1")?.question, undefined);
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a supervisor request answered on another channel unblocks the voice while status.json still says needs_attention", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store } = makeStore(root);
		const asyncDir = await writeStatus(root, "run-1", runningStatus({ activityState: "needs_attention" }));
		const request = await writePendingAsk(root, "run-1", "scout", asyncDir, "Postgres or SQLite?");
		store.registerVoice({ runId: "run-1", name: "db", role: "scout", origin: "fugue", asyncDir });
		store.onControlEvent({
			event: { type: "needs_attention", reason: "supervisor_request", message: "db is waiting for a supervisor reply", toolCallId: "q1", ts: NOW, runId: "run-1" },
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(store.voice("run-1")?.state, "blocked");
		assert.equal(store.voice("run-1")?.question?.message, "Postgres or SQLite?");
		const blockedLine = stripAnsi(layoutScoreLine(store.snapshot(), { width: 200, now: NOW, theme: darkTheme() })[0] ?? "");
		assert.ok(blockedLine.includes("asks"), blockedLine);

		// pi-subagents answered it: the request file is gone, status.json is untouched.
		await rm(request);
		await store.refreshAll();
		assert.equal(store.voice("run-1")?.state, "running");
		assert.equal(store.voice("run-1")?.question, undefined);
		assert.deepEqual(
			store.snapshot().edges.map((edge) => [edge.from, edge.to, edge.kind]),
			[["run-1", "conductor", "asked"], ["conductor", "run-1", "answered"]],
		);
		const answeredLine = stripAnsi(layoutScoreLine(store.snapshot(), { width: 200, now: NOW, theme: darkTheme() })[0] ?? "");
		assert.ok(!answeredLine.includes("asks"), answeredLine);

		// The stale needs_attention comes back with the riff's next status write: still not blocked.
		await new Promise((resolve) => setTimeout(resolve, 10));
		await writeStatus(root, "run-1", runningStatus({ activityState: "needs_attention", lastUpdate: NOW - 400 }));
		await store.refreshAll();
		assert.equal(store.voice("run-1")?.state, "running");
		assert.equal(store.voice("run-1")?.question, undefined);
		assert.deepEqual(store.snapshot().edges.map((edge) => edge.kind), ["asked", "answered"]);
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an open supervisor request keeps the voice blocked on every refresh", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store } = makeStore(root);
		// A session restart: no control event, the status file and the open request are all there is.
		const asyncDir = await writeStatus(root, "run-1", runningStatus({ activityState: "needs_attention" }));
		await writePendingAsk(root, "run-1", "scout", asyncDir, "Postgres or SQLite?");
		store.registerVoice({ runId: "run-1", name: "db", role: "scout", origin: "fugue", asyncDir });
		await store.refreshAll();
		// The ask is shown by the refresh or right after it; either way it must stick.
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(store.voice("run-1")?.state, "blocked");
		assert.equal(store.voice("run-1")?.question?.message, "Postgres or SQLite?");
		// An unchanged status file and a rewritten one that still says needs_attention: both keep it blocked.
		await store.refreshAll();
		await new Promise((resolve) => setTimeout(resolve, 10));
		await writeStatus(root, "run-1", runningStatus({ activityState: "needs_attention", lastUpdate: NOW - 400 }));
		await store.refreshAll();
		assert.equal(store.voice("run-1")?.state, "blocked");
		assert.equal(store.voice("run-1")?.question?.message, "Postgres or SQLite?");
		assert.deepEqual(store.snapshot().edges.map((edge) => edge.kind), ["asked"]);
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("riff_tell steers a blocked voice and the status refresh clears its question", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store, bridge } = makeStore(root);
		const asyncDir = await writeStatus(root, "run-1", runningStatus({ activityState: "needs_attention" }));
		await writePendingAsk(root, "run-1", "scout", asyncDir, "Postgres or SQLite?");
		store.registerVoice({ runId: "run-1", name: "db", role: "scout", origin: "fugue", asyncDir });
		await store.refreshAll();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(store.voice("run-1")?.state, "blocked");
		assert.equal(store.voice("run-1")?.question?.message, "Postgres or SQLite?");
		assert.equal(await store.tell("run-1", "Use Postgres", "follow_up"), "told db");
		assert.equal(bridge.requests.at(-1)?.method, "steer");
		assert.deepEqual(bridge.requests.at(-1)?.params, { runId: "run-1", message: "Use Postgres", mode: "follow_up" });
		// The riff picks the answer up: its status stops saying needs_attention.
		await new Promise((resolve) => setTimeout(resolve, 10));
		await writeStatus(root, "run-1", runningStatus({ lastUpdate: NOW - 400 }));
		await store.refreshAll();
		assert.equal(store.voice("run-1")?.state, "running");
		assert.equal(store.voice("run-1")?.question, undefined);
		assert.deepEqual(store.snapshot().edges.map((edge) => edge.kind), ["asked", "told"]);
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("tell steers a live voice and resumes a settled one under a new run id", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store, bridge } = makeStore(root);
		store.registerVoice({ runId: "run-1", name: "probe", role: "scout", origin: "fugue", asyncDir: join(root, "async-subagent-runs", "run-1") });
		assert.equal(await store.tell("run-1", "keep going", "steer"), "steered probe");
		assert.equal(bridge.requests.at(-1)?.method, "steer");
		store.onAsyncComplete({ runId: "run-1", state: "complete", success: true, summary: "found it", timestamp: NOW });
		assert.equal(store.voice("run-1")?.state, "done");
		assert.equal(await store.tell("run-1", "one more thing", "steer"), "resumed probe");
		assert.equal(bridge.requests.at(-1)?.method, "resume");
		assert.equal(store.voice("resumed-1")?.state, "queued");
		assert.equal(store.voice("run-1"), undefined);
		assert.deepEqual(store.snapshot().edges.map((edge) => edge.kind), ["steered", "told"]);
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("stop marks the voice stopped and records the last gate report", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store, bridge } = makeStore(root);
		store.registerVoice({ runId: "run-1", name: "probe", role: "scout", origin: "fugue" });
		assert.equal(await store.stop("run-1"), "stopped probe");
		assert.equal(bridge.requests.at(-1)?.method, "stop");
		assert.equal(store.voice("run-1")?.state, "stopped");
		const report: GateReport = { cwd: "/work", at: NOW, ok: true, checks: [] };
		store.setGate(report);
		assert.equal(store.snapshot().gate, report);
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a refresh that finishes after dispose starts no timer and persists nothing", async () => {
	const persisted: unknown[] = [];
	const store = new Store({
		bridge: { request: async () => ({}) as never },
		conductor: {},
		tempRoot: "/nonexistent-fugue-root",
		persist: (entry) => persisted.push(entry),
	});
	store.registerVoice({ runId: "run-late", name: "late", role: "scout", origin: "fugue" });
	const before = persisted.length;
	store.dispose();
	await store.refreshAll();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(store.polling(), false);
	assert.equal(persisted.length, before);
});

test("worktrees persist with the voice entry and hydrate restores them", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const worktree: RiffWorktree = { repoRoot: "/repo", path: "/wt/auth", branch: "fugue/auth", base: "abc123", status: "active" };
		const { store, persisted } = makeStore(root);
		store.registerVoice({ runId: "run-1", name: "auth", role: "worker", origin: "fugue", worktree });
		assert.deepEqual(store.voice("run-1")?.worktree, worktree);
		assert.deepEqual(persisted.at(-1)?.worktree, worktree);
		store.dispose();

		const { store: revived } = makeStore(root);
		revived.hydrate(persisted);
		assert.deepEqual(revived.voice("run-1")?.worktree, worktree);
		revived.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("settling calls the worktree hook once, survives a throwing hook, and replays write nothing", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const worktree: RiffWorktree = { repoRoot: "/repo", path: "/wt/auth", branch: "fugue/auth", base: "abc123", status: "active" };
		const settled: Voice[] = [];
		const { store, persisted } = makeStore(root, {
			onSettled: (voice) => {
				settled.push(voice);
				throw new Error("hook boom");
			},
		});
		store.registerVoice({ runId: "run-1", name: "auth", role: "worker", origin: "fugue", worktree });
		const afterRegister = persisted.length;
		store.onAsyncComplete({ runId: "run-1", state: "complete", success: true, timestamp: NOW });
		assert.equal(settled.length, 1);
		assert.equal(settled[0].state, "done");
		assert.deepEqual(settled[0].worktree, worktree);
		assert.equal(store.voice("run-1")?.state, "done", "the settle lands even though the hook throws");
		assert.equal(persisted.length, afterRegister + 1);
		// pi-subagents replays the same completion on reload: no second hook, no duplicate entry.
		store.onAsyncComplete({ runId: "run-1", state: "complete", success: true, timestamp: NOW });
		store.onAsyncComplete({ runId: "run-1", state: "complete", success: true, timestamp: NOW });
		assert.equal(settled.length, 1);
		assert.equal(persisted.length, afterRegister + 1);
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("hydrated runs are not written again unless something changed", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const { store, persisted } = makeStore(root);
		store.hydrate([{ runId: "run-1", name: "auth", role: "worker", parent: "conductor", origin: "fugue", state: "done", endedAt: NOW }]);
		store.onAsyncComplete({ runId: "run-1", state: "complete", success: true, timestamp: NOW });
		assert.equal(persisted.length, 0);
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("setWorktreeStatus marks merged/discarded, persists, and ignores unknown runs", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-store-"));
	try {
		const worktree: RiffWorktree = { repoRoot: "/repo", path: "/wt/auth", branch: "fugue/auth", base: "abc123", status: "active" };
		const { store, persisted } = makeStore(root);
		store.registerVoice({ runId: "run-1", name: "auth", role: "worker", origin: "fugue", worktree });
		store.setWorktreeStatus("run-1", "merged");
		assert.equal(store.voice("run-1")?.worktree?.status, "merged");
		assert.equal(persisted.at(-1)?.worktree?.status, "merged");
		store.setWorktreeStatus("run-1", "merged");
		assert.equal(store.snapshot().version > 0, true);
		store.setWorktreeStatus("missing", "discarded");
		assert.equal(store.voice("missing"), undefined);
		store.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

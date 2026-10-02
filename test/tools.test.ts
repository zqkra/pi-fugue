import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { laneMode, createVoiceTools } from "../src/tools.ts";
import { Store, type BridgeLike } from "../src/store.ts";
import type { VoiceEntry } from "../src/store.ts";

/** No repo here, so an isolated worker falls back cleanly instead of creating worktrees. */
const ctx = { cwd: join(tmpdir(), "fugue-tools-no-repo") } as ExtensionToolContext;

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

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function gitTry(cwd: string, ...args: string[]): { status: number | null } {
	return { status: spawnSync("git", args, { cwd, encoding: "utf8" }).status };
}

/** Temp repo as `<parent>/repo`, so worktrees land in a private `<parent>/.fugue-worktrees`. */
async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
	const parent = await mkdtemp(join(tmpdir(), "fugue-tools-repo-"));
	const repo = join(parent, "repo");
	await mkdir(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	await writeFile(join(repo, "app.txt"), "one\n");
	git(repo, "add", "app.txt");
	git(repo, "commit", "-qm", "base");
	try {
		await run(repo);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
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

test("worker riffs are isolated by default; scout is not; isolate:false overrides", async () => {
	await withRepo(async (repo) => {
		const { store, bridge } = makeDeps();
		const spawn = tool("riff_spawn", { store, bridge });
		const repoCtx = { cwd: repo } as ExtensionToolContext;
		const result = await spawn.execute("call-1", { riffs: [{ name: "auth", role: "worker", task: "implement" }] }, undefined, undefined, repoCtx);
		const auth = store.voiceByName("auth");
		assert.equal(auth?.worktree?.branch, "fugue/auth");
		assert.equal(auth?.worktree?.repoRoot, repo);
		assert.ok(auth?.worktree && existsSync(auth.worktree.path));
		const spawnRequest = bridge.requests.find((entry) => entry.method === "spawn");
		assert.equal(spawnRequest?.params.cwd, auth?.worktree?.path);
		assert.match(String(spawnRequest?.params.task), /isolated git worktree/);
		assert.doesNotMatch(text(result), /not isolated/);

		await spawn.execute("call-2", { riffs: [{ name: "db", role: "scout", task: "look" }] }, undefined, undefined, repoCtx);
		assert.equal(store.voiceByName("db")?.worktree, undefined);

		await spawn.execute("call-3", { riffs: [{ name: "fix", role: "worker", task: "x", isolate: false }] }, undefined, undefined, repoCtx);
		assert.equal(store.voiceByName("fix")?.worktree, undefined);
		store.dispose();
	});
});

test("a non-git cwd falls back to an unisolated run and says so", async () => {
	const plain = await mkdtemp(join(tmpdir(), "fugue-tools-plain-"));
	try {
		const { store, bridge } = makeDeps();
		const spawn = tool("riff_spawn", { store, bridge });
		const result = await spawn.execute(
			"call-1",
			{ riffs: [{ name: "auth", role: "worker", task: "x" }] },
			undefined,
			undefined,
			{ cwd: plain } as ExtensionToolContext,
		);
		assert.match(text(result), /not isolated: .*not inside a git repository/);
		assert.equal(store.voiceByName("auth")?.worktree, undefined);
		assert.equal(bridge.requests.find((entry) => entry.method === "spawn")?.params.cwd, plain);
		store.dispose();
	} finally {
		await rm(plain, { recursive: true, force: true });
	}
});

test("riff_merge refuses a running riff, then merges the settled one into the main checkout", async () => {
	await withRepo(async (repo) => {
		const { store, bridge } = makeDeps();
		const spawn = tool("riff_spawn", { store, bridge });
		const repoCtx = { cwd: repo } as ExtensionToolContext;
		await spawn.execute("call-1", { riffs: [{ name: "auth", role: "worker", task: "x" }] }, undefined, undefined, repoCtx);
		const worktree = store.voiceByName("auth")!.worktree!;
		await writeFile(join(worktree.path, "feature.txt"), "from the riff\n");
		git(worktree.path, "add", "feature.txt");
		git(worktree.path, "commit", "-qm", "add feature");
		const merge = tool("riff_merge", { store, bridge });

		const refused = await merge.execute("call-2", { name: "auth" }, undefined, undefined, repoCtx);
		assert.equal(refused.isError, true);
		assert.match(text(refused), /auth is queued; wait for it to settle or riff_stop it/);

		store.onAsyncComplete({ runId: "run-1", state: "complete", success: true, timestamp: 1_000_000 });
		const merged = await merge.execute("call-3", { name: "auth" }, undefined, undefined, repoCtx);
		assert.equal(merged.isError, undefined);
		assert.match(text(merged), /^merged auth: 1 commit, 1 file/);
		assert.equal(await readFile(join(repo, "feature.txt"), "utf8"), "from the riff\n");
		assert.ok(!existsSync(worktree.path));
		assert.equal(store.voiceByName("auth")?.worktree?.status, "merged");
		store.dispose();
	});
});

test("riff_merge and riff_discard refuse an unisolated riff", async () => {
	const { store, bridge } = makeDeps();
	const spawn = tool("riff_spawn", { store, bridge });
	await spawn.execute("call-1", { riffs: [{ name: "db", role: "scout", task: "x" }] }, undefined, undefined, ctx);
	store.onAsyncComplete({ runId: "run-1", state: "complete", success: true });
	const merge = tool("riff_merge", { store, bridge });
	const merged = await merge.execute("call-2", { name: "db" }, undefined, undefined, ctx);
	assert.equal(merged.isError, true);
	assert.equal(text(merged), "db has no worktree");
	const discard = tool("riff_discard", { store, bridge });
	const discarded = await discard.execute("call-3", { name: "db" }, undefined, undefined, ctx);
	assert.equal(discarded.isError, true);
	assert.equal(text(discarded), "db has no worktree");
	store.dispose();
});

test("riff_discard refuses a running riff, then removes the folder and keeps the branch", async () => {
	await withRepo(async (repo) => {
		const { store, bridge } = makeDeps();
		const spawn = tool("riff_spawn", { store, bridge });
		const repoCtx = { cwd: repo } as ExtensionToolContext;
		await spawn.execute("call-1", { riffs: [{ name: "auth", role: "worker", task: "x" }] }, undefined, undefined, repoCtx);
		const worktree = store.voiceByName("auth")!.worktree!;
		const discard = tool("riff_discard", { store, bridge });

		const refused = await discard.execute("call-2", { name: "auth" }, undefined, undefined, repoCtx);
		assert.equal(refused.isError, true);
		assert.match(text(refused), /auth is queued; riff_stop it first/);

		store.onAsyncComplete({ runId: "run-1", state: "complete", success: true, timestamp: 1_000_000 });
		const discarded = await discard.execute("call-3", { name: "auth" }, undefined, undefined, repoCtx);
		assert.match(text(discarded), /^discarded auth, branch fugue\/auth kept/);
		assert.ok(!existsSync(worktree.path));
		assert.equal(gitTry(repo, "rev-parse", "--verify", "--quiet", "refs/heads/fugue/auth").status, 0);
		assert.equal(store.voiceByName("auth")?.worktree?.status, "discarded");
		const again = await discard.execute("call-4", { name: "auth" }, undefined, undefined, repoCtx);
		assert.equal(text(again), "already discarded: auth");
		store.dispose();
	});
});

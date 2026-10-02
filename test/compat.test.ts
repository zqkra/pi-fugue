import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	checkCompatibility,
	piSubagentsPackageJson,
	validatePing,
	validateStatusShape,
	versionProblems,
	watchCompatibility,
} from "../src/compat.ts";
import type { BridgeLike } from "../src/store.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const NOW = 1_700_000_000_000;

async function fixture(name: string): Promise<unknown> {
	return JSON.parse(await readFile(new URL(name, FIXTURES), "utf8")) as unknown;
}

function bridgeReturning(payload: unknown): BridgeLike {
	return {
		async request<T>(): Promise<T> {
			return payload as T;
		},
	};
}

/** Temp pi-subagents root with one run; optional mtime pins its order. */
async function statusRoot(status: unknown, mtimeMs?: number): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "fugue-compat-"));
	const dir = join(root, "async-subagent-runs", "run-1");
	await mkdir(dir, { recursive: true });
	const path = join(dir, "status.json");
	await writeFile(path, JSON.stringify(status));
	if (mtimeMs !== undefined) await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
	return root;
}

test("validatePing accepts the installed ping shape", async () => {
	assert.deepEqual(validatePing(await fixture("compat-ping.json")), []);
});

test("validatePing names every missing method and capability", () => {
	assert.deepEqual(validatePing({ methods: ["ping", "spawn"], capabilities: { asyncSpawn: true } }), [
		"rpc is missing methods: steer, stop, resume",
		"rpc is missing capabilities: steer, stop, resume",
	]);
	assert.deepEqual(validatePing(undefined), ["rpc ping returned no payload"]);
	assert.deepEqual(validatePing({ methods: "spawn", capabilities: { asyncSpawn: "true" } }), [
		"rpc is missing methods: spawn, steer, stop, resume",
		"rpc is missing capabilities: asyncSpawn, steer, stop, resume",
	]);
});

test("validateStatusShape accepts the installed status shape", async () => {
	assert.deepEqual(validateStatusShape(await fixture("compat-status.json")), []);
});

test("validateStatusShape names every drifted field", async () => {
	const status = (await fixture("compat-status.json")) as Record<string, unknown>;
	const step = (status.steps as Array<Record<string, unknown>>)[0];
	assert.deepEqual(
		validateStatusShape({
			...status,
			lifecycleArtifactVersion: 2,
			pid: undefined,
			lane: {},
			steps: [{ ...step, tokens: {}, contextLimit: undefined, toolCount: undefined, recentTools: undefined }],
		}),
		[
			"lifecycleArtifactVersion is 2 (expected 3)",
			"pid is missing",
			"lane.key is malformed",
			"steps[0].tokens.window is missing",
			"steps[0].contextLimit is missing",
			"steps[0].recentTools is missing",
		],
	);
	// A tool-using step must carry toolCount; a tool-less run has none to carry.
	assert.deepEqual(validateStatusShape({ ...status, steps: [{ ...step, toolCount: undefined }] }), ["steps[0].toolCount is missing"]);
	assert.deepEqual(validateStatusShape({ ...status, steps: [{ ...step, toolCount: undefined, recentTools: [] }] }), []);
	assert.deepEqual(validateStatusShape({ state: "running" }), [
		"lifecycleArtifactVersion is missing (expected 3)",
		"pid is missing",
		"steps[0] is missing",
	]);
	// Plain `subagent` runs carry no lane; that is not drift.
	assert.deepEqual(validateStatusShape({ ...status, lane: undefined }), []);
	assert.deepEqual(validateStatusShape("no"), ["status.json is not an object"]);
});

test("versionProblems accepts the tested range and flags anything else", () => {
	assert.deepEqual(versionProblems("0.74.0"), []);
	assert.deepEqual(versionProblems("0.75.3"), []);
	assert.equal(versionProblems("0.73.9").length, 1);
	assert.equal(versionProblems("1.0.0").length, 1);
	assert.equal(versionProblems(undefined).length, 1);
	assert.equal(versionProblems("not-a-version").length, 1);
});

test("checkCompatibility is ok on the installed shapes", async () => {
	const root = await statusRoot(await fixture("compat-status.json"));
	try {
		const report = await checkCompatibility(bridgeReturning(await fixture("compat-ping.json")), root, { version: "0.74.0" });
		assert.deepEqual(report, { ok: true, problems: [] });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("checkCompatibility reports rpc, version and status drift together", async () => {
	const root = await statusRoot({ lifecycleArtifactVersion: 2, state: "running", steps: [] });
	try {
		const report = await checkCompatibility(bridgeReturning({ methods: [] }), root, { version: "2.0.0" });
		assert.equal(report.ok, false);
		assert.deepEqual(report.problems, [
			"installed version is outside the tested range (0.74+)",
			"rpc is missing methods: spawn, steer, stop, resume",
			"rpc is missing capabilities: asyncSpawn, steer, stop, resume",
			"newest status.json: lifecycleArtifactVersion is 2 (expected 3)",
			"newest status.json: pid is missing",
			"newest status.json: steps[0] is missing",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("checkCompatibility reads the newest status.json by mtime", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-compat-"));
	try {
		const valid = await fixture("compat-status.json");
		const oldDir = join(root, "async-subagent-runs", "old");
		const newDir = join(root, "async-subagent-runs", "new");
		await mkdir(oldDir, { recursive: true });
		await mkdir(newDir, { recursive: true });
		const oldPath = join(oldDir, "status.json");
		const newPath = join(newDir, "status.json");
		await writeFile(oldPath, JSON.stringify(valid));
		await writeFile(newPath, JSON.stringify({ state: "complete" }));
		await utimes(oldPath, (NOW - 5_000) / 1000, (NOW - 5_000) / 1000);
		await utimes(newPath, NOW / 1000, NOW / 1000);
		const report = await checkCompatibility(bridgeReturning(await fixture("compat-ping.json")), root, { version: "0.74.0" });
		assert.equal(report.ok, false);
		assert.deepEqual(report.problems, [
			"newest status.json: lifecycleArtifactVersion is missing (expected 3)",
			"newest status.json: pid is missing",
			"newest status.json: steps[0] is missing",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("checkCompatibility reports a ping failure without throwing", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-compat-"));
	try {
		const bridge: BridgeLike = {
			async request<T>(): Promise<T> {
				throw new Error("rpc down");
			},
		};
		const report = await checkCompatibility(bridge, root, { version: "0.74.0" });
		assert.deepEqual(report, { ok: false, problems: ["rpc ping failed: rpc down"] });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("checkCompatibility ignores a root without runs", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-compat-"));
	try {
		const report = await checkCompatibility(bridgeReturning(await fixture("compat-ping.json")), root, { version: "0.74.0" });
		assert.deepEqual(report, { ok: true, problems: [] });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("piSubagentsPackageJson points at the pi-subagents manifest", () => {
	assert.match(piSubagentsPackageJson(), /pi-subagents[/\\]package\.json$/);
});

test("watchCompatibility notifies once after the first turn", async () => {
	const root = await statusRoot({ lifecycleArtifactVersion: 2 });
	const previousRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
	process.env.PI_SUBAGENTS_TEMP_ROOT = root;
	try {
		const handlers: Array<() => Promise<void>> = [];
		const notifications: string[] = [];
		const pi = {
			on(event: string, handler: () => Promise<void>): () => void {
				assert.equal(event, "turn_end");
				handlers.push(handler);
				return () => {};
			},
		} as unknown as ExtensionAPI;
		const ctx = { ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionContext;
		watchCompatibility(pi, bridgeReturning(await fixture("compat-ping.json")), ctx);
		assert.equal(handlers.length, 1);
		// A second session in the same process must not subscribe again.
		watchCompatibility(pi, bridgeReturning({}), ctx);
		assert.equal(handlers.length, 1);
		await handlers[0]();
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /^fugue: pi-subagents \S+ differs from what Fugue expects: .+ \(\/fugue doctor\)$/);
	} finally {
		if (previousRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
		else process.env.PI_SUBAGENTS_TEMP_ROOT = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

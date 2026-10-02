import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import type { Activity, MessageEdge, ScoreSnapshot, Voice, VoiceState } from "../src/types.ts";
import { TERMINAL_STATES } from "../src/types.ts";
import { finishedLine, finishedVoices, liveVoices } from "../src/ui/format.ts";
import { layoutGraph } from "../src/ui/graph.ts";
import { layoutTree } from "../src/ui/panel.ts";
import { layoutScoreLine } from "../src/ui/score-line.ts";
import { assertFits, darkTheme } from "./helpers.ts";

const NOW = Date.now();
const WIDTHS = [40, 80, 120, 200];
const BUDGET_MS = 20;
const RIFF_COUNT = 40;
/** The panel caps at 60% of terminal rows; 24 lines is a 40-row terminal. */
const PANEL_HEIGHT = 24;
const STATES: VoiceState[] = ["queued", "running", "blocked", "paused", "done", "failed", "stopped"];
const ACTIVITIES: Activity[] = [
	{ kind: "reading", detail: "src/auth/middleware.ts" },
	{ kind: "writing", detail: "src/db/schema.ts" },
	{ kind: "running", detail: "npm test -- --runInBand" },
	{ kind: "searching" },
	{ kind: "delegating" },
	{ kind: "thinking" },
];

/** Forty riffs in every state, some nested under earlier riffs, with edges and finished ones. */
function scaleSnapshot(): ScoreSnapshot {
	const voices: Voice[] = [];
	const edges: MessageEdge[] = [];
	for (let index = 0; index < RIFF_COUNT; index += 1) {
		const state = STATES[index % STATES.length];
		const runId = `run-${index}`;
		const startedAt = NOW - 300_000 + index * 3_000;
		const nested = index >= 6 && index % 5 === 4;
		const parent = nested ? `run-${index - 4}` : "conductor";
		const terminal = TERMINAL_STATES.has(state);
		// Half the settled riffs are recent (still on the diagram), half are old (finished line).
		const endedAt = terminal ? (index % 2 === 0 ? startedAt + 60_000 : NOW - 600_000) : undefined;
		const blocked = state === "blocked";
		voices.push({
			runId,
			name: `riff-${index}`,
			role: index % 3 === 0 ? "reviewer" : "worker",
			model: index % 2 === 0 ? "opencode-go/deepseek-v4.1-flash" : "claude-opus-5-5",
			thinking: "medium",
			task: `Scale check ${index}: keep every Score surface inside its width`,
			parent,
			origin: index % 4 === 0 ? "subagent" : "fugue",
			state,
			startedAt,
			...(endedAt !== undefined ? { endedAt } : {}),
			...(state === "running" ? { activity: ACTIVITIES[index % ACTIVITIES.length] } : {}),
			...(blocked ? { question: { id: `q-${index}`, message: "Postgres or SQLite?", at: NOW - 90_000 } } : {}),
			tokens: { input: 10_000 + index * 100, output: 2_000 + index * 10, total: 12_000 + index * 110 },
			costUsd: 0.01 + index * 0.001,
			toolCount: index,
			context: { used: 40_000 + index * 1_000, limit: 1_000_000 },
			...(state === "failed" ? { error: "TS2307: Cannot find module './schema'" } : {}),
			...(state === "done" ? { summary: `scale riff ${index} done` } : {}),
		});
		if (blocked) edges.push({ from: runId, to: "conductor", kind: "asked", at: NOW - 90_000, text: "Postgres or SQLite?" });
	}
	edges.push(
		{ from: "conductor", to: "run-1", kind: "steered", at: NOW - 60_000, text: "keep the response shape" },
		{ from: "run-9", to: "run-25", kind: "told", at: NOW - 30_000, text: "focus on the refresh path" },
		{ from: "conductor", to: "run-3", kind: "told", at: NOW - 10_000, text: "match the footer spacing" },
	);
	return { conductor: { model: "claude-opus-5-5", thinking: "medium" }, voices, edges, version: 1 };
}

test("every Score surface fits its width with 40 mixed riffs", () => {
	const theme = darkTheme();
	const snapshot = scaleSnapshot();
	const live = liveVoices(snapshot.voices, NOW);
	const finished = finishedVoices(snapshot.voices, NOW);
	assert.equal(snapshot.voices.length, RIFF_COUNT);
	assert.ok(finished.length > 0, "no finished riffs to draw");
	assert.ok(live.length > RIFF_COUNT / 2, `only ${live.length} riffs stay on the diagram`);

	for (const width of WIDTHS) {
		const line = layoutScoreLine(snapshot, { width, now: NOW, theme });
		assert.equal(line.length, 1);
		assertFits(line, width, `score line @${width}`);

		const options = { width, height: PANEL_HEIGHT, selected: snapshot.voices[0].runId, now: NOW, theme };
		const graph = layoutGraph(snapshot, options);
		assertFits(graph, width, `graph @${width}`);
		assert.ok(graph.length <= options.height);
		const tree = layoutTree(snapshot, options);
		assertFits(tree, width, `tree @${width}`);
		assert.ok(tree.length <= options.height);

		const finishedLineText = finishedLine(theme, finished, width);
		assertFits([finishedLineText], width, `finished line @${width}`);
	}
});

test("every Score renderer stays under the 20 ms budget after warm-up", () => {
	const theme = darkTheme();
	const snapshot = scaleSnapshot();
	const options = { width: 120, height: PANEL_HEIGHT, selected: snapshot.voices[0].runId, now: NOW, theme };
	const renderers: Array<{ name: string; render: () => string[] }> = [];
	for (const width of WIDTHS) {
		renderers.push({ name: `score line @${width}`, render: () => layoutScoreLine(snapshot, { width, now: NOW, theme }) });
		renderers.push({ name: `graph @${width}`, render: () => layoutGraph(snapshot, { ...options, width }) });
		renderers.push({ name: `tree @${width}`, render: () => layoutTree(snapshot, { ...options, width }) });
	}
	const finished = finishedVoices(snapshot.voices, NOW);
	for (const width of WIDTHS) {
		renderers.push({ name: `finished line @${width}`, render: () => [finishedLine(theme, finished, width)] });
	}
	// Warm the layout and the theme up, then take the median of three renders: one GC
	// pause must not fail a budget.
	for (const { render } of renderers) {
		render();
		render();
	}
	for (const { name, render } of renderers) {
		const samples: number[] = [];
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const start = performance.now();
			render();
			samples.push(performance.now() - start);
		}
		samples.sort((a, b) => a - b);
		const median = samples[1];
		assert.ok(median < BUDGET_MS, `${name} took ${median.toFixed(1)} ms (budget ${BUDGET_MS} ms)`);
	}
});

function runningStatus(index: number): unknown {
	return {
		state: "running",
		pid: 10_000 + index,
		cwd: "/work",
		lastUpdate: NOW - 1_000,
		startedAt: NOW - 5_000,
		steps: [
			{
				agent: "worker",
				status: "running",
				currentTool: "read",
				currentPath: `/work/src/file-${index}.ts`,
				tokens: { input: 10, output: 5, total: 15, window: 10 },
			},
		],
	};
}

function completeStatus(index: number): unknown {
	return {
		state: "complete",
		pid: 10_000 + index,
		cwd: "/work",
		lastUpdate: NOW,
		startedAt: NOW - 5_000,
		endedAt: NOW,
		steps: [{ agent: "worker", status: "complete", tokens: { input: 10, output: 5, total: 15, window: 10 } }],
	};
}

test("the store refreshes 40 runs and reuses unchanged files (mtime gate)", async () => {
	const root = await mkdtemp(join(tmpdir(), "fugue-scale-"));
	const store = new Store({
		bridge: { request: async () => ({}) as never },
		conductor: {},
		tempRoot: root,
		now: () => NOW,
		isProcessAlive: () => true,
	});
	try {
		const statusPaths: string[] = [];
		for (let index = 0; index < RIFF_COUNT; index += 1) {
			const runId = `run-${index}`;
			const asyncDir = join(root, "async-subagent-runs", runId);
			await mkdir(asyncDir, { recursive: true });
			const path = join(asyncDir, "status.json");
			await writeFile(path, JSON.stringify(runningStatus(index)));
			store.registerVoice({ runId, name: `riff-${index}`, role: "worker", origin: "fugue", asyncDir });
			statusPaths.push(path);
		}
		await store.refreshAll();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(store.snapshot().voices.filter((voice) => voice.state === "running").length, RIFF_COUNT);

		// New bytes, same mtime: the gate must skip the reread and keep the old state.
		const mtimes = await Promise.all(statusPaths.map(async (path) => (await stat(path)).mtimeMs));
		await Promise.all(
			statusPaths.map(async (path, index) => {
				await writeFile(path, JSON.stringify(completeStatus(index)));
				await utimes(path, mtimes[index] / 1000, mtimes[index] / 1000);
			}),
		);
		await store.refreshAll();
		assert.equal(store.snapshot().voices.filter((voice) => voice.state === "running").length, RIFF_COUNT);

		// A real mtime change is read and applied.
		await writeFile(statusPaths[0], JSON.stringify(completeStatus(0)));
		await store.refreshAll();
		assert.equal(store.voice("run-0")?.state, "done");
		assert.equal(store.snapshot().voices.filter((voice) => voice.state === "running").length, RIFF_COUNT - 1);
	} finally {
		store.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

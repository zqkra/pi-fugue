import { test } from "node:test";
import assert from "node:assert/strict";
import type { Voice } from "../src/types.ts";
import { FIXTURE_NOW } from "./fixtures/snapshots.ts";
import { darkTheme, stripAnsi } from "./helpers.ts";
import {
	activityText,
	activityWord,
	finishedLine,
	finishedVoices,
	liveVoices,
	ageLabel,
	costLabel,
	durationLabel,
	modelLabel,
	stateColor,
	stateGlyph,
	tokenLabel,
} from "../src/ui/format.ts";

test("model labels follow footer.ts", () => {
	assert.equal(modelLabel("claude-opus-5-5"), "Opus 5.5");
	assert.equal(modelLabel("anthropic/claude-sonnet-4-5"), "Sonnet 4.5");
	assert.equal(modelLabel("opencode-go/deepseek-v4.1-flash"), "deepseek-v4.1-flash");
	assert.equal(modelLabel("claude-haiku-4-5[1m]"), "Haiku 4.5");
	assert.equal(modelLabel(undefined), "no model");
});

test("durations read 48s / 4m12s / 1h03m", () => {
	assert.equal(durationLabel(48_000), "48s");
	assert.equal(durationLabel(252_000), "4m12s");
	assert.equal(durationLabel(63_000), "1m03s");
	assert.equal(durationLabel(3_780_000), "1h03m");
	assert.equal(durationLabel(0), "0s");
});

test("tokens and cost", () => {
	assert.equal(tokenLabel(21_000), "21k");
	assert.equal(tokenLabel(3_000), "3k");
	assert.equal(tokenLabel(1_200_000), "1.2M");
	assert.equal(tokenLabel(0), "0");
	assert.equal(tokenLabel(undefined), "—");
	assert.equal(costLabel(0.03), "$0.03");
	assert.equal(costLabel(0), "$0.00");
	assert.equal(costLabel(undefined), "—");
});

test("ages", () => {
	assert.equal(ageLabel(5_000), "just now");
	assert.equal(ageLabel(120_000), "2m00s ago");
});

test("state glyphs are single-cell and non-emoji", () => {
	const states = ["queued", "running", "blocked", "paused", "done", "failed", "stopped"] as const;
	assert.deepEqual(states.map(stateGlyph), ["○", "●", "?", "‖", "✓", "✗", "■"]);
	assert.equal(stateColor("failed"), "error");
	assert.equal(stateColor("blocked"), "warning");
	assert.equal(stateColor("running"), "syntaxVariable");
	assert.equal(stateColor("done"), "success");
});

test("activity words", () => {
	const base: Voice = {
		runId: "r",
		name: "a",
		role: "worker",
		parent: "conductor",
		origin: "fugue",
		state: "running",
		activity: { kind: "writing" },
	};
	assert.equal(activityWord(base, FIXTURE_NOW), "writing");
	assert.equal(activityWord({ ...base, state: "blocked" }, FIXTURE_NOW), "asks");
	assert.equal(activityWord({ ...base, state: "queued" }, FIXTURE_NOW), "queued");
	assert.equal(activityWord({ ...base, state: "done" }, FIXTURE_NOW), "done");
	assert.equal(activityWord({ ...base, state: "failed" }, FIXTURE_NOW), "failed");
});

test("model labels drop the provider and the thinking suffix", () => {
	assert.equal(modelLabel("opencode-go/deepseek-v4.1-flash:low"), "deepseek-v4.1-flash");
	assert.equal(modelLabel("claude-bridge/claude-opus-5-5"), "Opus 5.5");
});

function riff(runId: string, partial: Partial<Voice> = {}): Voice {
	return { runId, name: runId, role: "scout", parent: "conductor", origin: "fugue", state: "running", ...partial };
}

test("a finished tool describes the riff for 15 s, then it is thinking", () => {
	const voice = riff("a", { activity: { kind: "running", detail: "python3 render.py", endedAt: FIXTURE_NOW - 5_000 } });
	assert.equal(activityText(voice, FIXTURE_NOW), "running python3 render.py");
	assert.equal(activityWord(voice, FIXTURE_NOW + 20_000), "thinking");
	const live = riff("b", { activity: { kind: "reading", detail: "src/a.ts" } });
	assert.equal(activityText(live, FIXTURE_NOW + 60_000), "reading src/a.ts", "a tool running now never expires");
});

test("the diagram keeps live riffs and their ancestors; old settled ones leave", () => {
	const voices = [
		riff("parent", { state: "done", endedAt: FIXTURE_NOW - 300_000 }),
		riff("child", { parent: "parent" }),
		riff("old", { state: "done", endedAt: FIXTURE_NOW - 300_000 }),
		riff("fresh", { state: "done", endedAt: FIXTURE_NOW - 10_000 }),
	];
	assert.deepEqual(liveVoices(voices, FIXTURE_NOW).map((voice) => voice.runId), ["parent", "child", "fresh"]);
	assert.deepEqual(finishedVoices(voices, FIXTURE_NOW).map((voice) => voice.runId), ["old"]);
});

test("the finished line fits and counts what it cannot show", () => {
	const finished = Array.from({ length: 8 }, (_v, i) =>
		riff(`riff-${i}`, { state: "done", startedAt: FIXTURE_NOW - 600_000, endedAt: FIXTURE_NOW - 300_000 - i }),
	);
	const line = stripAnsi(finishedLine(darkTheme(), finished, 60));
	assert.ok(line.length <= 60, line);
	assert.ok(line.startsWith(" finished") && /\+\d/.test(line), line);
});

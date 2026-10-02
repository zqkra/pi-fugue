import { test } from "node:test";
import assert from "node:assert/strict";
import type { Voice } from "../src/types.ts";
import {
	activityWord,
	ageLabel,
	costLabel,
	durationLabel,
	modelLabel,
	shortDuration,
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
	assert.equal(shortDuration(48_000), "48s");
	assert.equal(shortDuration(252_000), "4m");
	assert.equal(shortDuration(3_780_000), "1h");
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
	assert.equal(activityWord(base), "writing");
	assert.equal(activityWord({ ...base, state: "blocked" }), "asks");
	assert.equal(activityWord({ ...base, state: "queued" }), "queued");
	assert.equal(activityWord({ ...base, state: "done" }), "done");
	assert.equal(activityWord({ ...base, state: "failed" }), "failed");
});

test("model labels drop the provider and the thinking suffix", () => {
	assert.equal(modelLabel("opencode-go/deepseek-v4.1-flash:low"), "deepseek-v4.1-flash");
	assert.equal(modelLabel("claude-bridge/claude-opus-5-5"), "Opus 5.5");
});

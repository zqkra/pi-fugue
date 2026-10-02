/** Test-only helpers: a real dark Theme and width assertions. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Theme, type ThemeAppearance } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ScoreSnapshot, Voice } from "../src/types.ts";
import { FIXTURE_NOW } from "./fixtures/snapshots.ts";

/** The Pi package linked into node_modules by scripts/link-pi.sh. */
const PI_PKG = join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent");

const BG_TOKENS = new Set([
	"selectedBg",
	"searchMatchBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
]);

let cached: Theme | undefined;

/** The installed dark palette, built the same way the research harness builds it. */
export function darkTheme(): Theme {
	if (cached) return cached;
	const dark = JSON.parse(readFileSync(join(PI_PKG, "dist/modes/interactive/theme/dark.json"), "utf8"));
	const vars = (dark.vars ?? {}) as Record<string, string>;
	const resolve = (value: unknown): unknown => (typeof value === "string" && value in vars ? vars[value] : value);
	const fg: Record<string, unknown> = {};
	const bg: Record<string, unknown> = {};
	for (const [token, value] of Object.entries(dark.colors)) {
		(BG_TOKENS.has(token) ? bg : fg)[token] = resolve(value);
	}
	cached = new Theme(
		fg as unknown as ConstructorParameters<typeof Theme>[0],
		bg as unknown as ConstructorParameters<typeof Theme>[1],
		"truecolor",
		{ name: "dark-test", appearance: dark.appearance as ThemeAppearance },
	);
	return cached;
}

export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b_pi:c\u0007/g, "");
}

/** Every line must fit the width or Pi kills the process at render time. */
export function assertFits(lines: string[], width: number, label: string): void {
	for (const [index, line] of lines.entries()) {
		const actual = visibleWidth(line);
		assert.ok(actual <= width, `${label}: line ${index} is ${actual} > ${width}: ${JSON.stringify(stripAnsi(line))}`);
	}
}

/** Move fixture timestamps to the wall clock so components that read Date.now() show the fixture durations. */
export function shiftToNow(snapshot: ScoreSnapshot): ScoreSnapshot {
	const shift = Date.now() - FIXTURE_NOW;
	const move = (value: number | undefined): number | undefined => (value === undefined ? undefined : value + shift);
	const moveVoice = (voice: Voice): Voice => ({
		...voice,
		startedAt: move(voice.startedAt),
		endedAt: move(voice.endedAt),
		question: voice.question ? { ...voice.question, at: voice.question.at + shift } : undefined,
	});
	return {
		...snapshot,
		voices: snapshot.voices.map(moveVoice),
		edges: snapshot.edges.map((edge) => ({ ...edge, at: edge.at + shift })),
	};
}

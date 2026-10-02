/**
 * Renders every fixture at every width, asserts the hard width invariant, and
 * writes the plain-text snapshots the conductor reviews under test/snapshots/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScoreActions } from "../src/types.ts";
import { layoutGraph } from "../src/ui/graph.ts";
import { layoutTree } from "../src/ui/panel.ts";
import { layoutScoreLine } from "../src/ui/score-line.ts";
import { VoiceView } from "../src/ui/voice-view.ts";
import { assertFits, darkTheme, stripAnsi } from "./helpers.ts";
import { FIXTURES, FIXTURE_NOW } from "./fixtures/snapshots.ts";

const WIDTHS = [40, 60, 100, 160];
const SNAPSHOT_DIR = join(import.meta.dirname, "snapshots");

const actions: ScoreActions = {
	tell: async () => "steered",
	resume: async () => "resumed",
	stop: async () => "stopped",
	readOutput: async () => ["+ adding src/auth/middleware.ts", "- removing the legacy check"],
};

test("every renderer fits every fixture at 40/60/100/160 and writes snapshots", () => {
	const theme = darkTheme();
	mkdirSync(SNAPSHOT_DIR, { recursive: true });
	for (const fixture of FIXTURES) {
		const snapshot = fixture.build();
		for (const width of WIDTHS) {
			const compact = layoutScoreLine(snapshot, { width, now: FIXTURE_NOW, theme });
			assertFits(compact, width, `compact ${fixture.name}/${width}`);

			const options = { width, height: 24, selected: snapshot.voices[0]?.runId, now: FIXTURE_NOW, theme };
			const panel = width <= 45 ? layoutTree(snapshot, options) : layoutGraph(snapshot, options);
			assertFits(panel, width, `panel ${fixture.name}/${width}`);

			for (const voice of snapshot.voices) {
				const view = new VoiceView({
					theme,
					rows: 40,
					runId: voice.runId,
					getSnapshot: () => snapshot,
					actions,
					prompt: async () => undefined,
					confirm: async () => false,
					notify: () => {},
					requestRender: () => {},
					done: () => {},
				});
				assertFits(view.render(width), width, `voice ${voice.name}/${width}`);
			}

			const text = [
				`fixture ${fixture.name} · width ${width}`,
				"",
				"=== compact ===",
				...compact.map(stripAnsi).map((line) => line.trimEnd()),
				"",
				"=== panel ===",
				...panel.map(stripAnsi).map((line) => line.trimEnd()),
				"",
			].join("\n");
			writeFileSync(join(SNAPSHOT_DIR, `score-${fixture.name}-${width}.txt`), text);
		}
	}
	assert.ok(FIXTURES.length === 3);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScoreSnapshot } from "../src/types.ts";
import { layoutTree, ScorePanel, TREE_MAX_WIDTH } from "../src/ui/panel.ts";
import { assertFits, darkTheme, shiftToNow, stripAnsi } from "./helpers.ts";
import { fixture5 } from "./fixtures/snapshots.ts";

function panelFor(snapshot: ScoreSnapshot): {
	panel: ScorePanel;
	opened: () => string | undefined;
	closed: () => boolean;
} {
	let opened: string | undefined;
	let closed = false;
	const panel = new ScorePanel({
		theme: darkTheme(),
		rows: () => 40,
		getSnapshot: () => snapshot,
		openVoice: (runId) => {
			opened = runId;
		},
		collapse: () => {
			closed = true;
		},
	});
	return { panel, opened: () => opened, closed: () => closed };
}

test("render uses the tree below 52 columns and the diagram above", () => {
	const { panel } = panelFor(shiftToNow(fixture5()));
	const tree = panel.render(TREE_MAX_WIDTH);
	assert.ok(tree.map(stripAnsi).some((line) => line.includes("├─") || line.includes("└─")));
	assertFits(tree, TREE_MAX_WIDTH, "panel tree");
	const graph = panel.render(100);
	assert.ok(graph.map(stripAnsi).some((line) => line.includes("┌─ conductor")));
	assertFits(graph, 100, "panel graph");
});

test("arrows move selection; up at the top collapses", () => {
	const { panel, closed } = panelFor(shiftToNow(fixture5()));
	assert.equal(panel.selection, 0);
	panel.handleInput("\u001b[B");
	assert.equal(panel.selection, 1);
	panel.handleInput("\u001b[C");
	assert.equal(panel.selection, 2);
	panel.handleInput("\u001b[D");
	assert.equal(panel.selection, 1);
	panel.handleInput("\u001b[A");
	assert.equal(panel.selection, 0);
	panel.handleInput("\u001b[A");
	assert.equal(closed(), true);
});

test("escape closes and enter opens the selected voice", () => {
	const { panel, opened, closed } = panelFor(shiftToNow(fixture5()));
	panel.handleInput("\r");
	assert.equal(opened(), "run-auth");
	panel.handleInput("\u001b");
	assert.equal(closed(), true);
});

test("tree lines fit and show parentage", () => {
	const lines = layoutTree(shiftToNow(fixture5()), {
		width: 40,
		height: 40,
		selected: "run-auth",
		now: Date.now(),
		theme: darkTheme(),
	});
	assertFits(lines, 40, "tree");
	const plain = lines.map(stripAnsi);
	const parent = plain.findIndex((line) => line.includes("auth ") && line.includes("worker"));
	const child = plain.findIndex((line) => line.includes("auth-tests"));
	assert.ok(parent >= 0 && child > parent);
	assert.ok(plain[child].startsWith("│ "), plain[child]);
});

test("tree height cap keeps the selection with markers", () => {
	const lines = layoutTree(shiftToNow(fixture5()), {
		width: 40,
		height: 7,
		selected: "run-scout",
		now: Date.now(),
		theme: darkTheme(),
	});
	assert.ok(lines.length <= 7, `got ${lines.length}`);
	assert.ok(lines.map(stripAnsi).some((line) => line.includes("more")));
});

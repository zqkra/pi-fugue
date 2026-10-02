import { test } from "node:test";
import assert from "node:assert/strict";
import { sliceByColumn } from "@earendil-works/pi-tui";
import { cardWidth, cardsPerRow, cropWindow, layoutGraph } from "../src/ui/graph.ts";
import { assertFits, darkTheme, stripAnsi } from "./helpers.ts";
import { FIXTURE_NOW, fixture1, fixture15, fixture5 } from "./fixtures/snapshots.ts";

const theme = darkTheme();

function render(snapshot: ReturnType<typeof fixture5>, width: number, height = 60, selected?: string): string[] {
	return layoutGraph(snapshot, { width, height, selected, now: FIXTURE_NOW, theme });
}

test("card geometry stays in range", () => {
	assert.equal(cardsPerRow(40), 1);
	assert.equal(cardsPerRow(52), 2);
	assert.equal(cardsPerRow(100), 3);
	assert.equal(cardsPerRow(160), 6);
	for (const width of [52, 60, 100, 160]) {
		const perRow = cardsPerRow(width);
		const card = cardWidth(width, perRow);
		assert.ok(card >= 24 && card <= 30, `card ${card} at ${width}`);
		assert.ok(perRow * card + (perRow - 1) * 2 <= width - 2, `row overflows at ${width}`);
	}
});

test("every line fits at 40/60/100/160 for every fixture", () => {
	for (const build of [fixture1, fixture5, fixture15]) {
		const snapshot = build();
		for (const width of [40, 60, 100, 160]) {
			assertFits(render(snapshot, width), width, `graph ${snapshot.version}/${width}`);
		}
	}
});

test("conductor box, bus, cards and nested cards are drawn", () => {
	const lines = render(fixture5(), 100).map(stripAnsi);
	assert.ok(lines.some((line) => line.includes("┌─ conductor ── Opus 5.5 medium ─┐")));
	assert.ok(lines.some((line) => line.includes("┬") && line.includes("┌")));
	assert.ok(lines.some((line) => line.includes("┴")));
	for (const name of ["auth", "db", "review", "scout", "auth-tests"]) {
		assert.ok(lines.some((line) => line.includes(name)), `missing ${name}`);
	}
});

test("nested voices hang under their parent card", () => {
	const lines = render(fixture5(), 100).map(stripAnsi);
	const parent = lines.findIndex((line) => line.includes("● auth") && line.includes("worker"));
	const child = lines.findIndex((line) => line.includes("auth-tests"));
	assert.ok(parent >= 0 && child > parent);
	assert.equal(lines[parent].indexOf("●"), lines[child].indexOf("●"));
	// The parent's bottom border drops a connector at the child's top connector.
	assert.ok(lines[child - 2].includes("┬"), lines[child - 2]);
	assert.ok(lines[child - 1].includes("┴"), lines[child - 1]);
});

test("selection highlights only the selected card border", () => {
	const bright = theme.getFgAnsi("text");
	const card = cardWidth(100, cardsPerRow(100));
	const lines = render(fixture5(), 100, 60, "run-db");
	const dbContent = lines.findIndex((line) => stripAnsi(line).includes("? db"));
	const authContent = lines.findIndex((line) => stripAnsi(line).includes("● auth") && stripAnsi(line).includes("worker"));
	assert.ok(dbContent > 0 && authContent > 0);
	const dbX = stripAnsi(lines[dbContent]).indexOf("?") - 2;
	const dbTop = sliceByColumn(lines[dbContent - 1], dbX, card);
	assert.ok(dbTop.includes(bright), "selected border is not bright");
	assert.ok(dbTop.includes("┏"), "selected border is not heavy");
	const authTop = sliceByColumn(lines[authContent - 1], 2, card);
	assert.ok(!authTop.includes(bright), "unselected border is bright");
	assert.ok(authTop.includes("┌"), "unselected border is not light");
});

test("height cap crops around the selection with markers", () => {
	const snapshot = fixture15();
	const top = render(snapshot, 100, 12, "run-auth").map(stripAnsi);
	assert.ok(top.length <= 12, `got ${top.length} lines`);
	assertFits(top, 100, "cropped top");
	assert.ok(top.some((line) => line.includes("↓ ") && line.includes("more")), "missing ↓ marker");
	assert.ok(!top.some((line) => line.includes("↑ ")), "unexpected ↑ marker");

	const bottom = render(snapshot, 100, 12, "run-data").map(stripAnsi);
	assert.ok(bottom.length <= 12);
	assertFits(bottom, 100, "cropped bottom");
	assert.ok(bottom.some((line) => line.includes("↑ ") && line.includes("more")), "missing ↑ marker");
});

test("rows wrap and each band joins the trunk", () => {
	const lines = render(fixture15(), 100).map(stripAnsi);
	const buses = lines.filter((line) => line.includes("┬") && /[┌├└]/.test(line));
	assert.ok(buses.length >= 3, `expected wrapped rows, got ${buses.length} buses`);
	const rails = lines.filter((line) => line.startsWith("│") || line.startsWith("┌") || line.startsWith("├") || line.startsWith("└"));
	assert.ok(rails.length > 0, "missing rail in the left margin");
});

test("cropWindow keeps the target visible and counts markers", () => {
	const lengths = [7, 6, 7, 6, 7];
	assert.deepEqual(cropWindow(lengths, 2, 100), { lo: 0, hi: 4 });
	const tight = cropWindow(lengths, 2, 9);
	assert.ok(tight.lo <= 2 && tight.hi >= 2);
	let sum = 0;
	for (let i = tight.lo; i <= tight.hi; i++) sum += lengths[i];
	sum += (tight.lo > 0 ? 1 : 0) + (tight.hi < lengths.length - 1 ? 1 : 0);
	assert.ok(sum <= 9, `window costs ${sum}`);
});

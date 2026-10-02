import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScoreSnapshot, Voice } from "../src/types.ts";
import { layoutScoreLine, ScoreLineComponent, scoreVisible, visibleVoices } from "../src/ui/score-line.ts";
import { assertFits, darkTheme, stripAnsi } from "./helpers.ts";
import { FIXTURE_NOW, fixture1, fixture5 } from "./fixtures/snapshots.ts";

function voice(partial: Partial<Voice> & Pick<Voice, "runId" | "name" | "state">): Voice {
	return { role: "worker", parent: "conductor", origin: "fugue", ...partial };
}

test("visibility: non-terminal always, settled only for 60s", () => {
	const running = voice({ runId: "r1", name: "auth", state: "running" });
	const blocked = voice({ runId: "r2", name: "db", state: "blocked" });
	const recent = voice({ runId: "r3", name: "scout", state: "done", endedAt: FIXTURE_NOW - 30_000 });
	const old = voice({ runId: "r4", name: "api", state: "failed", endedAt: FIXTURE_NOW - 61_000 });
	const snapshot: ScoreSnapshot = { conductor: {}, voices: [running, blocked, recent, old], edges: [], version: 1 };
	assert.deepEqual(visibleVoices(snapshot, FIXTURE_NOW).map((item) => item.runId), ["r2", "r1", "r3"]);
	assert.equal(scoreVisible(snapshot, FIXTURE_NOW), true);

	const empty: ScoreSnapshot = { conductor: {}, voices: [old], edges: [], version: 2 };
	assert.equal(scoreVisible(empty, FIXTURE_NOW), false);
	assert.deepEqual(layoutScoreLine(empty, { width: 100, now: FIXTURE_NOW, theme: darkTheme() }), []);
});

test("the line degrades and always fits", () => {
	const snapshot = fixture5();
	const theme = darkTheme();
	for (const width of [40, 60, 100, 160]) {
		const lines = layoutScoreLine(snapshot, { width, now: FIXTURE_NOW, theme });
		assert.equal(lines.length, 1);
		assertFits(lines, width, `score-line ${width}`);
	}
	const wide = stripAnsi(layoutScoreLine(snapshot, { width: 200, now: FIXTURE_NOW, theme })[0]);
	assert.ok(wide.includes("asks: Postgres or SQLite?"), wide);
	assert.ok(wide.includes("auth worker writing"), wide);
	const at100 = stripAnsi(layoutScoreLine(snapshot, { width: 100, now: FIXTURE_NOW, theme })[0]);
	assert.ok(at100.includes("asks: Postgres or SQLite?"), at100);
	assert.ok(at100.includes("+3"), at100);
	const at60 = stripAnsi(layoutScoreLine(snapshot, { width: 60, now: FIXTURE_NOW, theme })[0]);
	assert.ok(at60.includes("asks: Postgres or SQLite?"), at60);
	assert.ok(at60.includes("+4"), at60);
	const at40 = stripAnsi(layoutScoreLine(snapshot, { width: 40, now: FIXTURE_NOW, theme })[0]);
	assert.ok(at40.includes("db asks"), at40);
	assert.ok(!at40.includes("Postgres"), at40);
	const narrow = stripAnsi(layoutScoreLine(fixture1(), { width: 12, now: FIXTURE_NOW, theme })[0]);
	assert.ok(narrow.trimStart().startsWith("fugue"), narrow);
});

test("the fallback shows the total voice count", () => {
	const line = stripAnsi(layoutScoreLine(fixture1(), { width: 10, now: FIXTURE_NOW, theme: darkTheme() })[0]);
	assert.equal(line, " fugue  1");
});

test("component caches on version, width and elapsed second", () => {
	let snapshot = fixture1();
	let now = FIXTURE_NOW;
	const component = new ScoreLineComponent({ theme: darkTheme(), getSnapshot: () => snapshot, getNow: () => now });
	const first = component.render(100);
	assert.equal(component.render(100), first);
	now += 1_000;
	const ticked = component.render(100);
	assert.notEqual(ticked, first);
	snapshot = { ...snapshot, version: 2 };
	const changed = component.render(100);
	assert.notEqual(changed, ticked);
	assert.equal(component.render(100), changed);
});

test("a settled voice leaves the line after 60 s even with a cached render", () => {
	const base = fixture1();
	const snapshot = {
		...base,
		voices: base.voices.map((voice) => ({ ...voice, state: "done" as const, endedAt: FIXTURE_NOW - 50_000 })),
	};
	let now = FIXTURE_NOW;
	const component = new ScoreLineComponent({ theme: darkTheme(), getSnapshot: () => snapshot, getNow: () => now });
	assert.equal(component.render(100).length, 1);
	now = FIXTURE_NOW + 11_000;
	assert.equal(component.render(100).length, 0);
});

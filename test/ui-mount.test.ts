import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ScoreActions, ScoreSnapshot, ScoreSource } from "../src/types.ts";
import { mountScore, SCORE_WIDGET_KEY } from "../src/ui/index.ts";
import { assertFits, darkTheme, stripAnsi } from "./helpers.ts";
import { FIXTURE_NOW, fixture1, fixture5 } from "./fixtures/snapshots.ts";

interface FakeTui {
	terminal: { rows: number; columns: number };
	focusedComponent: unknown;
	requestRender(): void;
}

type WidgetFactory = (tui: FakeTui, theme: Theme) => { render(width: number): string[]; invalidate(): void };

const actions: ScoreActions = {
	tell: async () => "ok",
	resume: async () => "ok",
	stop: async () => "ok",
	readOutput: async () => [],
};

function makeSource(initial: ScoreSnapshot): { source: ScoreSource; set(next: ScoreSnapshot): void } {
	let snapshot = initial;
	const listeners = new Set<() => void>();
	return {
		source: {
			snapshot: () => snapshot,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		set(next) {
			snapshot = next;
			for (const listener of listeners) listener();
		},
	};
}

function makeTui(): FakeTui & { renders(): number } {
	let count = 0;
	return {
		terminal: { rows: 40, columns: 100 },
		focusedComponent: makeEditor(),
		requestRender() {
			count++;
		},
		renders: () => count,
	};
}

function makeEditor(): Record<string, unknown> {
	return { render: () => [""], invalidate() {}, handleInput() {}, getText: () => "", setText() {} };
}

interface FakeCustom {
	options?: { overlay?: boolean; overlayOptions?: { width?: string } };
	resolve(value: unknown): void;
}

function makeCtx(mode: "tui" | "rpc" | "json" | "print") {
	const widgets = new Map<string, { factory: WidgetFactory; options?: { placement?: string } }>();
	const handlers: Array<(data: string) => { consume?: boolean } | undefined> = [];
	const custom: FakeCustom[] = [];
	let editorText = "";
	const ui = {
		setWidget(key: string, content: unknown, options?: { placement?: string }) {
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, { factory: content as WidgetFactory, options });
		},
		onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
			handlers.push(handler);
			return () => {
				const index = handlers.indexOf(handler);
				if (index >= 0) handlers.splice(index, 1);
			};
		},
		getEditorText: () => editorText,
		setEditorText(value: string) {
			editorText = value;
		},
		custom(_factory: unknown, options: FakeCustom["options"]) {
			return new Promise<unknown>((resolve) => {
				custom.push({ options, resolve });
			});
		},
		input: async () => undefined,
		confirm: async () => false,
		notify: () => {},
	};
	return {
		ctx: { mode, hasUI: true, ui } as unknown as ExtensionContext,
		widgets,
		handlers,
		custom,
		setEditorText: (value: string) => {
			editorText = value;
		},
	};
}

test("non-tui mounts a no-op handle", async () => {
	const { ctx, widgets, handlers } = makeCtx("print");
	const handle = mountScore({} as ExtensionAPI, ctx, makeSource(fixture1()).source, actions);
	assert.equal(widgets.size, 0);
	assert.equal(handlers.length, 0);
	await handle.openPanel();
	handle.dispose();
});

test("tui mounts the compact widget below the editor", () => {
	const { ctx, widgets } = makeCtx("tui");
	const tui = makeTui();
	const source = makeSource(fixture1());
	const handle = mountScore({} as ExtensionAPI, ctx, source.source, actions);
	const entry = widgets.get(SCORE_WIDGET_KEY);
	assert.ok(entry);
	assert.equal(entry.options?.placement, "belowEditor");

	const component = entry.factory(tui, darkTheme());
	const lines = component.render(100);
	assertFits(lines, 100, "widget");
	assert.ok(stripAnsi(lines[0]).trimStart().startsWith("fugue"), stripAnsi(lines[0]));

	const before = tui.renders();
	source.set({ ...fixture1(), version: 9 });
	assert.ok(tui.renders() > before, "snapshot change did not request a render");

	handle.dispose();
	assert.equal(widgets.has(SCORE_WIDGET_KEY), false);
});

test("arrow-down expands the Score in place only when focused, empty and visible", () => {
	const { ctx, widgets, handlers, custom, setEditorText } = makeCtx("tui");
	const tui = makeTui();
	const source = makeSource(fixture1());
	const handle = mountScore({} as ExtensionAPI, ctx, source.source, actions);
	const component = widgets.get(SCORE_WIDGET_KEY)!.factory(tui, darkTheme());
	const handler = handlers[0];
	assert.ok(handler);
	assert.equal(component.render(100).length, 1, "collapsed is one line");

	assert.deepEqual(handler("\u001b[B"), { consume: true });
	assert.equal(custom.length, 0, "no overlay: the panel expands in place");
	const panel = component.render(100).map(stripAnsi);
	assert.ok(panel.some((line) => line.includes("┌─ conductor")), panel.join("\n"));
	assertFits(component.render(100), 100, "expanded widget");

	assert.deepEqual(handler("\u001b"), { consume: true }, "escape collapses");
	assert.equal(component.render(100).length, 1);

	handler("\u001b[B");
	assert.equal(handler("x"), undefined, "typing collapses and reaches the editor");
	assert.equal(component.render(100).length, 1);

	setEditorText("draft");
	assert.equal(handler("\u001b[B"), undefined, "editor has text");
	setEditorText("");

	tui.focusedComponent = {};
	assert.equal(handler("\u001b[B"), undefined, "editor not focused");
	tui.focusedComponent = makeEditor();

	source.set({ ...fixture1(), voices: [], version: 2 });
	assert.equal(handler("\u001b[B"), undefined, "score line hidden");

	handle.dispose();
	assert.equal(handlers.length, 0);
});

test("the tick runs only while needed and only calls requestRender", () => {
	const realSet = globalThis.setInterval;
	const realClear = globalThis.clearInterval;
	const callbacks: Array<() => void> = [];
	let unrefCalled = false;
	let cleared = 0;
	globalThis.setInterval = ((callback: () => void) => {
		callbacks.push(callback);
		return { unref: () => (unrefCalled = true) };
	}) as unknown as typeof setInterval;
	globalThis.clearInterval = (() => {
		cleared++;
	}) as unknown as typeof clearInterval;
	try {
		const { ctx, widgets } = makeCtx("tui");
		const tui = makeTui();
		const source = makeSource(fixture1());
		const handle = mountScore({} as ExtensionAPI, ctx, source.source, actions);
		widgets.get(SCORE_WIDGET_KEY)!.factory(tui, darkTheme());
		assert.equal(callbacks.length, 1, "no tick while a voice runs");
		assert.equal(unrefCalled, true);

		const before = tui.renders();
		callbacks[0]();
		assert.equal(tui.renders(), before + 1);

		const settled = fixture1();
		source.set({
			...settled,
			voices: settled.voices.map((voice) => ({ ...voice, state: "done", endedAt: FIXTURE_NOW - 120_000 })),
			version: 2,
		});
		assert.equal(cleared, 1, "tick not stopped when everything settled");
		assert.equal(callbacks.length, 1);

		handle.dispose();
	} finally {
		globalThis.setInterval = realSet;
		globalThis.clearInterval = realClear;
	}
});

test("openPanel expands the Score in place", async () => {
	const { ctx, widgets, custom } = makeCtx("tui");
	const handle = mountScore({} as ExtensionAPI, ctx, makeSource(fixture5()).source, actions);
	const component = widgets.get(SCORE_WIDGET_KEY)!.factory(makeTui(), darkTheme());
	await handle.openPanel();
	assert.equal(custom.length, 0);
	assert.ok(component.render(100).length > 1);
	handle.dispose();
});

test("with a footer slot the Score draws there and the widget stays empty", () => {
	const key = Symbol.for("pi.footer-slots.v1");
	const slots = new Map<string, (width: number) => string[]>();
	(globalThis as Record<symbol, unknown>)[key] = slots;
	try {
		const { ctx, widgets } = makeCtx("tui");
		const handle = mountScore({} as ExtensionAPI, ctx, makeSource(fixture1()).source, actions);
		const component = widgets.get(SCORE_WIDGET_KEY)!.factory(makeTui(), darkTheme());
		assert.deepEqual(component.render(100), []);
		const slot = slots.get("fugue");
		assert.ok(slot);
		assert.ok(stripAnsi(slot(100)[0]).includes("fugue"));
		handle.dispose();
		assert.equal(slots.has("fugue"), false);
	} finally {
		delete (globalThis as Record<symbol, unknown>)[key];
	}
});

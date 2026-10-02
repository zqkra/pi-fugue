/**
 * `mountScore` — the only seam between the engine and the Score UI (DESIGN §7).
 * The UI knows a `ScoreSource` and `ScoreActions`; it never imports the store.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { ScoreActions, ScoreSnapshot, ScoreSource } from "../types.ts";
import { TERMINAL_STATES } from "../types.ts";
import { isRecentSettled } from "./format.ts";
import { attachScoreInput } from "./input.ts";
import { ScorePanel } from "./panel.ts";
import { ScoreLineComponent, scoreVisible } from "./score-line.ts";
import { VoiceView } from "./voice-view.ts";

export const SCORE_WIDGET_KEY = "fugue-score";

/**
 * Footer slot contract: a footer that can draw extension rows under its own
 * line publishes this map at load; each entry renders width-clamped lines.
 * The Score uses it when present, so it sits at the bottom edge and the
 * footer stays fixed under the editor.
 */
const FOOTER_SLOTS = Symbol.for("pi.footer-slots.v1");
const SLOT_ID = "fugue";

function footerSlots(): Map<string, (width: number) => string[]> | undefined {
	const slots = (globalThis as Record<symbol, unknown>)[FOOTER_SLOTS];
	return slots instanceof Map ? slots : undefined;
}

export interface ScoreHandle {
	openPanel(): Promise<void>;
	dispose(): void;
}

const VOICE_OVERLAY = { anchor: "center", width: "90%", minWidth: 60, maxHeight: "85%", margin: 1 } as const;

export function mountScore(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	source: ScoreSource,
	actions: ScoreActions,
): ScoreHandle {
	if (ctx.mode !== "tui") return { openPanel: async () => {}, dispose: () => {} };

	let tui: TUI | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let expanded = false;
	let disposed = false;
	const views = new Set<VoiceView>();
	let panel: ScorePanel | undefined;

	const snapshot = (): ScoreSnapshot => source.snapshot();

	function needsTick(): boolean {
		if (views.size > 0) return true;
		const now = Date.now();
		return snapshot().voices.some(
			(voice) => voice.state === "running" || (TERMINAL_STATES.has(voice.state) && isRecentSettled(voice, now)),
		);
	}

	function stopTimer(): void {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	function syncTimer(): void {
		if (disposed) return;
		if (needsTick()) {
			if (timer === undefined) {
				timer = setInterval(onTick, 1000);
				timer.unref?.();
			}
		} else {
			stopTimer();
		}
	}

	function onTick(): void {
		for (const view of views) view.tick();
		syncTimer();
		tui?.requestRender();
	}

	function setExpanded(next: boolean): void {
		if (expanded === next) return;
		expanded = next;
		tui?.requestRender();
	}

	// The widget always mounts, because it is how the Score gets the TUI and theme. When the footer offers a
	// slot, the Score draws there (under the footer) and the widget stays empty.
	ctx.ui.setWidget(
		SCORE_WIDGET_KEY,
		(nextTui, theme) => {
			tui = nextTui;
			const line = new ScoreLineComponent({ theme, getSnapshot: snapshot });
			panel = new ScorePanel({
				theme,
				rows: () => nextTui.terminal.rows,
				getSnapshot: snapshot,
				openVoice: (runId) => void openVoice(runId),
				collapse: () => setExpanded(false),
			});
			const expandedPanel = panel;
			const render = (width: number): string[] => (expanded ? expandedPanel.render(width) : line.render(width));
			const slots = footerSlots();
			slots?.set(SLOT_ID, render);
			return {
				render: slots ? () => [] : render,
				invalidate: () => {
					line.invalidate();
					expandedPanel.invalidate();
				},
			};
		},
		{ placement: "belowEditor" },
	);

	const unsubscribe = source.subscribe(() => {
		syncTimer();
		tui?.requestRender();
	});

	async function openVoice(runId: string): Promise<void> {
		if (disposed) return;
		await ctx.ui.custom<void>(
			(nextTui, theme, _keybindings, done) => {
				const view = new VoiceView({
					theme,
					rows: nextTui.terminal.rows,
					runId,
					getSnapshot: snapshot,
					actions,
					prompt: (title, placeholder) => ctx.ui.input(title, placeholder),
					confirm: (title, message) => ctx.ui.confirm(title, message),
					notify: (message, type) => ctx.ui.notify(message, type),
					requestRender: () => nextTui.requestRender(),
					done: () => done(undefined),
				});
				views.add(view);
				view.refresh();
				return {
					render: (width: number) => view.render(width),
					handleInput: (data: string) => view.handleInput(data),
					invalidate: () => view.invalidate(),
					dispose: () => {
						views.delete(view);
						view.dispose();
						syncTimer();
					},
				};
			},
			{ overlay: true, overlayOptions: VOICE_OVERLAY },
		);
		syncTimer();
	}

	/** `/fugue`: expand the Score in place when there is anything to show. */
	async function openPanel(): Promise<void> {
		if (disposed) return;
		if (snapshot().voices.length === 0) {
			ctx.ui.notify("No riffs in this session yet.", "info");
			return;
		}
		setExpanded(true);
	}

	const detachInput = attachScoreInput({
		ui: ctx.ui,
		getTui: () => tui,
		isVisible: () => scoreVisible(snapshot(), Date.now()),
		isExpanded: () => expanded,
		overlayOpen: () => views.size > 0,
		expand: () => setExpanded(true),
		handleExpanded: (data) => {
			const consumed = panel?.handleInput(data) ?? false;
			tui?.requestRender();
			return consumed;
		},
	});

	syncTimer();

	return {
		openPanel,
		dispose(): void {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			stopTimer();
			detachInput();
			footerSlots()?.delete(SLOT_ID);
			ctx.ui.setWidget(SCORE_WIDGET_KEY, undefined);
			tui = undefined;
		},
	};
}

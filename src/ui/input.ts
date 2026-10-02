/**
 * Key capture for the Score panel. Pi exposes no focus getter on the
 * public TUI type, so the editor is detected structurally — the same probe
 * pi-subagents' FleetView uses. `registerShortcut` is never used for arrows:
 * it would steal cursor movement from the editor.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

/** True when the focused component looks like Pi's editor. */
export function editorHasFocus(tui: unknown): boolean {
	const focused = (tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
	if (!focused || typeof focused !== "object") return false;
	const candidate = focused as Record<string, unknown>;
	return (
		typeof candidate.render === "function" &&
		typeof candidate.invalidate === "function" &&
		typeof candidate.handleInput === "function" &&
		typeof candidate.getText === "function" &&
		typeof candidate.setText === "function"
	);
}

export interface ScoreInputOptions {
	ui: ExtensionUIContext;
	/** The TUI captured from the widget factory; undefined before it mounts. */
	getTui(): unknown;
	/** The Score line is currently visible. */
	isVisible(): boolean;
	isExpanded(): boolean;
	/** A voice view overlay owns the keys. */
	overlayOpen(): boolean;
	expand(): void;
	/** Keys while expanded; returns true when the panel consumed the key. */
	handleExpanded(data: string): boolean;
}

/**
 * Arrow-down on an empty editor expands the Score in place; while expanded the
 * panel gets first look at every key. Returns the unsubscribe function.
 */
export function attachScoreInput(options: ScoreInputOptions): () => void {
	return options.ui.onTerminalInput((data) => {
		if (isKeyRelease(data) || options.overlayOpen()) return undefined;
		if (!editorHasFocus(options.getTui())) return undefined;
		if (options.isExpanded()) return options.handleExpanded(data) ? { consume: true } : undefined;
		if (!matchesKey(data, "down")) return undefined;
		if (options.ui.getEditorText() !== "" || !options.isVisible()) return undefined;
		options.expand();
		return { consume: true };
	});
}

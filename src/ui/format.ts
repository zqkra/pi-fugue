/**
 * Shared labels and glyphs for every Score surface. The functions are pure:
 * the active theme is passed in and nothing themed is cached across renders.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MessageEdge, Voice, VoiceState } from "../types.ts";

/** Settled voices stay on the Score line for this long. */
export const RECENT_SETTLED_MS = 60_000;

const GLYPHS: Record<VoiceState, string> = {
	queued: "○",
	running: "●",
	blocked: "?",
	paused: "‖",
	done: "✓",
	failed: "✗",
	stopped: "■",
};

/**
 * Two channels that never mix: hue says the state, brightness says importance.
 * One hue per state and none shared with Pi's footer (its model label is
 * `accent`): running cyan, asks yellow, done green, failed red, idle grey.
 * Names are bright and bold; roles, times and separators are dim.
 */
const COLORS: Record<VoiceState, ThemeColor> = {
	queued: "dim",
	running: "syntaxVariable",
	blocked: "warning",
	paused: "muted",
	done: "success",
	failed: "error",
	stopped: "muted",
};

export function stateGlyph(state: VoiceState): string {
	return GLYPHS[state];
}

export function stateColor(state: VoiceState): ThemeColor {
	return COLORS[state];
}

/** Glyph in the state's theme color. */
export function stateToken(theme: Theme, state: VoiceState): string {
	return theme.fg(stateColor(state), stateGlyph(state));
}

/** Fugue's mark: a filled chip, a shape nothing else in Pi's bottom rows uses. */
export function brand(theme: Theme): string {
	return theme.bg("selectedBg", theme.fg("text", theme.bold(" fugue ")));
}

/** The activity word in the voice's state hue. */
export function stateWord(theme: Theme, voice: Voice): string {
	return theme.fg(stateColor(voice.state), activityWord(voice));
}

/** The word shown next to a voice: the activity while running, the state otherwise. */
export function activityWord(voice: Voice): string {
	switch (voice.state) {
		case "blocked":
			return "asks";
		case "running":
			return voice.activity?.kind ?? "thinking";
		default:
			return voice.state;
	}
}

/** Footer's model label: `claude-opus-5-5` -> `Opus 5.5`, `some/deepseek-v4.1-flash:low` -> `deepseek-v4.1-flash`. */
export function modelLabel(id: string | undefined): string {
	if (!id) return "no model";
	// The thinking suffix (`:low`) is not part of the model's name.
	const name = id.split("/").pop()?.replace(/\[.*\]$/, "").replace(/:[a-z]+$/, "") ?? id;
	const claude = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(name);
	if (!claude) return name;
	const family = claude[1][0].toUpperCase() + claude[1].slice(1);
	return `${family} ${claude[2].replace("-", ".")}`;
}

/** `48s`, `4m12s`, `1h03m`. */
export function durationLabel(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** `48s`, `4m`, `1h` — the compact-line form. */
export function shortDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h`;
}

export function ageLabel(ms: number): string {
	if (ms < 10_000) return "just now";
	return `${durationLabel(ms)} ago`;
}

/** `21k`, `1.2M`; `—` when the voice has no usage yet. */
export function tokenLabel(total: number | undefined): string {
	if (total === undefined) return "—";
	if (total >= 1_000_000) return `${+(total / 1_000_000).toFixed(1)}M`;
	if (total >= 1_000) return `${Math.round(total / 1_000)}k`;
	return `${total}`;
}

/** `$0.03`; `—` when unknown. */
export function costLabel(costUsd: number | undefined): string {
	if (costUsd === undefined) return "—";
	return `$${costUsd.toFixed(2)}`;
}

/** Elapsed time of a voice: fixed once settled, ticking while it runs. */
export function voiceDuration(voice: Voice, now: number): number | undefined {
	if (voice.startedAt === undefined) return undefined;
	const end = voice.endedAt ?? now;
	return Math.max(0, end - voice.startedAt);
}

export function isRecentSettled(voice: Voice, now: number): boolean {
	return voice.endedAt !== undefined && now - voice.endedAt < RECENT_SETTLED_MS;
}

/**
 * Display order for the panel: top-level voices in roster order, each parent
 * immediately followed by its descendants. Cycles and unknown parents degrade
 * to roster order instead of hanging.
 */
export function orderVoices(voices: readonly Voice[]): Voice[] {
	const ids = new Set(voices.map((voice) => voice.runId));
	const byParent = new Map<string, Voice[]>();
	for (const voice of voices) {
		const parent = voice.parent === "conductor" || !ids.has(voice.parent) ? "" : voice.parent;
		const list = byParent.get(parent) ?? [];
		list.push(voice);
		byParent.set(parent, list);
	}
	const ordered: Voice[] = [];
	const seen = new Set<string>();
	const visit = (parent: string): void => {
		for (const voice of byParent.get(parent) ?? []) {
			if (seen.has(voice.runId)) continue;
			seen.add(voice.runId);
			ordered.push(voice);
			visit(voice.runId);
		}
	};
	visit("");
	for (const voice of voices) {
		if (seen.has(voice.runId)) continue;
		seen.add(voice.runId);
		ordered.push(voice);
	}
	return ordered;
}

/**
 * One message edge, e.g. ` db → conductor  "Postgres or SQLite?"  2m ago`.
 * The quoted text is truncated first so the age always stays whole at the end.
 */
export function edgeLine(
	theme: Theme,
	edge: MessageEdge,
	nameOf: (id: string) => string,
	now: number,
	width: number,
): string {
	const from = theme.fg("text", theme.bold(nameOf(edge.from)));
	const to = theme.fg("text", theme.bold(nameOf(edge.to)));
	const head = ` ${from}${theme.fg("dim", " → ")}${to}`;
	const age = theme.fg("dim", `  ${ageLabel(Math.max(0, now - edge.at))}`);
	let excerpt = "";
	if (edge.text) {
		const room = width - visibleWidth(head) - visibleWidth(age) - 4;
		if (room >= 3) excerpt = `  ${theme.fg("text", `"${truncateToWidth(edge.text, room, "…")}"`)}`;
	}
	return head + excerpt + age;
}

/** `←→↑↓ select · enter open · esc close`. */
export function keyHint(theme: Theme): string {
	const key = (text: string): string => theme.fg("dim", text);
	const label = (text: string): string => theme.fg("muted", text);
	return `${key(" ←→↑↓")}${label(" select")}${key(" · ")}${key("enter")}${label(" open")}${key(" · ")}${key("esc")}${label(" close")}`;
}

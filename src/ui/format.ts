/**
 * Shared labels and glyphs for every Score surface. The functions are pure:
 * the active theme is passed in and nothing themed is cached across renders.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { TERMINAL_STATES, type MessageEdge, type Voice, type VoiceState } from "../types.ts";

/** Settled voices stay on the Score line and in the diagram for this long. */
export const RECENT_SETTLED_MS = 60_000;

/** A finished tool still describes what a voice is doing for this long; after it, the voice is thinking. */
export const TOOL_ACTIVITY_MS = 15_000;

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

/** What the team as a whole needs from the conductor, most urgent first. */
export type Tone = "asks" | "failed" | "working" | "done";

/** The pill's fill per tone. Working shares Pi's accent family; the others are the state hues. */
const TONES: Record<Tone, ThemeColor> = {
	working: "customMessageLabel",
	asks: "warning",
	failed: "error",
	done: "success",
};

export function teamTone(voices: readonly Voice[]): Tone {
	if (voices.some((voice) => voice.state === "blocked")) return "asks";
	if (voices.some((voice) => voice.state === "failed")) return "failed";
	if (voices.every((voice) => TERMINAL_STATES.has(voice.state))) return "done";
	return "working";
}

/** A foreground escape turned into the same color as a background, and back. */
function swapLayer(ansi: string, to: "fg" | "bg"): string {
	return to === "bg"
		? ansi.replace(/\x1b\[38;/, "\x1b[48;").replace(/\x1b\[3(\d)m/, "\x1b[4$1m").replace(/\x1b\[9(\d)m/, "\x1b[10$1m")
		: ansi.replace(/\x1b\[48;/, "\x1b[38;").replace(/\x1b\[4(\d)m/, "\x1b[3$1m").replace(/\x1b\[10(\d)m/, "\x1b[9$1m");
}

/**
 * Fugue's mark: a solid pill in the team's hue with dark text, so the one place
 * the eye lands already says whether anything needs the conductor. Colors come
 * from the active theme; only their layer is swapped.
 */
export function brand(theme: Theme, tone: Tone): string {
	const fill = swapLayer(theme.getFgAnsi(TONES[tone]), "bg");
	const ink = swapLayer(theme.getBgAnsi("toolPendingBg"), "fg");
	return `${fill}${ink}\x1b[1m fugue \x1b[22m\x1b[39m\x1b[49m`;
}

/** Open questions, drawn as edges: the panel shows what is pending, not the history. */
export function openQuestions(voices: readonly Voice[]): MessageEdge[] {
	return voices.flatMap((voice) =>
		voice.state === "blocked" && voice.question
			? [{ from: voice.runId, to: "conductor", kind: "asked" as const, at: voice.question.at, text: voice.question.message }]
			: [],
	);
}

/** `ctx 230k/1M`, the footer's notation: how full one riff's context is. */
export function contextLabel(context: Voice["context"]): string | undefined {
	if (!context) return undefined;
	return `ctx ${tokenLabel(context.used)}${context.limit ? `/${tokenLabel(context.limit)}` : ""}`;
}

/** Same thresholds as the footer: warning from 70 %, error from 90 %. */
export function contextColor(context: Voice["context"]): ThemeColor {
	if (!context?.limit) return "muted";
	const percent = (context.used / context.limit) * 100;
	return percent >= 90 ? "error" : percent >= 70 ? "warning" : "muted";
}

/** The activity word in the voice's state hue. */
export function stateWord(theme: Theme, voice: Voice, now: number): string {
	return theme.fg(stateColor(voice.state), activityWord(voice, now));
}

/** What a running voice is doing now: its tool, or thinking once the last tool is old. */
function currentActivity(voice: Voice, now: number): Voice["activity"] {
	const activity = voice.activity;
	if (!activity || activity.endedAt === undefined || now - activity.endedAt <= TOOL_ACTIVITY_MS) return activity;
	return { kind: "thinking" };
}

/** The word shown next to a voice: the activity while running, the state otherwise. */
export function activityWord(voice: Voice, now: number): string {
	switch (voice.state) {
		case "blocked":
			return "asks";
		case "running":
			return currentActivity(voice, now)?.kind ?? "thinking";
		case "failed":
			return voice.error && /timed out/i.test(voice.error) ? "timed out" : "failed";
		default:
			return voice.state;
	}
}

/** The activity word plus its detail: `running python3 render.py`, `reading src/auth.ts`. */
export function activityText(voice: Voice, now: number): string {
	const word = activityWord(voice, now);
	const detail = voice.state === "running" ? currentActivity(voice, now)?.detail : undefined;
	return detail ? `${word} ${detail}` : word;
}

/**
 * Voices the diagram draws: active ones, ones settled in the last minute, and
 * the ancestors of any of those so the tree never loses a link.
 */
export function liveVoices(voices: readonly Voice[], now: number): Voice[] {
	const byId = new Map(voices.map((voice) => [voice.runId, voice]));
	const keep = new Set<string>();
	for (const voice of voices) {
		if (TERMINAL_STATES.has(voice.state) && !isRecentSettled(voice, now)) continue;
		for (let current: Voice | undefined = voice; current && !keep.has(current.runId); current = byId.get(current.parent)) {
			keep.add(current.runId);
		}
	}
	return voices.filter((voice) => keep.has(voice.runId));
}

/** `finished  ✓ revisa 7m35s · ✗ api 2m40s +3`: the riffs that left the diagram, newest first. */
export function finishedLine(theme: Theme, finished: readonly Voice[], width: number): string {
	const label = theme.fg("dim", " finished  ");
	const parts: string[] = [];
	let used = visibleWidth(label);
	for (const [index, voice] of finished.entries()) {
		const ms = voiceDuration(voice, Date.now());
		const time = ms !== undefined && ms >= 1000 ? ` ${theme.fg("dim", durationLabel(ms))}` : "";
		const part = `${stateToken(theme, voice.state)} ${theme.fg("muted", voice.name)}${time}`;
		const rest = finished.length - index - 1;
		const reserve = rest > 0 ? visibleWidth(` +${rest}`) : 0;
		if (used + visibleWidth(part) + 3 + reserve > width && parts.length > 0) {
			return label + parts.join(theme.fg("dim", " · ")) + theme.fg("dim", ` +${finished.length - index}`);
		}
		parts.push(part);
		used += visibleWidth(part) + 3;
	}
	return truncateToWidth(label + parts.join(theme.fg("dim", " · ")), width);
}

/** Settled voices no longer drawn, newest first. */
export function finishedVoices(voices: readonly Voice[], now: number): Voice[] {
	const live = new Set(liveVoices(voices, now).map((voice) => voice.runId));
	return voices
		.filter((voice) => TERMINAL_STATES.has(voice.state) && !live.has(voice.runId))
		.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
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

/** `48s`, `4m`, `1h`: one riff's time on the Score line. */
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
	// A question to the conductor reads like the Score line: `? schema asks "…"`.
	const head =
		edge.kind === "asked" && edge.to === "conductor"
			? ` ${theme.fg("warning", "?")} ${from} ${theme.fg("warning", "asks")}`
			: ` ${from}${theme.fg("dim", " → ")}${to}`;
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

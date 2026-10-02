/**
 * The one-line Score (DESIGN §5.1): one compact item per riff (state glyph, name,
 * its own time), attention first. Everything else lives behind ↓.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ScoreSnapshot, Voice } from "../types.ts";
import { TERMINAL_STATES } from "../types.ts";
import {
	brand,
	shortDuration,
	stateToken,
	isRecentSettled,
	voiceDuration,
} from "./format.ts";

/** Non-terminal voices plus recently settled ones, in Score-line order. */
export function visibleVoices(snapshot: ScoreSnapshot, now: number): Voice[] {
	const visible = snapshot.voices.filter(
		(voice) => !TERMINAL_STATES.has(voice.state) || isRecentSettled(voice, now),
	);
	return visible.slice().sort((a, b) => rank(a, now) - rank(b, now));
}

export function scoreVisible(snapshot: ScoreSnapshot, now: number): boolean {
	return visibleVoices(snapshot, now).length > 0;
}

function rank(voice: Voice, now: number): number {
	switch (voice.state) {
		case "blocked":
			return 0;
		case "failed":
			return isRecentSettled(voice, now) ? 1 : 6;
		case "running":
			return 2;
		case "paused":
			return 3;
		case "queued":
			return 4;
		default:
			return 5;
	}
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** One riff: state glyph, name, its own short time; a question only when asked to. */
function item(theme: Theme, voice: Voice, now: number, withQuestion: boolean): string {
	const glyph = stateToken(theme, voice.state);
	const attention = voice.state === "blocked" || voice.state === "failed";
	const name = theme.fg(voice.state === "queued" ? "dim" : "text", attention ? theme.bold(voice.name) : voice.name);
	const ms = TERMINAL_STATES.has(voice.state) ? undefined : voiceDuration(voice, now);
	const time = ms !== undefined && ms >= 1000 ? ` ${theme.fg("dim", shortDuration(ms))}` : "";
	if (voice.state !== "blocked") return `${glyph} ${name}${time}`;
	const question = withQuestion && voice.question?.message ? theme.fg("text", `: ${singleLine(voice.question.message)}`) : "";
	return `${glyph} ${name} ${theme.fg("warning", "asks")}${question}${time}`;
}

export interface ScoreLineOptions {
	width: number;
	now: number;
	theme: Theme;
}

/**
 * Themed, width-clamped Score line; empty when nothing is worth showing.
 * `fugue  ? db asks: …  ● auth 4m  ● review 1m  ✓ scout │ 3 done │ ↓`: one item per
 * riff, attention first, details behind ↓. Riffs settled over a minute ago are
 * only counted, so the line stays short without losing them.
 */
export function layoutScoreLine(snapshot: ScoreSnapshot, options: ScoreLineOptions): string[] {
	const { theme, width, now } = options;
	const voices = visibleVoices(snapshot, now);
	if (voices.length === 0) return [];

	const sep = theme.fg("dim", " │ ");
	const shown = new Set(voices.map((voice) => voice.runId));
	const older = snapshot.voices.filter((voice) => TERMINAL_STATES.has(voice.state) && !shown.has(voice.runId));
	const failed = older.filter((voice) => voice.state === "failed").length;
	const done = older.length - failed;
	const counts = [
		...(done > 0 ? [theme.fg("dim", `${done} done`)] : []),
		...(failed > 0 ? [theme.fg("error", `${failed} failed`)] : []),
	];
	const tail = [...(counts.length > 0 ? [counts.join(theme.fg("dim", " · "))] : []), theme.fg("dim", "↓")];

	const compose = (withQuestion: boolean, count: number): string => {
		const items = voices.slice(0, count).map((voice) => item(theme, voice, now, withQuestion));
		const rest = voices.length - count;
		if (rest > 0) items.push(theme.fg("dim", `+${rest}`));
		return [`${brand(theme)} ${items.join("  ")}`, ...tail].join(sep);
	};

	// What needs the conductor wins: drop riffs from the end before dropping the question.
	const candidates: string[] = [];
	for (const withQuestion of [true, false]) {
		for (let count = voices.length; count >= 1; count--) candidates.push(compose(withQuestion, count));
	}
	for (const line of candidates) if (visibleWidth(line) <= width) return [line];
	return [truncateToWidth(compose(false, 1), width)];
}

export interface ScoreLineComponentOptions {
	theme: Theme;
	getSnapshot(): ScoreSnapshot;
	getNow?(): number;
}

/** The mounted widget: caches on (version, width, elapsed second). */
export class ScoreLineComponent {
	private readonly theme: Theme;
	private readonly getSnapshot: () => ScoreSnapshot;
	private readonly getNow: () => number;
	private cachedKey?: string;
	private cachedLines?: string[];

	constructor(options: ScoreLineComponentOptions) {
		this.theme = options.theme;
		this.getSnapshot = options.getSnapshot;
		this.getNow = options.getNow ?? Date.now;
	}

	invalidate(): void {
		this.cachedKey = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const now = this.getNow();
		const snapshot = this.getSnapshot();
		if (!scoreVisible(snapshot, now)) return [];
		// Elapsed times and the 60 s expiry of settled voices both change with the clock.
		const timed = snapshot.voices.some((voice) => voice.state === "running" || isRecentSettled(voice, now));
		const key = `${snapshot.version}:${width}:${timed ? Math.floor(now / 1000) : 0}`;
		if (key === this.cachedKey && this.cachedLines) return this.cachedLines;
		this.cachedKey = key;
		this.cachedLines = layoutScoreLine(snapshot, { width, now, theme: this.theme });
		return this.cachedLines;
	}
}

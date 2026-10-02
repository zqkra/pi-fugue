/**
 * The one-line Score shown under the editor (DESIGN §5.1). It lists the voices
 * that matter now — non-terminal ones and voices settled in the last minute —
 * and drops detail from richest to most compact until the line fits.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ScoreSnapshot, Voice } from "../types.ts";
import { TERMINAL_STATES } from "../types.ts";
import {
	brand,
	durationLabel,
	isRecentSettled,
	shortDuration,
	stateColor,
	stateToken,
	stateWord,
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

function timeOf(theme: Theme, voice: Voice, now: number, short: boolean): string {
	const ms = voiceDuration(voice, now);
	if (ms === undefined || ms < 1000) return "";
	return " " + theme.fg("dim", short ? shortDuration(ms) : durationLabel(ms));
}

/** Glyph, name, role, activity and full duration. */
function richSegment(theme: Theme, voice: Voice, now: number): string {
	const glyph = stateToken(theme, voice.state);
	const name = theme.fg("text", theme.bold(voice.name));
	if (voice.state === "blocked") {
		const question = voice.question?.message ? `: ${singleLine(voice.question.message)}` : "";
		return `${glyph} ${name} ${theme.fg("warning", "asks")}${question ? theme.fg("text", question) : ""}`;
	}
	const role = voice.role && voice.role !== voice.name ? ` ${theme.fg("muted", voice.role)}` : "";
	if (voice.state === "done" || voice.state === "failed" || voice.state === "stopped") {
		return `${glyph} ${name}${role}${timeOf(theme, voice, now, false)}`;
	}
	const word = stateWord(theme, voice);
	return `${glyph} ${name}${role} ${word}${timeOf(theme, voice, now, false)}`;
}

/** Glyph, name, activity and full duration; roles and questions dropped. */
function mediumSegment(theme: Theme, voice: Voice, now: number): string {
	const glyph = stateToken(theme, voice.state);
	const name = theme.fg("text", theme.bold(voice.name));
	if (voice.state === "running" || voice.state === "paused") {
		return `${glyph} ${name} ${stateWord(theme, voice)}${timeOf(theme, voice, now, false)}`;
	}
	if (voice.state === "blocked") return `${glyph} ${name} ${theme.fg("warning", "asks")}`;
	return `${glyph} ${name}`;
}

/** Glyph, name and a short duration only while running. */
function compactSegment(theme: Theme, voice: Voice, now: number): string {
	const running = voice.state === "running" || voice.state === "paused";
	return `${stateToken(theme, voice.state)} ${theme.fg("text", theme.bold(voice.name))}${running ? timeOf(theme, voice, now, true) : ""}`;
}

function countPart(theme: Theme, voices: Voice[], label: string, color: ThemeColor): string {
	return `${theme.fg(color, String(voices.length))} ${theme.fg("muted", label)}`;
}

/** `1 asks · 2 running · 1 done`. */
function countsSegment(theme: Theme, voices: Voice[]): string {
	const of = (state: Voice["state"]): Voice[] => voices.filter((voice) => voice.state === state);
	const parts: string[] = [];
	const add = (state: Voice["state"], label: string, color: ThemeColor): void => {
		const list = of(state);
		if (list.length > 0) parts.push(countPart(theme, list, label, color));
	};
	add("blocked", "asks", "warning");
	add("failed", "failed", "error");
	add("running", "running", stateColor("running"));
	add("paused", "paused", "muted");
	add("queued", "queued", "dim");
	add("done", "done", "success");
	add("stopped", "stopped", "muted");
	return parts.join(theme.fg("dim", " · "));
}

export interface ScoreLineOptions {
	width: number;
	now: number;
	theme: Theme;
}

/** Themed, width-clamped Score line; empty when nothing is worth showing. */
export function layoutScoreLine(snapshot: ScoreSnapshot, options: ScoreLineOptions): string[] {
	const { theme, width, now } = options;
	const voices = visibleVoices(snapshot, now);
	if (voices.length === 0) return [];

	const sep = theme.fg("dim", " │ ");
	const hint = theme.fg("dim", "↓");
	const tag = brand(theme);
	const plus = (count: number): string => (count > 0 ? sep + theme.fg("dim", `+${count}`) : "");

	// Richest tier first; inside a tier take the longest prefix that fits.
	const tiers = [richSegment, mediumSegment, compactSegment];
	for (const tier of tiers) {
		const chosen: string[] = [];
		for (const voice of voices) {
			const remaining = voices.length - chosen.length - 1;
			const candidate = [tag, ...chosen, tier(theme, voice, now)].join(sep) + plus(remaining) + sep + hint;
			if (visibleWidth(candidate) > width) break;
			chosen.push(tier(theme, voice, now));
		}
		if (chosen.length > 0) {
			return [truncateToWidth([tag, ...chosen].join(sep) + plus(voices.length - chosen.length) + sep + hint, width)];
		}
	}

	// Last resort: one summary, then just the total.
	const counts = [tag, countsSegment(theme, voices), hint].join(sep);
	if (visibleWidth(counts) <= width) return [truncateToWidth(counts, width)];
	return [truncateToWidth(`${tag} ${theme.fg("text", String(snapshot.voices.length))}`, width)];
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

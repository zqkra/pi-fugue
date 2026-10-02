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
	stateColor,
	costLabel,
	spend,
	teamTone,
	tokenLabel,
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

/** `● 12 working · 3 queued · longest auth 14m`: many riffs read as one, plus the one worth watching. */
function summary(theme: Theme, working: readonly Voice[], now: number, withLongest: boolean): string {
	const running = working.filter((voice) => voice.state !== "queued");
	const queued = working.length - running.length;
	const parts = [`${theme.fg(stateColor("running"), "●")} ${theme.fg("text", `${running.length} working`)}`];
	if (queued > 0) parts.push(theme.fg("dim", `${queued} queued`));
	const longest = running.reduce<Voice | undefined>(
		(best, voice) => ((voiceDuration(voice, now) ?? 0) > (best ? voiceDuration(best, now) ?? 0 : -1) ? voice : best),
		undefined,
	);
	const ms = longest ? voiceDuration(longest, now) : undefined;
	if (withLongest && longest && ms !== undefined && ms >= 1000) {
		parts.push(`${theme.fg("dim", "longest")} ${theme.fg("text", longest.name)} ${theme.fg("dim", shortDuration(ms))}`);
	}
	return parts.join(theme.fg("dim", " · "));
}

/**
 * Themed, width-clamped Score line; empty when nothing is worth showing.
 * `fugue  ? db asks: …  ✗ api │ ● auth 4m  ● review 1m │ 562k · $0.41 │ ↓`
 * Built for many riffs: what needs the conductor by name, the rest one by one
 * while they fit and as one summary when they do not, then what it costs.
 * Space runs out in this order: recent ✓, the per-riff list, the longest riff, the cost, the question text.
 */
export function layoutScoreLine(snapshot: ScoreSnapshot, options: ScoreLineOptions): string[] {
	const { theme, width, now } = options;
	const voices = visibleVoices(snapshot, now);
	if (voices.length === 0) return [];

	const sep = theme.fg("dim", " │ ");
	const head = brand(theme, teamTone(voices));
	const attention = voices.filter((voice) => voice.state === "blocked" || voice.state === "failed");
	const working = voices.filter((voice) => !TERMINAL_STATES.has(voice.state) && voice.state !== "blocked");
	const recent = voices.filter((voice) => voice.state === "done" || voice.state === "stopped");
	const total = spend(snapshot.voices);
	const cost = total.costUsd > 0 ? `${theme.fg("dim", " · ")}${theme.fg("text", costLabel(total.costUsd))}` : "";
	const spent = total.tokens > 0 ? `${theme.fg("muted", tokenLabel(total.tokens))}${cost}` : "";
	const hint = theme.fg("dim", "↓");

	type Rest = "list+recent" | "list" | "summary" | "count";
	const compose = (withQuestion: boolean, withSpend: boolean, rest: Rest): string => {
		const front = attention.map((voice) => item(theme, voice, now, withQuestion));
		const team =
			(rest === "summary" || rest === "count") && working.length > 1
				? [summary(theme, working, now, rest === "summary")]
				: [...working, ...(rest === "list+recent" ? recent : [])].map((voice) => item(theme, voice, now, false));
		const body = [...front, ...team].join("  ");
		return [`${head} ${body}`.trimEnd(), ...(withSpend && spent ? [spent] : []), hint].join(sep);
	};

	const rests: Rest[] = ["list+recent", "list", "summary", "count"];
	for (const withQuestion of [true, false]) {
		for (const withSpend of [true, false]) {
			for (const rest of rests) {
				const line = compose(withQuestion, withSpend, rest);
				if (visibleWidth(line) <= width) return [line];
			}
		}
	}
	return [truncateToWidth(compose(false, false, "count"), width)];
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

/**
 * The expanded Score panel: key handling, the height cap, and the narrow tree
 * fallback used when cards cannot sit two per row.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ScoreSnapshot, Voice } from "../types.ts";
import {
	durationLabel,
	openQuestions,
	finishedLine,
	finishedVoices,
	isRecentSettled,
	liveVoices,
	stateWord,
	edgeLine,
	keyHint,
	modelLabel,
	orderVoices,
	stateToken,
	voiceDuration,
} from "./format.ts";
import { cardsPerRow, cropWindow, layoutGraph } from "./graph.ts";

export const TREE_MAX_WIDTH = 51;

export interface TreeOptions {
	width: number;
	height: number;
	selected?: string;
	now: number;
	theme: Theme;
}

function parentKey(voice: Voice, ids: ReadonlySet<string>): string {
	return voice.parent === "conductor" || !ids.has(voice.parent) ? "" : voice.parent;
}

function siblingMaps(voices: readonly Voice[]): { childrenOf: Map<string, Voice[]>; parentOf: Map<string, string> } {
	const ids = new Set(voices.map((voice) => voice.runId));
	const childrenOf = new Map<string, Voice[]>();
	const parentOf = new Map<string, string>();
	for (const voice of voices) {
		const parent = parentKey(voice, ids);
		parentOf.set(voice.runId, parent);
		const list = childrenOf.get(parent) ?? [];
		list.push(voice);
		childrenOf.set(parent, list);
	}
	return { childrenOf, parentOf };
}

function treeRow(theme: Theme, voice: Voice, prefix: string, selected: boolean, now: number): string {
	const name = selected ? theme.bg("selectedBg", theme.fg("text", theme.bold(voice.name))) : theme.fg("text", theme.bold(voice.name));
	const role = voice.role && voice.role !== voice.name ? `  ${theme.fg("muted", voice.role)}` : "";
	const word = `  ${stateWord(theme, voice, now)}`;
	const ms = voiceDuration(voice, now);
	const time = ms !== undefined && ms >= 1000 ? ` ${theme.fg("dim", durationLabel(ms))}` : "";
	return `${theme.fg(selected ? "text" : "dim", prefix)}${stateToken(theme, voice.state)} ${name}${role}${word}${time}`;
}

function edgeNameOf(snapshot: ScoreSnapshot): (id: string) => string {
	return (id) => (id === "conductor" ? "conductor" : snapshot.voices.find((voice) => voice.runId === id)?.name ?? id);
}

/** Tree list for narrow terminals: `├─● auth  worker  writing 4m12s`. */
export function layoutTree(snapshot: ScoreSnapshot, options: TreeOptions): string[] {
	const { theme, width, now } = options;
	const clamp = (line: string): string => truncateToWidth(line, width);
	const ordered = orderVoices(snapshot.voices);
	const { childrenOf, parentOf } = siblingMaps(snapshot.voices);
	const byId = new Map(ordered.map((voice) => [voice.runId, voice]));
	const hasLaterSibling = (voice: Voice): boolean => {
		const siblings = childrenOf.get(parentOf.get(voice.runId) ?? "") ?? [];
		return siblings.indexOf(voice) < siblings.length - 1;
	};
	const prefixOf = (voice: Voice): string => {
		const chain: Voice[] = [];
		let parentId = parentOf.get(voice.runId) ?? "";
		while (parentId) {
			const parent = byId.get(parentId);
			if (!parent) break;
			chain.unshift(parent);
			parentId = parentOf.get(parentId) ?? "";
		}
		let prefix = "";
		for (const ancestor of chain) prefix += hasLaterSibling(ancestor) ? "│ " : "  ";
		return `${prefix}${hasLaterSibling(voice) ? "├─" : "└─"}`;
	};

	const info = snapshot.conductor.model
		? modelLabel(snapshot.conductor.model) + (snapshot.conductor.thinking ? ` ${snapshot.conductor.thinking}` : "")
		: "no model";
	const lines: string[] = [` ${theme.fg("muted", "conductor")}${theme.fg("dim", " · ")}${theme.fg("text", info)}`];
	if (ordered.length === 0) lines.push(clamp(theme.fg("dim", " no riffs")));

	const selectedIndex = options.selected ? ordered.findIndex((voice) => voice.runId === options.selected) : -1;
	const rows = ordered.map((voice, index) => treeRow(theme, voice, prefixOf(voice), index === selectedIndex, now));

	const edgeCount = Math.max(0, Math.min(3, snapshot.edges.length, options.height - 2 - 1));
	const budget = Math.max(1, options.height - 1 - edgeCount - 1);
	const { lo, hi } = cropWindow(rows.map(() => 1), Math.max(0, selectedIndex), budget);
	if (lo > 0) lines.push(clamp(theme.fg("dim", ` ↑ ${lo} more`)));
	for (let i = lo; i <= hi && i < rows.length; i++) lines.push(clamp(rows[i]));
	if (hi < rows.length - 1) lines.push(clamp(theme.fg("dim", ` ↓ ${rows.length - 1 - hi} more`)));

	const nameOf = edgeNameOf(snapshot);
	for (const edge of snapshot.edges.slice(-edgeCount)) lines.push(clamp(edgeLine(theme, edge, nameOf, now, width)));
	lines.push(clamp(keyHint(theme)));
	return lines.slice(0, Math.max(1, options.height));
}

export interface ScorePanelOptions {
	theme: Theme;
	/** Terminal rows, read at render time so resizes apply. */
	rows(): number;
	getSnapshot(): ScoreSnapshot;
	openVoice(runId: string): void;
	collapse(): void;
}

/** In-place expanded panel under the editor: the node diagram, selection and keys. */
export class ScorePanel {
	private readonly theme: Theme;
	private readonly rows: () => number;
	private readonly getSnapshot: () => ScoreSnapshot;
	private readonly openVoice: (runId: string) => void;
	private readonly collapse: () => void;
	private selectedIndex = 0;
	private cachedKey?: string;
	private cachedLines?: string[];

	constructor(options: ScorePanelOptions) {
		this.theme = options.theme;
		this.rows = options.rows;
		this.getSnapshot = options.getSnapshot;
		this.openVoice = options.openVoice;
		this.collapse = options.collapse;
	}

	get selection(): number {
		return this.selectedIndex;
	}

	/** The voices on the diagram: settled ones leave it a minute after they finish. */
	private voices(): Voice[] {
		return orderVoices(liveVoices(this.getSnapshot().voices, Date.now()));
	}

	/**
	 * Navigation keys are consumed. Any other key collapses the panel and is left
	 * for the editor, so typing simply resumes.
	 */
	handleInput(data: string): boolean {
		if (matchesKey(data, Key.escape)) {
			this.collapse();
			return true;
		}
		const count = this.voices().length;
		if (matchesKey(data, Key.enter)) {
			const voice = this.voices()[this.selectedIndex];
			if (voice) this.openVoice(voice.runId);
			return true;
		}
		if (matchesKey(data, Key.up)) {
			if (this.selectedIndex <= 0) this.collapse();
			else this.selectedIndex--;
			return true;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) {
			this.selectedIndex = Math.min(Math.max(0, count - 1), this.selectedIndex + 1);
			return true;
		}
		if (matchesKey(data, Key.left)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return true;
		}
		this.collapse();
		return false;
	}

	invalidate(): void {
		this.cachedKey = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const snapshot = this.getSnapshot();
		const now = Date.now();
		const live = liveVoices(snapshot.voices, now);
		const finished = finishedVoices(snapshot.voices, now);
		const voices = orderVoices(live);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, voices.length - 1));
		const selected = voices[this.selectedIndex]?.runId;
		// Elapsed times and the one-minute exit of settled riffs both move with the clock.
		const timed = snapshot.voices.some((voice) => voice.state === "running" || isRecentSettled(voice, now));
		const key = `${snapshot.version}:${width}:${this.selectedIndex}:${timed ? Math.floor(now / 1000) : 0}`;
		if (key === this.cachedKey && this.cachedLines) return this.cachedLines;

		const height = Math.max(4, Math.floor(this.rows() * 0.6)) - (finished.length > 0 ? 1 : 0);
		// Only what is pending: open questions. The message history lives in each riff's view.
		const view = { ...snapshot, voices: live, edges: openQuestions(live) };
		const options = { width, height, selected, now, theme: this.theme };
		const lines = width <= TREE_MAX_WIDTH || cardsPerRow(width) < 2 ? layoutTree(view, options) : layoutGraph(view, options);
		// The finished summary sits just above the key hint.
		if (finished.length > 0) lines.splice(lines.length - 1, 0, finishedLine(this.theme, finished, width));
		this.cachedLines = lines;
		this.cachedKey = key;
		return this.cachedLines;
	}
}

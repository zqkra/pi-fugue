/**
 * The node diagram of the Score panel (DESIGN §5.2). Pure layout: given a
 * snapshot, a width, a line budget and the selected voice it returns themed
 * lines.
 *
 * The conductor box sits on top of a centred trunk. The first top-level row of
 * cards hangs from a bus under the trunk; extra top-level rows branch off a
 * rail that runs down the left margin. Nested voices stack under the card they
 * descend from. The selected card is drawn with heavy box characters plus the
 * accent color, so it is visible without color.
 *
 * Everything is stamped into a character grid so borders and connectors always
 * line up, then painted with theme tokens.
 */

import type { ConductorInfo, ScoreSnapshot, Voice } from "../types.ts";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	activityWord,
	costLabel,
	durationLabel,
	edgeLine,
	keyHint,
	modelLabel,
	stateColor,
	stateGlyph,
	tokenLabel,
	voiceDuration,
} from "./format.ts";

export const CARD_MIN = 24;
export const CARD_MAX = 30;
const GAP = 2;
/** Left margin reserved for the overflow rail. */
const MARGIN = 2;
const CARD_LINES = 6;
const HEADER_LINES = 2;
const ROOT = "conductor";

/** How many cards fit side by side at this width. */
export function cardsPerRow(width: number): number {
	return Math.max(1, Math.floor((width - MARGIN + GAP) / (CARD_MIN + GAP)));
}

/** Card width for a row of `perRow` cards, clamped to the readable range. */
export function cardWidth(width: number, perRow: number): number {
	const available = width - MARGIN;
	return Math.min(CARD_MAX, Math.max(CARD_MIN, Math.floor((available - (perRow - 1) * GAP) / perRow)));
}

/** Plain text clipped for a canvas cell run; `truncateToWidth` adds a reset code. */
function clip(text: string, width: number): string {
	return stripTerminalSequences(truncateToWidth(text, width, "…"));
}

function conductorText(info: ConductorInfo): string {
	return info.model ? modelLabel(info.model) + (info.thinking ? ` ${info.thinking}` : "") : "no model";
}

interface Ink {
	ch: string;
	color?: ThemeColor;
	bold?: boolean;
}

class Canvas {
	readonly cols: number;
	private readonly theme: Theme;
	private readonly cells: Ink[][];

	constructor(cols: number, rows: number, theme: Theme) {
		this.cols = cols;
		this.theme = theme;
		this.cells = Array.from({ length: rows }, () =>
			Array.from({ length: cols }, () => ({ ch: " " }) as Ink),
		);
	}

	put(x: number, y: number, ch: string, color?: ThemeColor, bold?: boolean): void {
		if (x < 0 || x >= this.cols || y < 0 || y >= this.cells.length) return;
		const cell = this.cells[y][x];
		cell.ch = ch;
		cell.color = color;
		cell.bold = bold;
	}

	text(x: number, y: number, text: string, color?: ThemeColor, bold?: boolean): number {
		let cursor = x;
		for (const ch of text) {
			this.put(cursor, y, ch, color, bold);
			cursor += Math.max(1, visibleWidth(ch));
		}
		return cursor;
	}

	hline(x: number, y: number, length: number, ch: string, color?: ThemeColor): void {
		for (let i = 0; i < length; i++) this.put(x + i, y, ch, color);
	}

	render(): string[] {
		return this.cells.map((row) => {
			let out = "";
			let run = "";
			let color: ThemeColor | undefined;
			let bold = false;
			const flush = (): void => {
				if (!run) return;
				const themed = color ? this.theme.fg(color, run) : run;
				out += bold ? this.theme.bold(themed) : themed;
				run = "";
			};
			for (const cell of row) {
				if (cell.color === color && cell.bold === bold) {
					run += cell.ch;
				} else {
					flush();
					color = cell.color;
					bold = cell.bold === true;
					run = cell.ch;
				}
			}
			flush();
			return out;
		});
	}
}

export interface GraphOptions {
	width: number;
	/** Maximum total lines, including conductor, edges and the hint. */
	height: number;
	selected?: string;
	now: number;
	theme: Theme;
}

interface Band {
	roots: Voice[];
	descendants: Voice[][];
	x: number[];
	maxDesc: number;
}

interface Block {
	band: number;
	/** -1 is the bus plus the top-level cards; >= 0 is a descendant strip. */
	strip: number;
	height: number;
	voices: string[];
}

interface Diagram {
	theme: Theme;
	total: number;
	spineCol: number;
	w: number;
	bands: Band[];
	lastBand: number;
	now: number;
	selected?: string;
}

/**
 * Largest contiguous window of weighted rows around `target` that fits
 * `budget`, where a hidden side costs one marker line. Rows are indivisible.
 */
export function cropWindow(lengths: readonly number[], target: number, budget: number): { lo: number; hi: number } {
	const last = lengths.length - 1;
	let lo = Math.max(0, Math.min(target, last));
	let hi = lo;
	const cost = (from: number, to: number): number => {
		let sum = 0;
		for (let i = from; i <= to; i++) sum += lengths[i];
		if (from > 0) sum += 1;
		if (to < last) sum += 1;
		return sum;
	};
	for (;;) {
		let moved = false;
		if (lo > 0 && cost(lo - 1, hi) <= budget) {
			lo--;
			moved = true;
		}
		if (hi < last && cost(lo, hi + 1) <= budget) {
			hi++;
			moved = true;
		}
		if (!moved) break;
	}
	return { lo, hi };
}

function borderColor(voice: Voice, selected: boolean): ThemeColor {
	if (selected) return "text";
	if (voice.state === "blocked") return "warning";
	if (voice.state === "failed") return "error";
	return "dim";
}

function drawConductor(canvas: Canvas, spineCol: number, info: ConductorInfo): void {
	const title = "conductor";
	const model = conductorText(info);
	const maxModel = Math.max(1, canvas.cols - (3 + title.length + 4 + 3));
	const infoText = clip(model, maxModel);
	const boxWidth = Math.min(canvas.cols, 3 + title.length + 4 + visibleWidth(infoText) + 3);
	let x = Math.max(0, spineCol - Math.floor(boxWidth / 2));
	if (spineCol < x + 1) x = spineCol - 1;
	if (spineCol > x + boxWidth - 2) x = spineCol - boxWidth + 2;
	x = Math.max(0, Math.min(x, canvas.cols - boxWidth));

	canvas.put(x, 0, "┌", "dim");
	canvas.put(x + 1, 0, "─", "dim");
	canvas.put(x + 2, 0, " ", "dim");
	const afterTitle = canvas.text(x + 3, 0, title, "muted", true);
	const afterRule = canvas.text(afterTitle, 0, " ── ", "dim");
	const afterInfo = canvas.text(afterRule, 0, infoText, "text");
	canvas.text(afterInfo, 0, " ─┐", "dim");

	canvas.put(x, 1, "└", "dim");
	canvas.hline(x + 1, 1, boxWidth - 2, "─", "dim");
	canvas.put(x + boxWidth - 1, 1, "┘", "dim");
	canvas.put(spineCol, 1, "┬", "dim");
}

function drawCard(
	canvas: Canvas,
	x: number,
	y: number,
	w: number,
	voice: Voice,
	options: { theme: Theme; now: number; selected: boolean; connectedAbove: boolean; hasBelow: boolean },
): void {
	const heavy = options.selected;
	const color = borderColor(voice, heavy);
	const center = x + Math.floor(w / 2);
	const inner = w - 4;
	const cx = x + 2;
	const topLeft = heavy ? "┏" : "┌";
	const topRight = heavy ? "┓" : "┐";
	const bottomLeft = heavy ? "┗" : "└";
	const bottomRight = heavy ? "┛" : "┘";
	const horizontal = heavy ? "━" : "─";
	const vertical = heavy ? "┃" : "│";

	canvas.put(x, y, topLeft, color);
	canvas.hline(x + 1, y, w - 2, horizontal, color);
	canvas.put(x + w - 1, y, topRight, color);
	if (options.connectedAbove) canvas.put(center, y, heavy ? "┷" : "┴", color);

	canvas.put(cx, y + 1, stateGlyph(voice.state), stateColor(voice.state));
	canvas.put(cx + 1, y + 1, " ");
	let role = voice.role && voice.role !== voice.name ? voice.role : "";
	if (role && visibleWidth(voice.name) + 1 + visibleWidth(role) > inner - 2) role = "";
	const roleWidth = role ? visibleWidth(role) + 1 : 0;
	const name = clip(voice.name, Math.max(1, inner - 2 - roleWidth));
	canvas.text(cx + 2, y + 1, name, "text", true);
	if (role) canvas.text(cx + inner - visibleWidth(role), y + 1, role, "muted");

	const model = voice.model ? modelLabel(voice.model) : "no model";
	canvas.text(cx, y + 2, clip(model, inner), voice.model ? "text" : "muted");

	canvas.text(cx, y + 3, clip(activityWord(voice), inner), stateColor(voice.state));
	const ms = voiceDuration(voice, options.now);
	const time = ms !== undefined && ms >= 1000 ? durationLabel(ms) : "";
	if (time) canvas.text(cx + inner - visibleWidth(time), y + 3, time, "dim");

	const tokens = tokenLabel(voice.tokens?.total);
	const cost = costLabel(voice.costUsd);
	const empty = tokens === "—" && cost === "—";
	canvas.text(cx, y + 4, clip(empty ? "—" : `${tokens} · ${cost}`, inner), empty ? "dim" : "text");

	for (let dy = 1; dy <= 4; dy++) {
		canvas.put(x, y + dy, vertical, color);
		canvas.put(x + w - 1, y + dy, vertical, color);
	}
	canvas.put(x, y + 5, bottomLeft, color);
	canvas.hline(x + 1, y + 5, w - 2, horizontal, color);
	canvas.put(x + w - 1, y + 5, bottomRight, color);
	if (options.hasBelow) canvas.put(center, y + 5, heavy ? "┯" : "┬", color);
}

type Rail = "none" | "start" | "through" | "end";

function drawBus(canvas: Canvas, y: number, centers: number[], trunkCol: number, rail: Rail): void {
	const first = centers[0];
	const last = centers[centers.length - 1];
	const left = rail === "none" ? first : 0;
	const single = left === last;
	canvas.hline(left, y, last - left + 1, "─", "dim");
	for (const center of centers) {
		if (single && center === trunkCol) continue;
		// The bus ends in corners, not tees, so no line seems to run past the last card.
		const glyph = center === last && !single ? "┐" : center === left && !single ? "┌" : "┬";
		canvas.put(center, y, glyph, "dim");
	}
	if (trunkCol >= 0) {
		if (single) canvas.put(trunkCol, y, "┴", "dim");
		else canvas.put(trunkCol, y, centers.includes(trunkCol) ? "┼" : "┴", "dim");
	}
	if (rail === "start") canvas.put(0, y, "┌", "dim");
	else if (rail === "through") canvas.put(0, y, "├", "dim");
	else if (rail === "end") canvas.put(0, y, "└", "dim");
}

function renderBlock(diagram: Diagram, block: Block): string[] {
	const canvas = new Canvas(diagram.total, block.height, diagram.theme);
	const band = diagram.bands[block.band];
	const rail = block.band < diagram.lastBand;
	if (block.strip < 0) {
		const centers = band.x.map((x) => x + Math.floor(diagram.w / 2));
		const railStyle: Rail = block.band === 0 ? (diagram.bands.length > 1 ? "start" : "none") : rail ? "through" : "end";
		drawBus(canvas, 0, centers, block.band === 0 ? diagram.spineCol : -1, railStyle);
		for (let i = 0; i < band.roots.length; i++) {
			const root = band.roots[i];
			drawCard(canvas, band.x[i], 1, diagram.w, root, {
				theme: diagram.theme,
				now: diagram.now,
				selected: diagram.selected === root.runId,
				connectedAbove: true,
				hasBelow: band.descendants[i].length > 0,
			});
		}
		if (rail) for (let y = 1; y < block.height; y++) canvas.put(0, y, "│", "dim");
	} else {
		for (let i = 0; i < band.roots.length; i++) {
			const voice = band.descendants[i][block.strip];
			if (!voice) continue;
			drawCard(canvas, band.x[i], 0, diagram.w, voice, {
				theme: diagram.theme,
				now: diagram.now,
				selected: diagram.selected === voice.runId,
				connectedAbove: true,
				hasBelow: band.descendants[i][block.strip + 1] !== undefined,
			});
		}
		if (rail) for (let y = 0; y < block.height; y++) canvas.put(0, y, "│", "dim");
	}
	return canvas.render();
}

function markerLine(theme: Theme, total: number, label: string): string {
	const canvas = new Canvas(total, 1, theme);
	canvas.text(Math.max(0, Math.floor((total - visibleWidth(label)) / 2)), 0, label, "dim");
	return canvas.render()[0];
}

function descendantLists(roots: Voice[], byParent: Map<string, Voice[]>): Voice[][] {
	return roots.map((root) => {
		const out: Voice[] = [];
		const seen = new Set<string>([root.runId]);
		const visit = (voice: Voice): void => {
			for (const child of byParent.get(voice.runId) ?? []) {
				if (seen.has(child.runId)) continue;
				seen.add(child.runId);
				out.push(child);
				visit(child);
			}
		};
		visit(root);
		return out;
	});
}

/** Themed, width-clamped lines for the node diagram. */
export function layoutGraph(snapshot: ScoreSnapshot, options: GraphOptions): string[] {
	const { theme, width, now } = options;
	const ids = new Set(snapshot.voices.map((voice) => voice.runId));
	const roots = snapshot.voices.filter((voice) => voice.parent === ROOT || !ids.has(voice.parent));
	const clamp = (line: string): string => truncateToWidth(line, width);

	if (roots.length === 0) {
		const total = Math.max(1, Math.min(width, 40));
		const canvas = new Canvas(total, HEADER_LINES, theme);
		drawConductor(canvas, Math.floor(total / 2), snapshot.conductor);
		const lines = canvas.render().map(clamp);
		lines.push(clamp(theme.fg("dim", " no riffs")));
		lines.push(clamp(keyHint(theme)));
		return lines.slice(0, Math.max(1, options.height));
	}

	const perRow = Math.max(1, Math.min(roots.length, cardsPerRow(width)));
	const w = cardWidth(width, perRow);
	const rowWidth = perRow * w + (perRow - 1) * GAP;
	const total = MARGIN + rowWidth;
	const rowCenter = MARGIN + Math.floor((rowWidth - 1) / 2);
	const firstCenters = Array.from({ length: perRow }, (_value, index) => MARGIN + index * (w + GAP) + Math.floor(w / 2));
	const nearestCenter = firstCenters.reduce((best, center) =>
		Math.abs(center - rowCenter) < Math.abs(best - rowCenter) ? center : best,
	);
	const spineCol = perRow === 1 || Math.abs(nearestCenter - rowCenter) <= 1 ? nearestCenter : rowCenter;

	const byParent = new Map<string, Voice[]>();
	for (const voice of snapshot.voices) {
		const list = byParent.get(voice.parent) ?? [];
		list.push(voice);
		byParent.set(voice.parent, list);
	}

	const bands: Band[] = [];
	for (let start = 0; start < roots.length; start += perRow) {
		const rowRoots = roots.slice(start, start + perRow);
		const descendants = descendantLists(rowRoots, byParent);
		const x = rowRoots.map((_voice, index) => MARGIN + index * (w + GAP));
		bands.push({ roots: rowRoots, descendants, x, maxDesc: Math.max(0, ...descendants.map((list) => list.length)) });
	}

	const blocks: Block[] = [];
	for (let b = 0; b < bands.length; b++) {
		const band = bands[b];
		blocks.push({ band: b, strip: -1, height: 1 + CARD_LINES, voices: band.roots.map((voice) => voice.runId) });
		for (let d = 0; d < band.maxDesc; d++) {
			const voices: string[] = [];
			for (const list of band.descendants) {
				const voice = list[d];
				if (voice) voices.push(voice.runId);
			}
			blocks.push({ band: b, strip: d, height: CARD_LINES, voices });
		}
	}

	let target = 0;
	if (options.selected) {
		const found = blocks.findIndex((block) => block.voices.includes(options.selected!));
		if (found >= 0) target = found;
	}

	const targetHeight = blocks[target]?.height ?? 1;
	const lengths = blocks.map((block) => block.height);
	const last = blocks.length - 1;
	const plan = (edgeCount: number): { lo: number; hi: number } =>
		cropWindow(lengths, target, Math.max(1, options.height - HEADER_LINES - edgeCount - 1));
	const fits = (edgeCount: number, window: { lo: number; hi: number }): boolean => {
		let blocksHeight = 0;
		for (let i = window.lo; i <= window.hi; i++) blocksHeight += lengths[i];
		const markers = (window.lo > 0 ? 1 : 0) + (window.hi < last ? 1 : 0);
		return HEADER_LINES + blocksHeight + markers + edgeCount + 1 <= options.height;
	};
	let edgeCount = Math.max(0, Math.min(3, snapshot.edges.length, options.height - HEADER_LINES - 1 - targetHeight));
	let window = plan(edgeCount);
	while (edgeCount > 0 && !fits(edgeCount, window)) {
		edgeCount--;
		window = plan(edgeCount);
	}
	const { lo, hi } = window;

	const diagram: Diagram = { theme, total, spineCol, w, bands, lastBand: bands.length - 1, now, selected: options.selected };
	const lines: string[] = [];
	const conductorCols = Math.min(
		width,
		Math.max(total, 3 + "conductor".length + 4 + visibleWidth(conductorText(snapshot.conductor)) + 3),
	);
	const conductor = new Canvas(conductorCols, HEADER_LINES, theme);
	drawConductor(conductor, spineCol, snapshot.conductor);
	lines.push(...conductor.render());
	if (lo > 0) lines.push(markerLine(theme, total, `↑ ${lo} more`));
	for (let i = lo; i <= hi; i++) lines.push(...renderBlock(diagram, blocks[i]));
	if (hi < blocks.length - 1) lines.push(markerLine(theme, total, `↓ ${blocks.length - 1 - hi} more`));

	const nameOf = (id: string): string =>
		id === ROOT ? ROOT : snapshot.voices.find((voice) => voice.runId === id)?.name ?? id;
	for (const edge of snapshot.edges.slice(-edgeCount)) lines.push(clamp(edgeLine(theme, edge, nameOf, now, width)));
	lines.push(clamp(keyHint(theme)));
	return lines.map(clamp).slice(0, Math.max(1, options.height));
}

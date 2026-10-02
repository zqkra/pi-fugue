/**
 * The voice view overlay (DESIGN §5.3): everything about one voice — task,
 * question, activity, its message edges and the live output tail — plus the
 * keys to steer, tell or stop it.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ScoreActions, ScoreSnapshot, Voice } from "../types.ts";
import {
	stateWord,
	costLabel,
	durationLabel,
	edgeLine,
	modelLabel,
	stateToken,
	tokenLabel,
	voiceDuration,
} from "./format.ts";

export interface VoiceViewOptions {
	theme: Theme;
	rows: number;
	runId: string;
	getSnapshot(): ScoreSnapshot;
	actions: Pick<ScoreActions, "tell" | "resume" | "stop" | "readOutput">;
	prompt(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	requestRender(): void;
	done(): void;
}

const TASK_LINES = 4;
const QUESTION_LINES = 4;
const ERROR_LINES = 3;
const SUMMARY_LINES = 2;

export class VoiceView {
	private readonly theme: Theme;
	private readonly rows: number;
	private readonly runId: string;
	private readonly getSnapshot: () => ScoreSnapshot;
	private readonly actions: VoiceViewOptions["actions"];
	private readonly prompt: VoiceViewOptions["prompt"];
	private readonly confirm: VoiceViewOptions["confirm"];
	private readonly notify: VoiceViewOptions["notify"];
	private readonly requestRender: () => void;
	private readonly finish: () => void;
	private output: string[] = [];
	private outputError?: string;
	private pending = false;
	private lastRefresh = 0;
	private closed = false;
	private cachedKey?: string;
	private cachedLines?: string[];
	private renderWidth = 0;

	constructor(options: VoiceViewOptions) {
		this.theme = options.theme;
		this.rows = options.rows;
		this.runId = options.runId;
		this.getSnapshot = options.getSnapshot;
		this.actions = options.actions;
		this.prompt = options.prompt;
		this.confirm = options.confirm;
		this.notify = options.notify;
		this.requestRender = options.requestRender;
		this.finish = options.done;
	}

	private voice(): Voice | undefined {
		return this.getSnapshot().voices.find((voice) => voice.runId === this.runId);
	}

	/** Re-read the output tail; at most one request in flight. */
	refresh(): void {
		if (this.closed || this.pending) return;
		this.pending = true;
		this.lastRefresh = Date.now();
		void this.actions
			.readOutput(this.runId, 80)
			.then((lines) => {
				this.output = lines.slice(-80);
				this.outputError = undefined;
			})
			.catch((error: unknown) => {
				this.outputError = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				this.pending = false;
				this.invalidate();
				this.requestRender();
			});
	}

	/** Called by the Score tick: refresh the tail once a second while open. */
	tick(): void {
		if (this.closed) return;
		if (Date.now() - this.lastRefresh >= 1000) this.refresh();
	}

	invalidate(): void {
		this.cachedKey = undefined;
		this.cachedLines = undefined;
	}

	dispose(): void {
		this.closed = true;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.close();
			return;
		}
		if (matchesKey(data, "s")) void this.steer();
		else if (matchesKey(data, "t")) void this.tell();
		else if (matchesKey(data, "x")) void this.stop();
	}

	async steer(): Promise<void> {
		const voice = this.voice();
		if (!voice) return void this.notify("this voice is gone", "warning");
		if (voice.state !== "running") {
			return void this.notify(`${voice.name} is ${voice.state}; only a running voice can be steered`, "warning");
		}
		const message = await this.prompt(`Steer ${voice.name}`, "message");
		if (!message) return;
		await this.run(() => this.actions.tell(voice.runId, message, "steer"));
	}

	async tell(): Promise<void> {
		const voice = this.voice();
		if (!voice) return void this.notify("this voice is gone", "warning");
		const running = voice.state === "running";
		const message = await this.prompt(running ? `Follow up with ${voice.name}` : `Resume ${voice.name}`, "message");
		if (!message) return;
		await this.run(() =>
			running ? this.actions.tell(voice.runId, message, "follow_up") : this.actions.resume(voice.runId, message),
		);
	}

	async stop(): Promise<void> {
		const voice = this.voice();
		if (!voice) return void this.notify("this voice is gone", "warning");
		if (!(await this.confirm(`Stop ${voice.name}`, "Stop this voice?"))) return;
		await this.run(() => this.actions.stop(voice.runId));
	}

	private async run(action: () => Promise<string>): Promise<void> {
		try {
			this.notify(await action());
		} catch (error: unknown) {
			this.notify(error instanceof Error ? error.message : String(error), "error");
		}
		this.invalidate();
		this.requestRender();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.finish();
	}

	/**
	 * Overlays composite over the chat, so every line is padded to the full width
	 * inside a frame; otherwise the transcript shows through the gaps.
	 */
	render(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const border = (text: string): string => this.theme.fg("dim", text);
		const body = this.body(inner);
		const hint = this.theme.fg("dim", "s steer · t tell · x stop · esc close");
		const pad = (line: string): string => {
			const fitted = truncateToWidth(line, inner);
			return border("│ ") + fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted))) + border(" │");
		};
		return [
			border(`┌${"─".repeat(width - 2)}┐`),
			...body.map(pad),
			pad(""),
			pad(hint),
			border(`└${"─".repeat(width - 2)}┘`),
		];
	}

	private body(width: number): string[] {
		const theme = this.theme;
		const snapshot = this.getSnapshot();
		const voice = this.voice();
		const clamp = (line: string): string => truncateToWidth(line, width);
		const now = Date.now();
		this.renderWidth = width;
		if (!voice) return [clamp(theme.fg("dim", " this voice is gone"))];

		const running = voice.state === "running";
		const key = `${snapshot.version}:${width}:${this.output.length}:${this.output.at(-1)?.length ?? 0}:${running ? Math.floor(now / 1000) : 0}`;
		if (key === this.cachedKey && this.cachedLines) return this.cachedLines;

		const ms = voiceDuration(voice, now);
		const header = [
			stateToken(theme, voice.state),
			theme.fg("text", theme.bold(voice.name)),
			theme.fg("muted", voice.role),
			theme.fg(voice.model ? "text" : "muted", voice.model ? modelLabel(voice.model) : "no model"),
			stateWord(theme, voice, now),
			ms !== undefined && ms >= 1000 ? theme.fg("dim", durationLabel(ms)) : "",
			theme.fg("muted", tokenLabel(voice.tokens?.total)),
			theme.fg("muted", costLabel(voice.costUsd)),
		]
			.filter(Boolean)
			.join("  ");

		const lines: string[] = [clamp(` ${header}`)];
		if (voice.task) lines.push(...this.wrapSection("task", voice.task, TASK_LINES, "text"));
		if (voice.question) {
			const label = `${theme.fg("warning", "?")} ${theme.fg("muted", "asks")}`;
			lines.push(...this.wrapSection(label, voice.question.message, QUESTION_LINES, "text"));
		}
		if (voice.activity) {
			const detail = voice.activity.detail ? ` · ${voice.activity.detail}` : "";
			lines.push(clamp(` ${theme.fg("muted", "activity")}  ${theme.fg("text", voice.activity.kind)}${theme.fg("dim", detail)}`));
		}
		if (voice.worktree && voice.worktree.status !== "discarded") {
			const where = voice.worktree.status === "merged" ? theme.fg("success", "merged") : theme.fg("dim", voice.worktree.path);
			lines.push(clamp(` ${theme.fg("muted", "branch")}  ${theme.fg("text", voice.worktree.branch)}  ${where}`));
		}
		if (voice.error) lines.push(...this.wrapSection("error", voice.error, ERROR_LINES, "error"));
		if (voice.summary && !running) lines.push(...this.wrapSection("summary", voice.summary, SUMMARY_LINES, "text"));

		const nameOf = (id: string): string =>
			id === "conductor" ? "conductor" : snapshot.voices.find((item) => item.runId === id)?.name ?? id;
		const edges = snapshot.edges.filter((edge) => edge.from === this.runId || edge.to === this.runId).slice(-3);
		if (edges.length > 0) {
			lines.push(clamp(` ${theme.fg("muted", "messages")}`));
			for (const edge of edges) lines.push(clamp(edgeLine(theme, edge, nameOf, now, width)));
		}

		const maxLines = Math.max(6, Math.floor(this.rows * 0.85) - 5);
		const remaining = Math.max(1, maxLines - lines.length - 1);
		const output = this.output.slice(-remaining);
		lines.push(clamp(` ${theme.fg("muted", "output")}`));
		if (this.outputError) lines.push(clamp(`  ${theme.fg("error", this.outputError)}`));
		else if (output.length === 0) lines.push(clamp(`  ${theme.fg("dim", "(waiting for output)")}`));
		else {
			for (const line of output) {
				lines.push(clamp(`  ${theme.fg("dim", stripTerminalSequences(line))}`));
			}
		}

		this.cachedKey = key;
		this.cachedLines = lines.slice(0, maxLines);
		return this.cachedLines;
	}

	private wrapSection(label: string, text: string, maxLines: number, color: "text" | "error"): string[] {
		const theme = this.theme;
		const prefix = ` ${label}  `;
		const prefixWidth = visibleWidth(prefix);
		const continuation = " ".repeat(prefixWidth);
		const width = Math.max(4, this.renderWidth - prefixWidth);
		const wrapped = wrapTextWithAnsi(theme.fg(color, text.replace(/\s+/g, " ").trim()), width);
		const lines: string[] = [];
		for (let i = 0; i < Math.min(maxLines, wrapped.length); i++) {
			lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
		}
		if (wrapped.length > maxLines && lines.length > 0) {
			lines[lines.length - 1] = `${truncateToWidth(lines[lines.length - 1], Math.max(0, this.renderWidth - 1), "")}…`;
		}
		return lines;
	}
}

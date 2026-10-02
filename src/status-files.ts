/**
 * Filesystem view of one pi-subagents async run: `status.json` (authoritative
 * state), the `events.jsonl` tail (questions), and `output-<n>.log` (live tail).
 * Mapping and activity derivation are pure so tests can run on real fixtures.
 */

import { open, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { Activity, TokenUsage, Voice, VoiceState } from "./types.ts";

export interface StatusStep {
	agent?: string;
	status?: string;
	model?: string;
	thinking?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentPath?: string;
	startedAt?: number;
	endedAt?: number;
	lastActivityAt?: number;
	activityState?: string;
	tokens?: TokenUsage;
	totalCost?: { costUsd?: number };
	error?: string;
	lane?: { key?: string };
}

export interface StatusFile {
	runId?: string;
	state?: string;
	activityState?: string;
	pid?: number;
	cwd?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentPath?: string;
	startedAt?: number;
	endedAt?: number;
	error?: string;
	lastUpdate?: number;
	lastActivityAt?: number;
	totalTokens?: TokenUsage;
	totalCost?: { costUsd?: number };
	lane?: { key?: string };
	steps?: StatusStep[];
}

export interface StatusSnapshot {
	status: StatusFile;
	mtimeMs: number;
	asyncDir: string;
}

export interface VoiceFields {
	/** Mapped lifecycle state, including blocked for needs_attention runs. */
	state: VoiceState;
	activityState?: string;
	laneKey?: string;
	pid?: number;
	model?: string;
	thinking?: string;
	activity?: Activity;
	startedAt?: number;
	endedAt?: number;
	tokens?: TokenUsage;
	costUsd?: number;
	error?: string;
	lastUpdate?: number;
}

export interface PendingQuestion {
	id: string;
	message: string;
	at: number;
}


/** Whether status.json exists at all, for reboot detection. */
export async function statusExists(asyncDir: string): Promise<boolean> {
	try {
		await stat(join(asyncDir, "status.json"));
		return true;
	} catch {
		return false;
	}
}

/** Read status.json, or undefined when it is absent, unchanged, or malformed. */
export async function readStatusFile(asyncDir: string, previousMtimeMs?: number): Promise<StatusSnapshot | undefined> {
	const path = join(asyncDir, "status.json");
	try {
		const info = await stat(path);
		if (previousMtimeMs !== undefined && info.mtimeMs === previousMtimeMs) return undefined;
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(info.size);
			await handle.read(buffer, 0, info.size, 0);
			return { status: JSON.parse(buffer.toString("utf8")) as StatusFile, mtimeMs: info.mtimeMs, asyncDir };
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

export function mapState(state: string | undefined, activityState?: string): VoiceState {
	switch (state) {
		case "queued":
			return "queued";
		case "running":
			return activityState === "needs_attention" ? "blocked" : "running";
		case "paused":
			return "paused";
		case "complete":
			return "done";
		case "failed":
		case "partial":
		case "rejected":
			return "failed";
		case "stopped":
			return "stopped";
		default:
			return "queued";
	}
}

/** Result-payload state: terminal and not always a `status.json` state. */
export function terminalState(state: unknown, success: unknown): VoiceState {
	if (state === "stopped") return "stopped";
	if (state === "paused") return "paused";
	if (state === "failed" || state === "partial" || state === "rejected") return "failed";
	if (state === "complete") return "done";
	return success === false ? "failed" : "done";
}

const READ_TOOLS = new Set(["read", "ls", "cat"]);
const SEARCH_TOOLS = new Set(["grep", "find", "glob", "rg"]);
const WRITE_TOOLS = new Set(["edit", "write", "apply_patch"]);
const DELEGATE_TOOLS = new Set(["subagent", "riff_spawn"]);
const BASH_DETAIL_CHARS = 40;

export interface ActivityInput {
	state?: string;
	activityState?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentPath?: string;
	cwd?: string;
}

export function deriveActivity(input: ActivityInput): Activity | undefined {
	if (input.state !== "running" || input.activityState === "needs_attention") return undefined;
	const tool = input.currentTool;
	if (!tool) return { kind: "thinking" };
	if (READ_TOOLS.has(tool)) return { kind: "reading", detail: pathDetail(input.currentPath, input.cwd) };
	if (WRITE_TOOLS.has(tool)) return { kind: "writing", detail: pathDetail(input.currentPath, input.cwd) };
	if (SEARCH_TOOLS.has(tool)) return { kind: "searching" };
	if (tool === "bash") return { kind: "running", detail: commandDetail(input.currentToolArgs) };
	if (DELEGATE_TOOLS.has(tool)) return { kind: "delegating" };
	return { kind: "thinking" };
}

function tokenUsage(tokens: TokenUsage | undefined): TokenUsage | undefined {
	return tokens ? { input: tokens.input, output: tokens.output, total: tokens.total } : undefined;
}

function pathDetail(currentPath: string | undefined, cwd: string | undefined): string | undefined {
	if (!currentPath) return undefined;
	if (cwd && isAbsolute(currentPath)) return relative(cwd, currentPath) || currentPath;
	return currentPath;
}

function commandDetail(args: unknown): string | undefined {
	if (typeof args !== "string" || !args) return undefined;
	const single = args.replace(/\s+/g, " ").trim();
	return single.length > BASH_DETAIL_CHARS ? single.slice(0, BASH_DETAIL_CHARS) : single;
}

export function readVoiceFields(status: StatusFile): VoiceFields {
	const step = status.steps?.[0];
	const activityState = status.activityState ?? step?.activityState;
	const currentTool = step?.currentTool ?? status.currentTool;
	const currentPath = step?.currentPath ?? status.currentPath;
	const currentToolArgs = step?.currentToolArgs ?? status.currentToolArgs;
	const tokens = tokenUsage(step?.tokens ?? status.totalTokens);
	return {
		state: mapState(status.state, activityState),
		...(activityState ? { activityState } : {}),
		...(status.lane?.key ?? step?.lane?.key ? { laneKey: status.lane?.key ?? step?.lane?.key } : {}),
		...(typeof status.pid === "number" ? { pid: status.pid } : {}),
		...(step?.model ? { model: step.model } : {}),
		...(step?.thinking ? { thinking: step.thinking } : {}),
		activity: deriveActivity({ state: status.state, activityState, currentTool, currentToolArgs, currentPath, cwd: status.cwd }),
		...(step?.startedAt !== undefined || status.startedAt !== undefined ? { startedAt: step?.startedAt ?? status.startedAt } : {}),
		...(step?.endedAt !== undefined || status.endedAt !== undefined ? { endedAt: step?.endedAt ?? status.endedAt } : {}),
		...(tokens ? { tokens } : {}),
		...(step?.totalCost?.costUsd !== undefined || status.totalCost?.costUsd !== undefined
			? { costUsd: step?.totalCost?.costUsd ?? status.totalCost?.costUsd }
			: {}),
		...(step?.error ?? status.error ? { error: step?.error ?? status.error } : {}),
		...(status.lastUpdate !== undefined || status.lastActivityAt !== undefined || step?.lastActivityAt !== undefined
			? { lastUpdate: status.lastUpdate ?? status.lastActivityAt ?? step?.lastActivityAt }
			: {}),
	};
}

const TAIL_READ_BYTES = 64 * 1024;

async function readTailText(path: string, maxBytes: number): Promise<string | undefined> {
	let handle;
	try {
		handle = await open(path, "r");
	} catch {
		return undefined;
	}
	try {
		const info = await handle.stat();
		const start = Math.max(0, info.size - maxBytes);
		const buffer = Buffer.alloc(info.size - start);
		await handle.read(buffer, 0, buffer.length, start);
		let text = buffer.toString("utf8");
		if (start > 0) text = text.slice(text.indexOf("\n") + 1);
		return text;
	} catch {
		return undefined;
	} finally {
		await handle.close();
	}
}

function tailLines(text: string | undefined, lines: number): string[] {
	if (!text) return [];
	const all = text.split("\n");
	while (all.length > 0 && all[all.length - 1] === "") all.pop();
	return lines >= all.length ? all : all.slice(all.length - lines);
}

/** Newest `output-<n>.log` tail, or the last `lines` lines of it. */
export async function readOutputTail(asyncDir: string, lines: number): Promise<string[]> {
	if (lines <= 0) return [];
	let name: string | undefined;
	try {
		const entries = await readdir(asyncDir);
		const outputs = entries
			.filter((entry) => /^output-\d+\.log$/.test(entry))
			.sort((a, b) => outputIndex(a) - outputIndex(b));
		name = outputs[outputs.length - 1];
	} catch {
		return [];
	}
	if (!name) return [];
	return tailLines(await readTailText(join(asyncDir, name), TAIL_READ_BYTES), lines);
}

function outputIndex(name: string): number {
	const match = /^output-(\d+)\.log$/.exec(name);
	return match ? Number(match[1]) : 0;
}

/** Parsed JSON objects from the events.jsonl tail; malformed lines are skipped. */
export async function readEventsTail(asyncDir: string, lines: number): Promise<unknown[]> {
	if (lines <= 0) return [];
	const text = await readTailText(join(asyncDir, "events.jsonl"), TAIL_READ_BYTES);
	if (!text) return [];
	const parsed: unknown[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			parsed.push(JSON.parse(line));
		} catch {
			// A malformed or truncated line is not evidence of anything.
		}
	}
	return lines >= parsed.length ? parsed : parsed.slice(parsed.length - lines);
}

interface ControlRecord {
	type?: string;
	noticeText?: string;
	event?: { type?: string; reason?: string; message?: string; toolCallId?: string; ts?: number };
}

/** Last unanswered `contact_supervisor` request visible in events.jsonl. */
export async function readPendingQuestion(asyncDir: string): Promise<PendingQuestion | undefined> {
	const entries = await readEventsTail(asyncDir, 400);
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i] as ControlRecord;
		if (entry?.type !== "subagent.control") continue;
		const event = entry.event;
		if (event?.type !== "needs_attention" || event.reason !== "supervisor_request") continue;
		const message = typeof event.message === "string" ? event.message : entry.noticeText;
		if (!message) continue;
		const at = typeof event.ts === "number" ? event.ts : 0;
		const id = typeof event.toolCallId === "string" ? event.toolCallId : `q-${i}`;
		return { id, message, at };
	}
	return undefined;
}

/** Everything the store copies from a status read into its public Voice. */
export function applyVoiceFields(voice: Voice, fields: VoiceFields): Voice {
	return {
		...voice,
		state: fields.state,
		...(fields.model ? { model: fields.model } : {}),
		...(fields.thinking ? { thinking: fields.thinking } : {}),
		activity: fields.activity,
		...(fields.startedAt !== undefined ? { startedAt: fields.startedAt } : {}),
		...(fields.endedAt !== undefined ? { endedAt: fields.endedAt } : {}),
		...(fields.tokens ? { tokens: fields.tokens } : {}),
		...(fields.costUsd !== undefined ? { costUsd: fields.costUsd } : {}),
		...(fields.error ? { error: fields.error } : {}),
		...(fields.state === "blocked" ? {} : { question: undefined }),
	};
}

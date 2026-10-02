/**
 * Durable completion notices.
 *
 * pi-subagents runs background voices in detached processes. When the conductor
 * dies before a voice finishes, the runner still writes its result file, but no
 * living watcher owns it, so the completion is never announced. Notices scans
 * the result files of runs owned by dead processes, announces them once, and
 * marks the payload so a later restart cannot announce them again. The session
 * branch is the ledger: every `fugue.notice` message records the run ids it
 * delivered.
 */

import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { ownerIds } from "./owners.ts";
import { resultsDir } from "./paths.ts";
import { TERMINAL_STATES, type RosterView, type VoiceState } from "./types.ts";

export const NOTICE_CUSTOM_TYPE = "fugue.notice";

const PENDING_DIR = "result-pending";
const GRACE_MS = 5_000;
const SCAN_INTERVAL_MS = 5_000;
const MIN_AGE_MS = 5_000;

/** Public result payload written by the pi-subagents runner (unknown fields preserved). */
export interface ResultPayload {
	runId?: unknown;
	id?: unknown;
	sessionId?: unknown;
	completionOwnerId?: unknown;
	notificationDeliveredAt?: unknown;
	state?: unknown;
	success?: unknown;
	timestamp?: unknown;
	durationMs?: unknown;
	asyncDir?: unknown;
	cwd?: unknown;
	sessionFile?: unknown;
	agent?: unknown;
	summary?: unknown;
	error?: unknown;
	results?: unknown;
}

/** Inputs for the pure candidate decision. */
export interface CandidateContext {
	/** Session file path (or bare id) this process is bound to. */
	sessionId: string;
	/** Completion owner ids seen in this process. */
	owners: ReadonlySet<string>;
	now: number;
	fileMtimeMs: number;
	minAgeMs?: number;
}

export interface NoticeVoice {
	runId: string;
	name: string;
	role: string;
	state: VoiceState;
	durationMs?: number;
	summary?: string;
	outputPath?: string;
}

export interface NoticeDetails {
	runIds: string[];
	voices: Array<{ name: string; role: string; state: VoiceState; durationMs?: number }>;
}

interface NoticeTheme {
	fg(token: string, text: string): string;
}

interface ResultFile {
	path: string;
	payload: ResultPayload;
	mtimeMs: number;
}

interface Candidate {
	runId: string;
	paths: string[];
	payload: ResultPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function payloadRunId(payload: ResultPayload): string | undefined {
	return stringValue(payload.runId) ?? stringValue(payload.id);
}

export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

/** The plain one-line summary, also used as the first line of the model-facing content. */
export function noticeLine(voices: readonly NoticeVoice[]): string {
	if (voices.length === 0) return "while away: no completions";
	const parts = voices.map((voice) => {
		const duration = voice.durationMs !== undefined ? ` ${formatDuration(voice.durationMs)}` : "";
		return `${voice.name} ${voice.state}${duration}`;
	});
	return `while away: ${parts.join(" · ")}`;
}

/** Content sent to the model: one block per voice with state, duration, summary and output path. */
export function buildNoticeContent(voices: readonly NoticeVoice[]): string {
	const lines = [noticeLine(voices)];
	for (const voice of voices) {
		const duration = voice.durationMs !== undefined ? ` in ${formatDuration(voice.durationMs)}` : "";
		lines.push("", `${voice.name} (${voice.role}) ${voice.state}${duration}`);
		if (voice.summary) lines.push(voice.summary.trim());
		if (voice.outputPath) lines.push(`output: ${voice.outputPath}`);
	}
	return lines.join("\n");
}

/**
 * Pure candidate filter: same session, not marked delivered, owner not alive in
 * this process, and old enough that a live watcher had its chance.
 */
export function isCandidate(payload: ResultPayload, ctx: CandidateContext): boolean {
	const sessionId = stringValue(payload.sessionId);
	if (!sessionId || sessionId !== ctx.sessionId) return false;
	if (numberValue(payload.notificationDeliveredAt) !== undefined) return false;
	const owner = stringValue(payload.completionOwnerId);
	if (owner && ctx.owners.has(owner)) return false;
	const writtenAt = numberValue(payload.timestamp) ?? ctx.fileMtimeMs;
	return ctx.now - writtenAt >= (ctx.minAgeMs ?? MIN_AGE_MS);
}

/** Run ids already delivered in this session branch, read from `fugue.notice` messages. */
export function extractDeliveredRunIds(entries: readonly unknown[]): Set<string> {
	const delivered = new Set<string>();
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== NOTICE_CUSTOM_TYPE) continue;
		if (!isRecord(entry.details)) continue;
		const runIds = entry.details.runIds;
		if (!Array.isArray(runIds)) continue;
		for (const runId of runIds) {
			if (typeof runId === "string" && runId) delivered.add(runId);
		}
	}
	return delivered;
}

function resultsOf(payload: ResultPayload): Record<string, unknown>[] {
	return Array.isArray(payload.results) ? payload.results.filter(isRecord) : [];
}

function resultState(payload: ResultPayload): VoiceState {
	switch (stringValue(payload.state)) {
		case "complete":
		case "completed":
			return "done";
		case "failed":
		case "partial":
		case "rejected":
			return "failed";
		case "stopped":
			return "stopped";
		case "paused":
			return "paused";
		case "queued":
		case "pending":
			return "queued";
		case "running":
			return "running";
		default:
			return payload.success === true ? "done" : "failed";
	}
}

function payloadSummary(payload: ResultPayload): string | undefined {
	const first = resultsOf(payload)[0];
	return (
		stringValue(payload.summary) ??
		stringValue(payload.error) ??
		stringValue(first?.summary) ??
		stringValue(first?.error)
	);
}

function payloadOutputPath(payload: ResultPayload): string | undefined {
	for (const result of resultsOf(payload)) {
		if (isRecord(result.artifactPaths)) {
			const outputPath = stringValue(result.artifactPaths.outputPath);
			if (outputPath) return outputPath;
		}
		const sessionFile = stringValue(result.sessionFile);
		if (sessionFile) return sessionFile;
	}
	const sessionFile = stringValue(payload.sessionFile);
	if (sessionFile) return sessionFile;
	const asyncDir = stringValue(payload.asyncDir);
	return asyncDir ? join(asyncDir, "output-0.log") : undefined;
}

function noticeVoice(candidate: Candidate, roster: RosterView): NoticeVoice {
	const voice = roster.voice(candidate.runId);
	const payload = candidate.payload;
	const role = voice?.role ?? stringValue(payload.agent) ?? stringValue(resultsOf(payload)[0]?.agent) ?? "voice";
	const durationMs = numberValue(payload.durationMs);
	const summary = payloadSummary(payload);
	const outputPath = payloadOutputPath(payload);
	return {
		runId: candidate.runId,
		name: voice?.name ?? role,
		role,
		state: resultState(payload),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(summary ? { summary } : {}),
		...(outputPath ? { outputPath } : {}),
	};
}

function toNoticeDetails(voices: readonly NoticeVoice[]): NoticeDetails {
	return {
		runIds: voices.map((voice) => voice.runId),
		voices: voices.map(({ name, role, state, durationMs }) => ({
			name,
			role,
			state,
			...(durationMs !== undefined ? { durationMs } : {}),
		})),
	};
}

function themeTokenForState(state: VoiceState): string {
	switch (state) {
		case "done":
			return "success";
		case "failed":
			return "error";
		case "stopped":
			return "muted";
		default:
			return "warning";
	}
}

export function noticeThemeLine(details: NoticeDetails | undefined, theme: NoticeTheme): string {
	const voices = details?.voices ?? [];
	if (voices.length === 0) return theme.fg("dim", "while away: no completions");
	const parts = voices.map((voice) => {
		const duration = voice.durationMs !== undefined ? ` ${theme.fg("dim", formatDuration(voice.durationMs))}` : "";
		return `${theme.fg("text", voice.name)} ${theme.fg(themeTokenForState(voice.state), voice.state)}${duration}`;
	});
	return theme.fg("dim", "while away: ") + parts.join(theme.fg("dim", " · "));
}

function parsePayload(raw: string): ResultPayload | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) ? (parsed as ResultPayload) : undefined;
	} catch {
		return undefined;
	}
}

async function listJsonFiles(dir: string, recursive: boolean): Promise<string[]> {
	try {
		const entries = recursive ? await readdir(dir, { recursive: true }) : await readdir(dir);
		return entries.filter((name) => name.endsWith(".json")).map((name) => join(dir, name));
	} catch {
		return [];
	}
}

/** Public result files plus pending copies; indexes and replay caches are excluded. */
export async function candidateFiles(resultsDir: string): Promise<string[]> {
	return [
		...(await listJsonFiles(resultsDir, false)),
		...(await listJsonFiles(join(resultsDir, PENDING_DIR), true)),
	];
}

async function readResultFile(path: string): Promise<ResultFile | undefined> {
	try {
		const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
		const payload = parsePayload(raw);
		return payload ? { path, payload, mtimeMs: info.mtimeMs } : undefined;
	} catch {
		return undefined;
	}
}

async function findCandidates(dir: string, ctx: CandidateContext, delivered: ReadonlySet<string>): Promise<Candidate[]> {
	const files = await candidateFiles(dir);
	const byRun = new Map<string, Candidate>();
	for (const path of files) {
		if (delivered.has(basename(path, ".json"))) continue;
		const file = await readResultFile(path);
		if (!file) continue;
		const runId = payloadRunId(file.payload) ?? basename(path, ".json");
		if (delivered.has(runId)) continue;
		if (!isCandidate(file.payload, { ...ctx, fileMtimeMs: file.mtimeMs })) continue;
		const existing = byRun.get(runId);
		if (existing) existing.paths.push(path);
		else byRun.set(runId, { runId, paths: [path], payload: file.payload });
	}
	return [...byRun.values()];
}

/** Re-read every copy of a candidate immediately before delivery; drop anything stale. */
async function confirmCandidate(candidate: Candidate, ctx: CandidateContext): Promise<Candidate | undefined> {
	const alive: ResultFile[] = [];
	for (const path of candidate.paths) {
		const file = await readResultFile(path);
		if (!file) continue;
		if ((payloadRunId(file.payload) ?? candidate.runId) !== candidate.runId) continue;
		if (!isCandidate(file.payload, { ...ctx, fileMtimeMs: file.mtimeMs })) continue;
		alive.push(file);
	}
	if (alive.length === 0) return undefined;
	return { runId: candidate.runId, paths: alive.map((file) => file.path), payload: alive[0].payload };
}

/** Best-effort marker write; the branch ledger is what actually prevents redelivery. */
async function markNotified(candidates: readonly Candidate[], at: number): Promise<void> {
	for (const candidate of candidates) {
		for (const path of candidate.paths) {
			try {
				const payload = parsePayload(await readFile(path, "utf8"));
				if (!payload || (payloadRunId(payload) ?? candidate.runId) !== candidate.runId) continue;
				if (numberValue(payload.notificationDeliveredAt) !== undefined) continue;
				const tmp = `${path}.fugue-${process.pid}.tmp`;
				await writeFile(tmp, JSON.stringify({ ...payload, runId: candidate.runId, notificationDeliveredAt: at }));
				await rename(tmp, path);
			} catch {
				// A failed marker only costs one extra read on a later scan.
			}
		}
	}
}

function sessionIdOf(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
}

function hasOrphanedNonTerminal(roster: RosterView, ownedRuns: ReadonlyMap<string, string>): boolean {
	const owners = ownerIds();
	for (const voice of roster.snapshot().voices) {
		if (TERMINAL_STATES.has(voice.state)) continue;
		const owner = ownedRuns.get(voice.runId);
		if (!owner || !owners.has(owner)) return true;
	}
	return false;
}

/**
 * Watch for completions lost to a dead conductor. One scan after a grace
 * window, then one every 5 s while an orphaned non-terminal voice exists.
 * Delivery happens once per batch; the branch message is the ledger.
 */
export function startNotices(pi: ExtensionAPI, ctx: ExtensionContext, roster: RosterView): { dispose(): void } {
	let disposed = false;
	let scanning = false;
	let grace: ReturnType<typeof setTimeout> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const ownedRuns = new Map<string, string>();
	const dir = resultsDir();

	const unsubscribe = pi.events.on("subagent:async-started", (raw) => {
		if (!isRecord(raw)) return;
		const runId = stringValue(raw.id) ?? stringValue(raw.runId);
		const owner = stringValue(raw.completionOwnerId);
		if (runId && owner) ownedRuns.set(runId, owner);
	});

	function reportScanError(error: unknown): void {
		console.error("fugue notices scan failed:", error);
	}

	function syncTimer(): void {
		if (disposed) return;
		if (hasOrphanedNonTerminal(roster, ownedRuns)) {
			if (!timer) {
				timer = setInterval(() => {
					void runScan(false).then(syncTimer, reportScanError);
				}, SCAN_INTERVAL_MS);
				timer.unref?.();
			}
		} else if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	async function runScan(backlog: boolean): Promise<void> {
		if (disposed || scanning) return;
		scanning = true;
		try {
			const now = Date.now();
			const base: CandidateContext = { sessionId: sessionIdOf(ctx), owners: ownerIds(), now, fileMtimeMs: now };
			const delivered = extractDeliveredRunIds(ctx.sessionManager.getBranch());
			const found = await findCandidates(dir, base, delivered);
			if (found.length === 0) return;
			const confirmed: Candidate[] = [];
			for (const candidate of found) {
				const live = await confirmCandidate(candidate, base);
				if (live) confirmed.push(live);
			}
			if (disposed || confirmed.length === 0) return;
			const voices = confirmed.map((candidate) => noticeVoice(candidate, roster));
			pi.sendMessage<NoticeDetails>(
				{
					customType: NOTICE_CUSTOM_TYPE,
					display: true,
					content: buildNoticeContent(voices),
					details: toNoticeDetails(voices),
				},
				{ triggerTurn: !backlog },
			);
			await markNotified(confirmed, Date.now());
		} finally {
			scanning = false;
		}
	}

	grace = setTimeout(() => {
		grace = undefined;
		void runScan(true).then(syncTimer, reportScanError);
	}, GRACE_MS);
	grace.unref?.();

	return {
		dispose() {
			disposed = true;
			unsubscribe();
			if (grace) clearTimeout(grace);
			if (timer) clearInterval(timer);
			grace = undefined;
			timer = undefined;
		},
	};
}

/** One-line renderer for delivered notices. */
export function registerNoticeRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<NoticeDetails>(NOTICE_CUSTOM_TYPE, (message, _options, theme) => {
		const line = noticeThemeLine(message.details, theme);
		return {
			invalidate() {},
			render(width: number) {
				return [truncateToWidth(line, width)];
			},
		};
	});
}

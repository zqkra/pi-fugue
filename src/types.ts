/**
 * Shared contract between Fugue's engine (bridge, store, tools, notices, gates)
 * and its UI (Score line, graph panel, voice view). Change only with care: every
 * module codes against these shapes.
 */

/** Lifecycle of one voice as Fugue presents it. */
export type VoiceState =
	| "queued" // launched, runner not started yet
	| "running" // working; see `activity` for reading/writing/thinking
	| "blocked" // waiting on an answer from the conductor (pending supervisor request)
	| "paused" // interrupted, resumable
	| "done" // pi-subagents state "complete"
	| "failed" // "failed" | "partial" | "rejected"
	| "stopped"; // stopped by the conductor or the owner

export const TERMINAL_STATES: ReadonlySet<VoiceState> = new Set(["done", "failed", "stopped"]);

/** What a running voice is doing right now, derived from its current tool. */
export type ActivityKind = "thinking" | "reading" | "writing" | "running" | "searching" | "delegating";

export interface Activity {
	kind: ActivityKind;
	/** Short detail: a path, a command head, a tool name. Already single-line, untrimmed. */
	detail?: string;
}

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

export interface Voice {
	/** pi-subagents run id (UUID). Stable key. */
	runId: string;
	/** Unique short name within the session, e.g. "auth", "db-scout". Shown first everywhere. */
	name: string;
	/** pi-subagents agent: scout, worker, reviewer, oracle, researcher, ... */
	role: string;
	/** "provider/id" plus optional ":thinking" suffix, as pi-subagents reports it. */
	model?: string;
	thinking?: string;
	/** Task excerpt Fugue saw at spawn (status files redact it). At most 240 chars. */
	task?: string;
	/** "conductor" or the runId of the voice that spawned it (nested runs). */
	parent: string;
	/** Spawned through Fugue's voice tool, or observed from a raw `subagent` call. */
	origin: "fugue" | "subagent";
	state: VoiceState;
	activity?: Activity;
	startedAt?: number;
	endedAt?: number;
	tokens?: TokenUsage;
	costUsd?: number;
	/** pi-subagents async run directory (status.json, events.jsonl, output-0.log). */
	asyncDir?: string;
	/** Pending question from the voice to the conductor (contact_supervisor). */
	question?: { id: string; message: string; at: number };
	/** One-line final summary once settled. */
	summary?: string;
	/** Error text when failed. */
	error?: string;
}

/** A directed connection drawn in the Score. Spawn edges come from `Voice.parent`; these are messages. */
export interface MessageEdge {
	/** Voice runId or "conductor". */
	from: string;
	to: string;
	kind: "asked" | "answered" | "told" | "steered";
	at: number;
	/** One-line excerpt. */
	text?: string;
}

export interface GateCheck {
	name: string;
	command: string;
	ok: boolean;
	exitCode: number | null;
	durationMs: number;
	/** Last lines of combined output, at most 40. */
	tail: string;
	note?: string;
}

export interface GateReport {
	cwd: string;
	at: number;
	ok: boolean;
	checks: GateCheck[];
}

export interface ConductorInfo {
	/** Model id of the conductor session, e.g. "claude-opus-5-5". */
	model?: string;
	thinking?: string;
}

/** Immutable snapshot the UI renders. A new object every time something changes. */
export interface ScoreSnapshot {
	conductor: ConductorInfo;
	/** All voices of this session, oldest first. */
	voices: readonly Voice[];
	edges: readonly MessageEdge[];
	gate?: GateReport;
	/** Monotonic counter, bumps on every change. UI caches on it. */
	version: number;
}

/** Actions the UI can trigger. Implemented by the engine; all resolve to a short human result line. */
export interface ScoreActions {
	tell(runId: string, message: string, mode: "steer" | "follow_up"): Promise<string>;
	stop(runId: string): Promise<string>;
	resume(runId: string, message: string): Promise<string>;
	/** Tail of the voice's live output for the detail view, newest last, at most `lines`. */
	readOutput(runId: string, lines: number): Promise<string[]>;
}

/** What the store exposes to the UI and to the tools. */
export interface ScoreSource {
	snapshot(): ScoreSnapshot;
	/** Subscribe to changes; returns unsubscribe. Called at most once per change batch. */
	subscribe(listener: () => void): () => void;
}

/** Read access to the roster for modules that are not the UI (notices, gates). */
export interface RosterView extends ScoreSource {
	voice(runId: string): Voice | undefined;
}

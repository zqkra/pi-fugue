/**
 * The roster: single source of truth for voices, the Score snapshot, message
 * edges, and the gate report (DESIGN §2 Engine). Mutations rebuild an immutable
 * ScoreSnapshot and notify subscribers once per synchronous batch; active
 * voices are refreshed from `status.json` on a 1 s timer that stops when
 * nothing is non-terminal.
 */

import {
	allocateName,
	fallbackName,
	normalizeName,
	parseName,
} from "./names.ts";
import {
	applyVoiceFields,
	mapState,
	readOutputTail,
	readSupervisorRequest,
	readStatusFile,
	readVoiceFields,
	statusExists,
	terminalState,
	type PendingQuestion,
	type StatusSnapshot,
} from "./status-files.ts";
import { asyncDirForRun } from "./paths.ts";
import {
	TERMINAL_STATES,
	type ConductorInfo,
	type GateReport,
	type MessageEdge,
	type RiffWorktree,
	type RosterView,
	type ScoreActions,
	type ScoreSnapshot,
	type TokenUsage,
	type Voice,
	type VoiceState,
} from "./types.ts";

const DEFAULT_POLL_MS = 1000;
const RUNNER_EXIT_GRACE_MS = 10_000;
const MISSING_RUN_FILES = "run files missing (machine restarted?)";
const MAX_EDGES = 50;
const MAX_TASK_CHARS = 240;
const MAX_ERROR_CHARS = 400;
const EDGE_TEXT_CHARS = 80;

export interface BridgeLike {
	request<T = unknown>(method: string, params?: object, options?: { timeoutMs?: number }): Promise<T>;
}

/** Persisted identity, one `fugue.voice` entry per spawn, revival, or settle. */
export interface VoiceEntry {
	runId: string;
	name: string;
	role: string;
	model?: string;
	task?: string;
	parent: string;
	origin: "fugue" | "subagent";
	startedAt?: number;
	state?: VoiceState;
	endedAt?: number;
	summary?: string;
	error?: string;
	tokens?: TokenUsage;
	costUsd?: number;
	/** The riff's own branch and folder, restored on hydrate. */
	worktree?: RiffWorktree;
}

export interface VoiceRegistration {
	runId: string;
	name: string;
	role: string;
	model?: string;
	task?: string;
	parent?: string;
	origin: "fugue" | "subagent";
	asyncDir?: string;
	startedAt?: number;
	worktree?: RiffWorktree;
}

export interface AsyncStartedPayload {
	id?: unknown;
	asyncDir?: unknown;
	pid?: unknown;
	agent?: unknown;
	completionOwnerId?: unknown;
	parentWorkflowRunId?: unknown;
}

export interface AsyncCompletePayload {
	runId?: unknown;
	id?: unknown;
	state?: unknown;
	success?: unknown;
	summary?: unknown;
	error?: unknown;
	timestamp?: unknown;
	results?: Array<{ usage?: { input?: number; output?: number; cost?: number } }>;
}

export interface ChildStatusPayload {
	runId?: unknown;
	childRunId?: unknown;
	status?: unknown;
}

export interface ControlEventPayload {
	event?: {
		type?: unknown;
		reason?: unknown;
		message?: unknown;
		toolCallId?: unknown;
		ts?: unknown;
		runId?: unknown;
	};
	noticeText?: unknown;
}

export interface ProcessTerminalPayload {
	runId?: unknown;
	state?: unknown;
}

export interface StoreOptions {
	bridge: BridgeLike;
	conductor: ConductorInfo;
	tempRoot: string;
	persist?: (entry: VoiceEntry) => void;
	now?: () => number;
	isProcessAlive?: (pid: number) => boolean;
	pollMs?: number;
	/** Called after a voice settles, for worktree housekeeping. Never allowed to break the roster. */
	onSettled?: (voice: Voice) => void;
}

interface VoiceRecord {
	voice: Voice;
	pid?: number;
	statusMtimeMs?: number;
	lastUpdate?: number;
	/** Registered from a raw event and not yet named from its lane key. */
	provisional: boolean;
	/** A terminal event arrived; a stale status must not resurrect the voice. */
	settledFromEvent: boolean;
	/** Rebuilt from a `fugue.voice` entry; checked once for surviving run files. */
	hydrated: boolean;
}

interface ResumeDetails {
	runId?: unknown;
	asyncDir?: unknown;
}

interface ResumeReply {
	details?: ResumeDetails;
}

export class Store implements RosterView, ScoreActions {
	private readonly options: StoreOptions;
	private readonly voices = new Map<string, VoiceRecord>();
	private readonly listeners = new Set<() => void>();
	private edges: MessageEdge[] = [];
	private gate: GateReport | undefined;
	private version = 0;
	private snapshotValue: ScoreSnapshot;
	private notifyScheduled = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private refreshing: Promise<void> | undefined;
	private disposed = false;

	private readonly now: () => number;
	private readonly isProcessAlive: (pid: number) => boolean;
	private conductor: ConductorInfo;
	private readonly isTaken = (name: string): boolean => {
		for (const record of this.voices.values()) {
			if (record.voice.name === name) return true;
		}
		return false;
	};

	constructor(options: StoreOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.isProcessAlive = options.isProcessAlive ?? processAlive;
		this.conductor = options.conductor;
		this.snapshotValue = { conductor: options.conductor, voices: [], edges: [], version: 0 };
	}

	snapshot(): ScoreSnapshot {
		return this.snapshotValue;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	voice(runId: string): Voice | undefined {
		return this.voices.get(runId)?.voice;
	}

	voiceByName(name: string): Voice | undefined {
		const wanted = normalizeName(name);
		let found: Voice | undefined;
		for (const record of this.voices.values()) {
			if (record.voice.name === wanted) found = record.voice;
		}
		return found;
	}

	polling(): boolean {
		return this.timer !== undefined;
	}

	setGate(report: GateReport): void {
		this.gate = report;
		this.publish();
	}

	/** Follow conductor model/thinking changes during the session. */
	setConductor(info: ConductorInfo): void {
		this.conductor = info;
		this.publish();
	}

	/** Mark the riff's worktree merged or discarded; persisted so hydrate restores it. */
	setWorktreeStatus(runId: string, status: RiffWorktree["status"]): void {
		const record = this.voices.get(runId);
		const worktree = record?.voice.worktree;
		if (!record || !worktree || worktree.status === status) return;
		record.voice = { ...record.voice, worktree: { ...worktree, status } };
		this.persist(record.voice);
		this.publish();
	}

	/** Rebuild the roster from `fugue.voice` entries (latest per runId, oldest first). */
	hydrate(entries: readonly VoiceEntry[]): void {
		const latest = new Map<string, VoiceEntry>();
		for (const entry of entries) {
			if (entry && typeof entry.runId === "string" && typeof entry.name === "string" && typeof entry.role === "string") {
				latest.set(entry.runId, entry);
			}
		}
		for (const entry of latest.values()) {
			if (this.voices.has(entry.runId)) continue;
			const state = entry.state ?? "queued";
			this.voices.set(entry.runId, {
				voice: {
					runId: entry.runId,
					name: entry.name,
					role: entry.role,
					...(entry.model ? { model: entry.model } : {}),
					...(entry.task ? { task: entry.task } : {}),
					parent: entry.parent || "conductor",
					origin: entry.origin === "fugue" ? "fugue" : "subagent",
					state,
					asyncDir: asyncDirForRun(this.options.tempRoot, entry.runId),
					...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
					...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
					...(entry.summary ? { summary: entry.summary } : {}),
					...(entry.error ? { error: entry.error } : {}),
					...(entry.tokens ? { tokens: entry.tokens } : {}),
					...(entry.costUsd !== undefined ? { costUsd: entry.costUsd } : {}),
					...(entry.worktree ? { worktree: entry.worktree } : {}),
				},
				provisional: false,
				settledFromEvent: TERMINAL_STATES.has(state),
				hydrated: true,
			});
		}
		this.ensurePolling();
		this.publish();
	}

	/** Register a voice whose spawn Fugue just issued. */
	registerVoice(registration: VoiceRegistration): void {
		const existing = this.voices.get(registration.runId);
		const base = existing?.voice ?? {
			runId: registration.runId,
			name: registration.name,
			role: registration.role,
			parent: registration.parent ?? "conductor",
			origin: registration.origin,
			state: "queued" as VoiceState,
			asyncDir: registration.asyncDir ?? asyncDirForRun(this.options.tempRoot, registration.runId),
			startedAt: registration.startedAt ?? this.now(),
		};
		const voice: Voice = {
			...base,
			name: registration.name,
			role: registration.role,
			parent: registration.parent ?? base.parent,
			origin: registration.origin,
			asyncDir: registration.asyncDir ?? base.asyncDir,
			...(registration.model ? { model: registration.model } : {}),
			...(registration.task ? { task: truncate(registration.task, MAX_TASK_CHARS) } : {}),
			...(registration.startedAt !== undefined ? { startedAt: registration.startedAt } : {}),
			...(registration.worktree ? { worktree: registration.worktree } : {}),
		};
		this.voices.set(registration.runId, {
			voice,
			pid: existing?.pid,
			statusMtimeMs: existing?.statusMtimeMs,
			lastUpdate: existing?.lastUpdate,
			provisional: false,
			settledFromEvent: false,
			hydrated: false,
		});
		this.persist(voice);
		this.ensurePolling();
		this.publish();
		void this.refreshVoice(registration.runId);
	}

	/** `subagent:async-started`: confirm a Fugue spawn or register a raw run. */
	onAsyncStarted(payload: AsyncStartedPayload): void {
		const runId = typeof payload.id === "string" ? payload.id : undefined;
		if (!runId) return;
		const asyncDir = typeof payload.asyncDir === "string" ? payload.asyncDir : asyncDirForRun(this.options.tempRoot, runId);
		const existing = this.voices.get(runId);
		if (existing) {
			existing.voice = { ...existing.voice, asyncDir };
			if (typeof payload.pid === "number") existing.pid = payload.pid;
			this.publish();
			void this.refreshVoice(runId);
			return;
		}
		const role = typeof payload.agent === "string" && payload.agent ? payload.agent : "agent";
		this.voices.set(runId, {
			voice: {
				runId,
				name: fallbackName(undefined, role, this.isTaken),
				role,
				parent: typeof payload.parentWorkflowRunId === "string" ? payload.parentWorkflowRunId : "conductor",
				origin: "subagent",
				state: "queued",
				asyncDir,
			},
			...(typeof payload.pid === "number" ? { pid: payload.pid } : {}),
			provisional: true,
			settledFromEvent: false,
			hydrated: false,
		});
		this.ensurePolling();
		this.publish();
		void this.refreshVoice(runId);
	}

	/** `subagent:async-complete`: settle with the delivered result payload. */
	onAsyncComplete(payload: AsyncCompletePayload): void {
		const runId = typeof payload.runId === "string" ? payload.runId : typeof payload.id === "string" ? payload.id : undefined;
		if (!runId) return;
		const record = this.voices.get(runId);
		if (!record) return;
		const usage = payload.results?.[0]?.usage;
		this.settle(record, {
			state: terminalState(payload.state, payload.success),
			endedAt: typeof payload.timestamp === "number" ? payload.timestamp : this.now(),
			activity: undefined,
			question: undefined,
			...(typeof payload.summary === "string" && payload.summary.trim() ? { summary: truncate(payload.summary.trim(), MAX_TASK_CHARS) } : {}),
			...(typeof payload.error === "string" && payload.error.trim() ? { error: truncate(payload.error.trim(), MAX_ERROR_CHARS) } : {}),
			...(usage ? { tokens: usageTotals(usage) } : {}),
			...(typeof usage?.cost === "number" ? { costUsd: usage.cost } : {}),
		});
		this.ensurePolling();
		this.publish();
	}

	/** `subagent:child-status`: stop requests/observations settle known children. */
	onChildStatus(payload: ChildStatusPayload): void {
		if (payload.status !== "stopped") return;
		const runId = typeof payload.childRunId === "string" ? payload.childRunId : undefined;
		if (!runId) return;
		const record = this.voices.get(runId);
		if (!record || TERMINAL_STATES.has(record.voice.state)) return;
		this.settle(record, { state: "stopped", activity: undefined, question: undefined, endedAt: this.now() });
		this.ensurePolling();
		this.publish();
	}

	/** `subagent:control-event`: a supervisor request blocks the voice. */
	onControlEvent(payload: ControlEventPayload): void {
		const event = payload.event;
		if (!event || event.reason !== "supervisor_request") return;
		const runId = typeof event.runId === "string" ? event.runId : undefined;
		if (!runId) return;
		const record = this.voices.get(runId);
		if (!record || TERMINAL_STATES.has(record.voice.state)) return;
		const message = typeof event.message === "string" ? event.message : typeof payload.noticeText === "string" ? payload.noticeText : "";
		if (!message) return;
		const at = typeof event.ts === "number" ? event.ts : this.now();
		const id = typeof event.toolCallId === "string" ? event.toolCallId : String(at);
		if (record.voice.question?.id === id) return;
		void this.markBlocked(record, { id, message, at });
	}

	/** `subagent:process-terminal`: re-read status; the pid check handles death. */
	onProcessTerminal(payload: ProcessTerminalPayload): void {
		const runId = typeof payload.runId === "string" ? payload.runId : undefined;
		if (!runId || payload.state !== "observed") return;
		void this.refreshVoice(runId);
	}

	/** Read status.json for every voice once, at session start. */
	async refreshAll(): Promise<void> {
		await Promise.allSettled([...this.voices.keys()].map((runId) => this.refreshVoice(runId)));
	}

	/** Read status.json for non-terminal voices only (poll tick). */
	async refreshActive(): Promise<void> {
		if (this.refreshing) return this.refreshing;
		this.refreshing = (async () => {
			const active = [...this.voices.entries()]
				.filter(([, record]) => !TERMINAL_STATES.has(record.voice.state))
				.map(([runId]) => runId);
			await Promise.allSettled(active.map((runId) => this.refreshVoice(runId)));
		})().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	async tell(runId: string, message: string, mode: "steer" | "follow_up"): Promise<string> {
		const record = this.voices.get(runId);
		if (!record) throw new Error(`Unknown riff ${runId}`);
		const text = truncate(message.replace(/\s+/g, " ").trim(), EDGE_TEXT_CHARS);
		const at = this.now();
		if (TERMINAL_STATES.has(record.voice.state) || record.voice.state === "paused") {
			const data = await this.options.bridge.request<ResumeReply>("resume", { runId, message });
			this.addEdge({ from: "conductor", to: runId, kind: "told", at, text });
			this.adoptRevival(record, data?.details);
			this.publish();
			return `resumed ${record.voice.name}`;
		}
		await this.options.bridge.request("steer", { runId, message, mode });
		this.addEdge({ from: "conductor", to: runId, kind: mode === "follow_up" ? "told" : "steered", at, text });
		this.publish();
		return `${mode === "follow_up" ? "told" : "steered"} ${record.voice.name}`;
	}

	async stop(runId: string): Promise<string> {
		const record = this.voices.get(runId);
		if (!record) throw new Error(`Unknown riff ${runId}`);
		await this.options.bridge.request("stop", { runId });
		this.settle(record, { state: "stopped", activity: undefined, question: undefined, endedAt: this.now() });
		this.ensurePolling();
		this.publish();
		return `stopped ${record.voice.name}`;
	}

	async resume(runId: string, message: string): Promise<string> {
		return this.tell(runId, message, "follow_up");
	}

	async readOutput(runId: string, lines: number): Promise<string[]> {
		const asyncDir = this.voices.get(runId)?.voice.asyncDir;
		return asyncDir ? readOutputTail(asyncDir, lines) : [];
	}

	/** In-flight refreshes may finish after this; every side effect checks `disposed`. */
	dispose(): void {
		this.disposed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.listeners.clear();
	}

	private async refreshVoice(runId: string): Promise<void> {
		const record = this.voices.get(runId);
		if (!record) return;
		const asyncDir = record.voice.asyncDir;
		if (record.hydrated) {
			record.hydrated = false;
			if (asyncDir && !(await statusExists(asyncDir))) {
				if (this.voices.get(runId) !== record) return;
				if (!TERMINAL_STATES.has(record.voice.state)) {
					this.settle(record, { state: "stopped", error: MISSING_RUN_FILES, activity: undefined, question: undefined, endedAt: this.now() });
					this.ensurePolling();
					this.publish();
				}
				return;
			}
			if (this.voices.get(runId) !== record) return;
		}
		const snapshot = asyncDir ? await readStatusFile(asyncDir, record.statusMtimeMs) : undefined;
		if (this.voices.get(runId) !== record) return;
		const before = record.voice;
		if (snapshot) this.applyStatus(record, snapshot);
		await this.resolveQuestion(record, snapshot);
		this.checkLiveness(record);
		if (snapshot || record.voice !== before) {
			this.ensurePolling();
			this.publish();
		}
	}

	private applyStatus(record: VoiceRecord, snapshot: StatusSnapshot): void {
		const fields = readVoiceFields(snapshot.status);
		record.statusMtimeMs = snapshot.mtimeMs;
		if (fields.pid !== undefined) record.pid = fields.pid;
		if (fields.lastUpdate !== undefined) record.lastUpdate = fields.lastUpdate;

		if (record.provisional && record.voice.origin === "subagent") {
			const lane = fields.laneKey ? parseName(fields.laneKey) : undefined;
			if (lane?.ok) {
				record.voice = { ...record.voice, name: allocateName(lane.name, (name) => this.isTakenExcept(name, record)) };
			}
			record.provisional = false;
			this.persist(record.voice);
		}

		if (record.settledFromEvent && TERMINAL_STATES.has(record.voice.state) && !TERMINAL_STATES.has(fields.state)) return;

		const wasTerminal = TERMINAL_STATES.has(record.voice.state);
		record.voice = applyVoiceFields(record.voice, fields);
		if (!wasTerminal && TERMINAL_STATES.has(record.voice.state)) {
			record.settledFromEvent = true;
			this.persist(record.voice);
		}
	}

	/**
	 * A blocked voice waits on its open `contact_supervisor` request, and that request
	 * file is the truth: pi-subagents deletes it the moment the conductor answers, on
	 * any channel, while `status.json` can keep the old `needs_attention` for a while.
	 * So every refresh of a blocked voice checks the request — not only the refreshes
	 * that saw a new status file — and an answered one stops being blocked.
	 */
	private async resolveQuestion(record: VoiceRecord, snapshot: StatusSnapshot | undefined): Promise<void> {
		if (!record.voice.question && record.voice.state !== "blocked") return;
		const runId = record.voice.runId;
		const request = await readSupervisorRequest(this.options.tempRoot, runId);
		if (this.disposed || this.voices.get(runId) !== record) return;
		if (request) {
			this.block(record, request);
			return;
		}
		// Answered: with no open request there is no question, and the stale
		// `needs_attention` must not keep the voice blocked. Its state is the one
		// status.json reports on its own — or running, with no status left to read.
		const status = snapshot ?? (record.voice.asyncDir ? await readStatusFile(record.voice.asyncDir) : undefined);
		if (this.disposed || this.voices.get(runId) !== record) return;
		if (!record.voice.question && record.voice.state !== "blocked") return;
		const answered = record.voice.question;
		record.voice = {
			...record.voice,
			state: status ? mapState(status.status.state) : "running",
			activity: undefined,
			question: undefined,
		};
		if (answered) {
			this.addEdge({ from: "conductor", to: runId, kind: "answered", at: this.now(), text: truncate(answered.message, EDGE_TEXT_CHARS) });
		}
	}

	/** A voice asked the conductor: block it with its real question from the open request, not the generic notice. */
	private async markBlocked(record: VoiceRecord, fallback: PendingQuestion): Promise<void> {
		const request = await readSupervisorRequest(this.options.tempRoot, record.voice.runId);
		if (this.disposed || this.voices.get(record.voice.runId) !== record) return;
		this.block(record, request ?? fallback);
	}

	/** Show the question and record the `asked` edge; a settled voice is never re-blocked. */
	private block(record: VoiceRecord, question: PendingQuestion): void {
		if (TERMINAL_STATES.has(record.voice.state) || record.voice.question?.message === question.message) return;
		record.voice = { ...record.voice, state: "blocked", activity: undefined, question };
		this.addEdge({ from: record.voice.runId, to: "conductor", kind: "asked", at: question.at, text: truncate(question.message, EDGE_TEXT_CHARS) });
		this.publish();
	}

	private checkLiveness(record: VoiceRecord): void {
		if (record.voice.state !== "running" || record.pid === undefined) return;
		if (this.isProcessAlive(record.pid)) return;
		const last = record.lastUpdate ?? record.voice.startedAt;
		if (last === undefined || this.now() - last <= RUNNER_EXIT_GRACE_MS) return;
		this.settle(record, { state: "failed", activity: undefined, error: "runner exited", endedAt: this.now() });
	}

	/** Move a voice to a terminal state and persist it for reboot recovery. */
	private settle(record: VoiceRecord, patch: Partial<Voice>): void {
		record.settledFromEvent = true;
		record.voice = { ...record.voice, ...patch };
		this.persist(record.voice);
		try {
			this.options.onSettled?.(record.voice);
		} catch {
			// Housekeeping must never break a settle.
		}
	}

	private adoptRevival(record: VoiceRecord, info: ResumeDetails | undefined): void {
		const newRunId = typeof info?.runId === "string" && info.runId ? info.runId : record.voice.runId;
		if (newRunId === record.voice.runId) {
			record.settledFromEvent = false;
			record.voice = { ...record.voice, state: "queued", activity: undefined, question: undefined, endedAt: undefined, error: undefined, summary: undefined };
			return;
		}
		const revived: Voice = {
			...record.voice,
			runId: newRunId,
			asyncDir: typeof info?.asyncDir === "string" ? info.asyncDir : asyncDirForRun(this.options.tempRoot, newRunId),
			state: "queued",
			activity: undefined,
			question: undefined,
			endedAt: undefined,
			error: undefined,
			summary: undefined,
			startedAt: this.now(),
		};
		this.voices.delete(record.voice.runId);
		this.voices.set(newRunId, { voice: revived, provisional: false, settledFromEvent: false, hydrated: false });
		this.persist(revived);
		this.ensurePolling();
		void this.refreshVoice(newRunId);
	}

	private isTakenExcept(name: string, record: VoiceRecord): boolean {
		for (const other of this.voices.values()) {
			if (other !== record && other.voice.name === name) return true;
		}
		return false;
	}

	private addEdge(edge: MessageEdge): void {
		this.edges.push(edge);
		if (this.edges.length > MAX_EDGES) this.edges = this.edges.slice(this.edges.length - MAX_EDGES);
	}

	private persist(voice: Voice): void {
		if (this.disposed) return;
		this.options.persist?.({
			runId: voice.runId,
			name: voice.name,
			role: voice.role,
			...(voice.model ? { model: voice.model } : {}),
			...(voice.task ? { task: voice.task } : {}),
			parent: voice.parent,
			origin: voice.origin,
			...(voice.startedAt !== undefined ? { startedAt: voice.startedAt } : {}),
			state: voice.state,
			...(voice.endedAt !== undefined ? { endedAt: voice.endedAt } : {}),
			...(voice.summary ? { summary: voice.summary } : {}),
			...(voice.error ? { error: voice.error } : {}),
			...(voice.tokens ? { tokens: voice.tokens } : {}),
			...(voice.costUsd !== undefined ? { costUsd: voice.costUsd } : {}),
			...(voice.worktree ? { worktree: voice.worktree } : {}),
		});
	}

	private ensurePolling(): void {
		if (this.disposed) return;
		const active = [...this.voices.values()].some((record) => !TERMINAL_STATES.has(record.voice.state));
		if (active && !this.timer) {
			const timer = setInterval(() => {
				void this.refreshActive();
			}, this.options.pollMs ?? DEFAULT_POLL_MS);
			timer.unref?.();
			this.timer = timer;
		} else if (!active && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private publish(): void {
		if (this.disposed) return;
		this.version += 1;
		this.snapshotValue = {
			conductor: this.conductor,
			voices: [...this.voices.values()].map((record) => record.voice),
			edges: this.edges,
			...(this.gate ? { gate: this.gate } : {}),
			version: this.version,
		};
		if (this.notifyScheduled) return;
		this.notifyScheduled = true;
		queueMicrotask(() => {
			this.notifyScheduled = false;
			for (const listener of [...this.listeners]) listener();
		});
	}
}

function usageTotals(usage: { input?: number; output?: number }): { input: number; output: number; total: number } {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	return { input, output, total: input + output };
}

function truncate(text: string, max: number): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > max ? single.slice(0, max) : single;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

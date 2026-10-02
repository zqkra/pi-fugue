/**
 * Model-facing riff tools (DESIGN §2 Tools): riff_spawn, riff_tell,
 * riff_stop, riff_status, riff_merge, riff_discard. Each tool keeps the chat
 * to one line via renderCall/renderResult while the full text still reaches
 * the model. Writer riffs are spawned in a Fugue-managed worktree
 * (src/worktrees.ts) unless the request turns isolation off.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { Type } from "typebox";
import { allocateName, parseName } from "./names.ts";
import type { BridgeLike, Store } from "./store.ts";
import { TERMINAL_STATES, type RiffWorktree, type Voice } from "./types.ts";
import {
	discardRiffWorktree,
	mergeRiffWorktree,
	prepareRiffWorktree,
	worktreeStats,
	type WorktreeStats,
} from "./worktrees.ts";

export interface VoiceToolDeps {
	store: Store;
	bridge: BridgeLike;
}

const SPAWN_FOLLOW_UP =
	"The riffs run in the background and notify you when they finish. End your turn now; do not call bg_wait or poll.";

/** pi-subagents stops a background child at 30 min by default; real work runs longer. */
const DEFAULT_TIMEOUT_MINUTES = 240;
/** Before the deadline the riff is asked to stop cleanly and report what is done and what is left. */
const CHECKPOINT_BEFORE_DEADLINE_MS = 5 * 60_000;

const SPAWN_GUIDELINES = [
	"Give every riff a short name that says its job.",
	"The owner chooses models: pass model exactly as the owner named it and never invent a default.",
	"Writer riffs (worker, delegate) are isolated on their own fugue/<name> branch automatically.",
	"Parallel riffs may read, but only one riff writes a given area.",
	"Results arrive as notifications that start a new turn; never call bg_wait or poll for riffs, end your turn instead.",
	"Answer a blocked riff's question, or escalate real product decisions to the owner.",
	"After a writer settles, run fugue_gate with cwd set to its worktree, review, then riff_merge; use riff_discard to drop work.",
];

/** Roles that write: isolated by default so the main checkout stays clean. */
const WRITER_ROLES = new Set(["worker", "delegate"]);

export function defaultIsolate(role: string): boolean {
	return WRITER_ROLES.has(role.trim().toLowerCase());
}

export function laneMode(role: string): "mutation" | "review" | "scout" | undefined {
	switch (role) {
		case "worker":
		case "delegate":
			return "mutation";
		case "reviewer":
		case "evidence-auditor":
			return "review";
		case "scout":
		case "researcher":
			return "scout";
		default:
			return undefined;
	}
}

const SpawnVoiceParams = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 40, description: "Short riff name: lowercase letters, digits and dashes." }),
	role: Type.String({ minLength: 1, description: "pi-subagents agent: worker, scout, reviewer, researcher, delegate, oracle, evidence-auditor." }),
	task: Type.String({ minLength: 1, description: "Task for the riff; include everything it needs." }),
	model: Type.Optional(Type.String({ description: "Model provider/id exactly as the owner named it. Omit to use the role default." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the riff." })),
	isolate: Type.Optional(
		Type.Boolean({
			description: "Run the riff in its own git worktree and branch. Default: true for worker and delegate, false for other roles.",
		}),
	),
	timeoutMinutes: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 1440, description: `Hard deadline in minutes; default ${DEFAULT_TIMEOUT_MINUTES}. The riff is asked to wrap up 5 minutes before it.` }),
	),
});

const VoiceSpawnParams = Type.Object({
	riffs: Type.Array(SpawnVoiceParams, { minItems: 1, maxItems: 8, description: "One to eight riffs to launch in this call." }),
});

const VoiceTellParams = Type.Object({
	name: Type.String({ minLength: 1, description: "Riff name from riff_spawn or riff_status." }),
	message: Type.String({ minLength: 1, description: "Answer to a blocked riff, or new instruction." }),
	mode: Type.Optional(Type.String({ enum: ["steer", "follow_up"], description: "steer interrupts the current turn, follow_up queues after it. Default steer." })),
});

const VoiceStopParams = Type.Object({
	name: Type.String({ minLength: 1, description: "Riff name to stop." }),
});

const VoiceStatusParams = Type.Object({
	name: Type.Optional(Type.String({ description: "Riff name; omit for the whole roster." })),
});

const VoiceMergeParams = Type.Object({
	name: Type.String({ minLength: 1, description: "Settled isolated riff to merge into the main checkout." }),
	squash: Type.Optional(Type.Boolean({ description: "Squash the branch into one commit instead of a merge commit." })),
	keep: Type.Optional(Type.Boolean({ description: "Keep the worktree folder and branch after merging." })),
});

const VoiceDiscardParams = Type.Object({
	name: Type.String({ minLength: 1, description: "Settled isolated riff whose work should be dropped." }),
	deleteBranch: Type.Optional(Type.Boolean({ description: "Also delete the riff's fugue/<name> branch. Default false." })),
});

interface SpawnReply {
	isError?: boolean;
	content?: Array<{ type?: string; text?: string }>;
	details?: { runId?: unknown; asyncDir?: unknown };
}

interface SpawnResult {
	name: string;
	role: string;
	state: "started" | "failed";
	runId?: string;
}

interface SpawnDetails {
	action: "spawn";
	started: number;
	voices: SpawnResult[];
}

interface StatusDetails {
	action: "status";
	count?: number;
	name?: string;
}

interface MergeDetails {
	action: "merge" | "discard";
	name: string;
}

/** One paragraph appended to an isolated riff's task, per DESIGN §2 Spawning. */
function isolationParagraph(worktree: RiffWorktree): string {
	return (
		`\n\nYou work in an isolated git worktree at ${worktree.path} on branch ${worktree.branch} ` +
		`(base ${worktree.base.slice(0, 8)}). Commit your work there with clear messages before you finish. ` +
		"Do not push and do not touch other branches."
	);
}

export function createVoiceTools(getDeps: () => VoiceToolDeps | undefined): Array<ToolDefinition<any, any, any>> {
	function deps(): VoiceToolDeps {
		const value = getDeps();
		if (!value) throw new Error("Fugue has no active session.");
		return value;
	}

	const spawn = defineTool({
		name: "riff_spawn",
		label: "Spawn riffs",
		description: "Launch one or more named background riffs (pi-subagents children, Fugue's subagents) and show them on the Score.",
		promptGuidelines: SPAWN_GUIDELINES,
		parameters: VoiceSpawnParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { store, bridge } = deps();
			const lines: string[] = [];
			const results: SpawnResult[] = [];
			for (const request of params.riffs) {
				const parsed = parseName(request.name);
				if (!parsed.ok) {
					lines.push(`${request.name}  ${request.role}  error: ${parsed.error}`);
					results.push({ name: request.name, role: request.role, state: "failed" });
					continue;
				}
				const name = allocateName(parsed.name, (candidate) => store.voiceByName(candidate) !== undefined);
				const role = request.role.trim();
				const lane: Record<string, unknown> = { version: 1, key: name };
				const mode = laneMode(role);
				if (mode) lane.mode = mode;
				const requestedCwd = request.cwd?.trim() ? resolve(ctx.cwd, request.cwd) : ctx.cwd;
				const notes: string[] = [];
				let riffCwd = requestedCwd;
				let worktree: RiffWorktree | undefined;
				if (request.isolate ?? defaultIsolate(role)) {
					const prepared = await prepareRiffWorktree({ name, cwd: requestedCwd });
					if (prepared.isolated) {
						riffCwd = prepared.setup.cwd;
						worktree = prepared.setup.worktree;
						notes.push(...prepared.setup.warnings.map((warning) => `warning: ${warning}`));
					} else {
						notes.push(`not isolated: ${prepared.reason ?? "no worktree"}`);
						notes.push(...prepared.warnings.map((warning) => `warning: ${warning}`));
					}
				}
				try {
					const data = await bridge.request<SpawnReply>("spawn", {
						agent: role,
						task: worktree ? request.task + isolationParagraph(worktree) : request.task,
						...(request.model ? { model: request.model } : {}),
						...(riffCwd ? { cwd: riffCwd } : {}),
						timeoutMs: (request.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000,
						checkpointBeforeDeadlineMs: CHECKPOINT_BEFORE_DEADLINE_MS,
						lane,
					});
					const runId = typeof data?.details?.runId === "string" ? data.details.runId : undefined;
					if (!runId) throw new Error(spawnFailure(data));
					store.registerVoice({
						runId,
						name,
						role,
						...(request.model ? { model: request.model } : {}),
						task: request.task,
						origin: "fugue",
						...(typeof data.details?.asyncDir === "string" ? { asyncDir: data.details.asyncDir } : {}),
						...(worktree ? { worktree } : {}),
					});
					lines.push(`${name}  ${role}  ${request.model ?? "default model"}  started  run ${runId}${notes.map((note) => `  ${note}`).join("")}`);
					results.push({ name, role, state: "started", runId });
				} catch (error) {
					// A worktree whose spawn never happened holds nothing: drop it so it does not leak.
					if (worktree) {
						const discarded = await discardRiffWorktree({ worktree, deleteBranch: true });
						notes.push(...discarded.warnings.map((warning) => `warning: ${warning}`));
					}
					lines.push(`${name}  ${role}  error: ${errorMessage(error)}${notes.map((note) => `  ${note}`).join("")}`);
					results.push({ name, role, state: "failed" });
				}
			}
			const started = results.filter((result) => result.state === "started").length;
			return {
				content: [{ type: "text" as const, text: [...lines, ...(started > 0 ? [SPAWN_FOLLOW_UP] : [])].join("\n") }],
				details: { action: "spawn", started, voices: results } satisfies SpawnDetails,
				...(started === 0 ? { isError: true } : {}),
			};
		},
		renderCall(args, theme) {
			const names = args.riffs.map((voice) => `${voice.name} ${voice.role}`).join(" · ");
			return oneLine(theme.fg("accent", "riff_spawn") + " " + theme.fg("text", names));
		},
		renderResult(result, _options, theme) {
			const details = result.details as SpawnDetails | undefined;
			const started = details?.started ?? 0;
			const text = `${started} riff${started === 1 ? "" : "s"} started`;
			return oneLine(theme.fg(started > 0 ? "success" : "error", text));
		},
	});

	const tell = defineTool({
		name: "riff_tell",
		label: "Tell riff",
		description: "Send an answer or instruction to a riff: steer it while running, resume it once settled.",
		parameters: VoiceTellParams,
		async execute(_toolCallId, params) {
			const { store } = deps();
			const voice = store.voiceByName(params.name);
			if (!voice) throw unknownVoice(store, params.name);
			const mode = params.mode === "follow_up" ? "follow_up" : "steer";
			const result = await store.tell(voice.runId, params.message, mode);
			return { content: [{ type: "text" as const, text: result }], details: { action: "tell", name: voice.name } };
		},
		renderCall(args, theme) {
			return oneLine(theme.fg("accent", "riff_tell") + " " + theme.fg("text", args.name));
		},
		renderResult(result, _options, theme) {
			return oneLine(theme.fg(result.isError ? "error" : "text", firstResultLine(result)));
		},
	});

	const stop = defineTool({
		name: "riff_stop",
		label: "Stop riff",
		description: "Stop a running riff.",
		parameters: VoiceStopParams,
		async execute(_toolCallId, params) {
			const { store } = deps();
			const voice = store.voiceByName(params.name);
			if (!voice) throw unknownVoice(store, params.name);
			const result = await store.stop(voice.runId);
			return { content: [{ type: "text" as const, text: result }], details: { action: "stop", name: voice.name } };
		},
		renderCall(args, theme) {
			return oneLine(theme.fg("accent", "riff_stop") + " " + theme.fg("text", args.name));
		},
		renderResult(result, _options, theme) {
			return oneLine(theme.fg(result.isError ? "error" : "text", firstResultLine(result)));
		},
	});

	const status = defineTool<typeof VoiceStatusParams, StatusDetails>({
		name: "riff_status",
		label: "Riff status",
		description: "List the session's riffs, or show one riff in detail.",
		parameters: VoiceStatusParams,
		async execute(_toolCallId, params) {
			const { store } = deps();
			const name = params.name?.trim() ?? "";
			if (!name) {
				const snapshot = store.snapshot();
				const stats = await Promise.all(snapshot.voices.map((voice) => worktreeStatsFor(voice)));
				const text = snapshot.voices.length === 0
					? "no riffs"
					: snapshot.voices.map((voice, index) => rosterLine(voice, Date.now(), stats[index])).join("\n");
				return { content: [{ type: "text" as const, text }], details: { action: "status", count: snapshot.voices.length } satisfies StatusDetails };
			}
			const voice = store.voiceByName(name);
			if (!voice) throw unknownVoice(store, name);
			const stats = await worktreeStatsFor(voice);
			return {
				content: [{ type: "text" as const, text: voiceDetail(voice, Date.now(), stats) }],
				details: { action: "status", name: voice.name } satisfies StatusDetails,
			};
		},
		renderCall(args, theme) {
			return oneLine(theme.fg("accent", "riff_status") + (args.name ? " " + theme.fg("text", args.name) : ""));
		},
		renderResult(result, _options, theme) {
			return oneLine(theme.fg(result.isError ? "error" : "text", firstResultLine(result)));
		},
	});

	const merge = defineTool<typeof VoiceMergeParams, MergeDetails>({
		name: "riff_merge",
		label: "Merge riff",
		description: "Merge a settled isolated riff's branch into the main checkout, then clean up the worktree.",
		parameters: VoiceMergeParams,
		async execute(_toolCallId, params) {
			const { store } = deps();
			const voice = store.voiceByName(params.name);
			if (!voice) throw unknownVoice(store, params.name);
			const worktree = voice.worktree;
			const refusal = mergeRefusal(voice);
			if (refusal || !worktree) return refusalLine(refusal ?? `${voice.name} has no worktree`, "merge", voice.name);
			const outcome = await mergeRiffWorktree({
				worktree,
				name: voice.name,
				squash: params.squash === true,
				keep: params.keep === true,
			});
			if (!outcome.ok) {
				return refusalLine(`not merged: ${outcome.reason ?? "merge failed"}${warningSuffix(outcome.warnings)}`, "merge", voice.name);
			}
			store.setWorktreeStatus(voice.runId, "merged");
			const commits = `${outcome.commits} commit${outcome.commits === 1 ? "" : "s"}`;
			const files = `${outcome.files} file${outcome.files === 1 ? "" : "s"}`;
			return {
				content: [{ type: "text" as const, text: `merged ${voice.name}: ${commits}, ${files}${warningSuffix(outcome.warnings)}` }],
				details: { action: "merge", name: voice.name } satisfies MergeDetails,
			};
		},
		renderCall(args, theme) {
			return oneLine(theme.fg("accent", "riff_merge") + " " + theme.fg("text", args.name));
		},
		renderResult(result, _options, theme) {
			return oneLine(theme.fg(result.isError ? "error" : "text", firstResultLine(result)));
		},
	});

	const discard = defineTool<typeof VoiceDiscardParams, MergeDetails>({
		name: "riff_discard",
		label: "Discard riff",
		description: "Remove a settled isolated riff's worktree folder; the branch is kept unless deleteBranch.",
		parameters: VoiceDiscardParams,
		async execute(_toolCallId, params) {
			const { store } = deps();
			const voice = store.voiceByName(params.name);
			if (!voice) throw unknownVoice(store, params.name);
			const worktree = voice.worktree;
			if (!worktree) return refusalLine(`${voice.name} has no worktree`, "discard", voice.name);
			if (!TERMINAL_STATES.has(voice.state)) {
				return refusalLine(`${voice.name} is ${voice.state}; riff_stop it first`, "discard", voice.name);
			}
			if (worktree.status !== "active") {
				return { content: [{ type: "text" as const, text: `already ${worktree.status}: ${voice.name}` }], details: { action: "discard", name: voice.name } satisfies MergeDetails };
			}
			const outcome = await discardRiffWorktree({ worktree, deleteBranch: params.deleteBranch === true });
			store.setWorktreeStatus(voice.runId, "discarded");
			const branch = `branch ${worktree.branch} ${outcome.branchDeleted ? "deleted" : "kept"}`;
			return {
				content: [{ type: "text" as const, text: `discarded ${voice.name}, ${branch}${warningSuffix(outcome.warnings)}` }],
				details: { action: "discard", name: voice.name } satisfies MergeDetails,
			};
		},
		renderCall(args, theme) {
			return oneLine(theme.fg("accent", "riff_discard") + " " + theme.fg("text", args.name));
		},
		renderResult(result, _options, theme) {
			return oneLine(theme.fg(result.isError ? "error" : "text", firstResultLine(result)));
		},
	});

	return [spawn, tell, stop, status, merge, discard];
}

export function registerVoiceTools(pi: ExtensionAPI, getDeps: () => VoiceToolDeps | undefined): void {
	for (const tool of createVoiceTools(getDeps)) pi.registerTool(tool);
}

function spawnFailure(data: SpawnReply | undefined): string {
	const text = data?.content?.find((part) => part.type === "text")?.text;
	return text ?? "spawn failed";
}

function unknownVoice(store: Store, name: string): Error {
	const known = [...new Set(store.snapshot().voices.map((voice) => voice.name))];
	const suffix = known.length > 0 ? `Known riffs: ${known.join(", ")}` : "No riffs in this session.";
	return new Error(`Unknown riff "${name}". ${suffix}`);
}

function firstResultLine(result: { content: Array<{ type: string; text?: string }> }): string {
	const text = result.content.find((part) => part.type === "text")?.text ?? "";
	return text.split("\n")[0] ?? "";
}

/** Why this voice's worktree cannot be merged right now, or undefined when it can. */
function mergeRefusal(voice: Voice): string | undefined {
	if (!voice.worktree) return `${voice.name} has no worktree`;
	if (!TERMINAL_STATES.has(voice.state)) return `${voice.name} is ${voice.state}; wait for it to settle or riff_stop it`;
	if (voice.worktree.status !== "active") return `${voice.name} worktree is already ${voice.worktree.status}`;
	return undefined;
}

function refusalLine(reason: string, action: MergeDetails["action"], name: string): { content: Array<{ type: "text"; text: string }>; details: MergeDetails; isError: true } {
	return { content: [{ type: "text" as const, text: reason }], details: { action, name }, isError: true };
}

function warningSuffix(warnings: readonly string[]): string {
	return warnings.length > 0 ? `  warning: ${warnings.join("; ")}` : "";
}

async function worktreeStatsFor(voice: Voice): Promise<WorktreeStats | undefined> {
	return voice.worktree ? worktreeStats(voice.worktree) : undefined;
}

function oneLine(text: string): Component {
	return {
		render: (width: number) => [truncateToWidth(text, width)],
		invalidate() {},
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function rosterLine(voice: Voice, now: number, stats?: WorktreeStats): string {
	const parts = [voice.name, voice.role, voice.state];
	if (voice.activity) {
		parts.push(voice.activity.detail ? `${voice.activity.kind} ${voice.activity.detail}` : voice.activity.kind);
	}
	const elapsed = elapsedLabel(voice, now);
	if (elapsed) parts.push(elapsed);
	if (voice.tokens) parts.push(tokenLabel(voice.tokens.total));
	if (voice.costUsd !== undefined) parts.push(`$${voice.costUsd.toFixed(2)}`);
	if (voice.worktree) parts.push(worktreeLine(voice.worktree, stats));
	return parts.join("  ");
}

function worktreeLine(worktree: RiffWorktree, stats?: WorktreeStats): string {
	const state = worktree.status === "active" ? "" : ` ${worktree.status}`;
	return stats ? `${worktree.branch}${state} +${stats.commits} commits, ${stats.files} files` : `${worktree.branch}${state}`;
}

function voiceDetail(voice: Voice, now: number, stats?: WorktreeStats): string {
	const lines = [`${voice.name}  ${voice.role}  ${voice.state}`];
	if (voice.model) lines.push(`model: ${voice.model}`);
	if (voice.thinking) lines.push(`thinking: ${voice.thinking}`);
	if (voice.activity) lines.push(`activity: ${voice.activity.kind}${voice.activity.detail ? ` ${voice.activity.detail}` : ""}`);
	const elapsed = elapsedLabel(voice, now);
	if (elapsed) lines.push(`elapsed: ${elapsed}`);
	if (voice.tokens) lines.push(`tokens: ${voice.tokens.input} in / ${voice.tokens.output} out (${voice.tokens.total})`);
	if (voice.costUsd !== undefined) lines.push(`cost: $${voice.costUsd.toFixed(4)}`);
	if (voice.question) lines.push(`question: ${voice.question.message}`);
	if (voice.worktree) {
		lines.push(`branch: ${voice.worktree.branch} (base ${voice.worktree.base.slice(0, 8)})`);
		lines.push(`worktree: ${voice.worktree.path} (${voice.worktree.status})`);
		if (stats) lines.push(`changes: ${stats.commits} commits ahead of base, ${stats.files} files`);
	}
	if (voice.task) lines.push(`task: ${voice.task}`);
	if (voice.summary) lines.push(`summary: ${voice.summary}`);
	if (voice.error) lines.push(`error: ${voice.error}`);
	lines.push(`run: ${voice.runId}`);
	return lines.join("\n");
}

function elapsedLabel(voice: Voice, now: number): string | undefined {
	if (!voice.startedAt) return undefined;
	if (voice.endedAt) return duration(voice.endedAt - voice.startedAt);
	if (TERMINAL_STATES.has(voice.state)) return undefined;
	return duration(now - voice.startedAt);
}

function tokenLabel(total: number): string {
	if (total >= 1_000_000) return `${+(total / 1_000_000).toFixed(1)}M`;
	if (total >= 1_000) return `${Math.round(total / 1_000)}k`;
	return `${total}`;
}

function duration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest ? `${minutes}m${rest}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const tail = minutes % 60;
	return tail ? `${hours}h${tail}m` : `${hours}h`;
}

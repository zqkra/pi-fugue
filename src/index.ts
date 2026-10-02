/**
 * Fugue entry point (DESIGN §7): child guard, then register tools, gates,
 * notices and commands at factory time. Each `session_start` builds a fresh
 * Store for the session, mounts the Score and starts durable notices;
 * `session_shutdown` disposes all three.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bridge } from "./bridge.ts";
import { registerCommands } from "./commands.ts";
import { registerGates } from "./gates.ts";
import { registerNoticeRenderer, startNotices } from "./notices.ts";
import { recordOwner } from "./owners.ts";
import { tempRoot } from "./paths.ts";
import {
	Store,
	type AsyncCompletePayload,
	type AsyncStartedPayload,
	type ChildStatusPayload,
	type ControlEventPayload,
	type ProcessTerminalPayload,
	type VoiceEntry,
} from "./store.ts";
import { registerVoiceTools } from "./tools.ts";
import { bgWaitBlockReason, forceBackground } from "./free-chat.ts";
import { mountScore, type ScoreHandle } from "./ui/index.ts";
import { commitSettledWork, parseRiffWorktree, pruneVanishedWorktrees } from "./worktrees.ts";

const VOICE_ENTRY = "fugue.voice";

export default function (pi: ExtensionAPI) {
	// Background children load ambient extensions; Fugue has no business there.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	let bridge: Bridge | undefined;
	let session: { store: Store; score: ScoreHandle; notices: { dispose(): void } } | undefined;
	let eventOffs: Array<() => void> = [];

	registerNoticeRenderer(pi);
	registerGates(pi, (report) => session?.store.setGate(report));
	registerVoiceTools(pi, () => (session && bridge ? { store: session.store, bridge } : undefined));
	registerCommands(pi, () => {
		const current = session;
		if (!current || !bridge) return undefined;
		return { store: current.store, bridge, openPanel: () => current.score.openPanel() };
	});

	pi.on("model_select", async (_event, ctx) => {
		session?.store.setConductor({ model: ctx.model?.id, thinking: pi.getThinkingLevel() });
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		session?.store.setConductor({ model: ctx.model?.id, thinking: pi.getThinkingLevel() });
	});

	pi.on("session_start", async (_event, ctx) => {
		disposeSession();
		const activeBridge = new Bridge(pi);
		bridge = activeBridge;
		const store = new Store({
			bridge: activeBridge,
			conductor: { model: ctx.model?.id, thinking: pi.getThinkingLevel() },
			tempRoot: tempRoot(),
			persist: (entry) => pi.appendEntry(VOICE_ENTRY, entry),
			onSettled: (voice) => {
				const worktree = voice.worktree;
				if (!worktree || worktree.status !== "active") return;
				// Commits whatever the riff left uncommitted so nothing is lost; fire-and-forget
				// is safe because the hook itself never rejects.
				void commitSettledWork(worktree, voice.name, voice.state).then((result) => {
					if (result.warning) console.error(`[fugue] ${voice.name} worktree: ${result.warning}`);
				});
			},
		});
		store.hydrate(collectVoiceEntries(ctx));
		session = { store, score: mountScore(pi, ctx, store, store), notices: startNotices(pi, ctx, store) };
		void pruneVanishedWorktrees(store.snapshot().voices);
		eventOffs = [
			pi.events.on("subagent:async-started", (event) => {
				recordOwner((event as AsyncStartedPayload | undefined)?.completionOwnerId);
				store.onAsyncStarted(event as AsyncStartedPayload);
			}),
			pi.events.on("subagent:async-complete", (event) => store.onAsyncComplete(event as AsyncCompletePayload)),
			pi.events.on("subagent:child-status", (event) => store.onChildStatus(event as ChildStatusPayload)),
			pi.events.on("subagent:control-event", (event) => store.onControlEvent(event as ControlEventPayload)),
			pi.events.on("subagent:process-terminal", (event) => store.onProcessTerminal(event as ProcessTerminalPayload)),
		];
		// Await the first status read so the tools never see a stale hydrated state.
		await store.refreshAll();
	});

	// Keep the chat free while children work (src/free-chat.ts). Headless runs are left alone:
	// there nobody is typing and pi-subagents drains children at agent_end.
	pi.on("tool_call", (event, ctx) => {
		if (ctx.mode !== "tui" || !session) return undefined;
		const input = event.input as Record<string, unknown>;
		if (event.toolName === "subagent") forceBackground(input);
		if (event.toolName !== "bg_wait") return undefined;
		const reason = bgWaitBlockReason(input, session.store.snapshot().voices);
		return reason ? { block: true, reason, terminate: true } : undefined;
	});

	pi.on("session_shutdown", async () => {
		disposeSession();
	});

	function disposeSession(): void {
		for (const off of eventOffs) off();
		eventOffs = [];
		session?.notices.dispose();
		session?.score.dispose();
		session?.store.dispose();
		session = undefined;
		bridge = undefined;
	}
}

function collectVoiceEntries(ctx: ExtensionContext): VoiceEntry[] {
	const entries: VoiceEntry[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== VOICE_ENTRY) continue;
		const data = entry.data as Partial<VoiceEntry> | undefined;
		if (!data || typeof data.runId !== "string" || typeof data.name !== "string" || typeof data.role !== "string") continue;
		const worktree = parseRiffWorktree(data.worktree);
		entries.push({
			runId: data.runId,
			name: data.name,
			role: data.role,
			...(typeof data.model === "string" ? { model: data.model } : {}),
			...(typeof data.task === "string" ? { task: data.task } : {}),
			parent: typeof data.parent === "string" ? data.parent : "conductor",
			origin: data.origin === "fugue" ? "fugue" : "subagent",
			...(typeof data.startedAt === "number" ? { startedAt: data.startedAt } : {}),
			...(worktree ? { worktree } : {}),
		});
	}
	return entries;
}

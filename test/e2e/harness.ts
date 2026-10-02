/**
 * E2E harness for durable notices and gates.
 *
 * Wires the real `src/notices.ts` and `src/gates.ts` into a real Pi process
 * with a minimal RosterView built from pi-subagents events. This is test
 * scaffolding, not a shipped extension; `test/e2e/*.sh` drives it.
 *
 * Env:
 *   FUGUE_E2E_DIR        write run.json / ready / session info here
 *   FUGUE_E2E_SPAWN=1    spawn a `sleep 25` background voice on the first turn
 *   FUGUE_E2E_HOLD_MS    delay agent settle this long (keeps the session alive
 *                        for the 5 s notice grace) before pi -p can exit
 *   FUGUE_E2E_CHILD_MODEL  child model override
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerGates } from "../../src/gates.ts";
import { registerNoticeRenderer, startNotices } from "../../src/notices.ts";
import type { RosterView, ScoreSnapshot, Voice } from "../../src/types.ts";

const CHILD_MODEL = process.env.FUGUE_E2E_CHILD_MODEL ?? "opencode-go/deepseek-v4.1-flash:low";
const VOICE_NAME = "sleepy";
const VOICE_TASK = "Use the bash tool to run exactly: sleep 25\nWhen that command finishes, reply with the single word: finished.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class E2eRoster implements RosterView {
	private readonly voices = new Map<string, Voice>();
	private readonly listeners = new Set<() => void>();
	private version = 0;

	snapshot(): ScoreSnapshot {
		return { conductor: {}, voices: [...this.voices.values()], edges: [], version: this.version };
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	voice(runId: string): Voice | undefined {
		return this.voices.get(runId);
	}

	upsert(voice: Voice): void {
		this.voices.set(voice.runId, { ...this.voices.get(voice.runId), ...voice });
		this.version += 1;
		for (const listener of this.listeners) listener();
	}
}

interface SpawnReply {
	runId: string;
	asyncDir?: string;
}

function rpcSpawn(pi: ExtensionAPI, params: Record<string, unknown>): Promise<SpawnReply> {
	return new Promise((resolve, reject) => {
		const requestId = `fugue-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		const timeout = setTimeout(() => {
			off();
			reject(new Error("subagent RPC spawn timed out"));
		}, 15_000);
		const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (raw) => {
			const reply = isRecord(raw) ? raw : undefined;
			if (!reply || reply.requestId !== requestId) return;
			clearTimeout(timeout);
			off();
			if (reply.success !== true) {
				const error = isRecord(reply.error) ? reply.error : undefined;
				reject(new Error(stringValue(error?.message) ?? "subagent RPC spawn failed"));
				return;
			}
			const data = isRecord(reply.data) ? reply.data : undefined;
			const details = isRecord(data?.details) ? data.details : undefined;
			const runId = stringValue(details?.runId);
			if (!runId) {
				reject(new Error("subagent RPC spawn reply had no runId"));
				return;
			}
			resolve({ runId, asyncDir: stringValue(details?.asyncDir) });
		});
		pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "spawn", params });
	});
}

async function withRetry<T>(run: () => Promise<T>, attempts: number, delayMs: number): Promise<T | undefined> {
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			return await run();
		} catch (error) {
			if (attempt === attempts) {
				console.error("[fugue-e2e] spawn failed:", error);
				return undefined;
			}
			await delay(delayMs);
		}
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	const roster = new E2eRoster();
	let notices: { dispose(): void } | undefined;
	let spawned = false;

	registerNoticeRenderer(pi);
	registerGates(pi, (report) => console.error(`[fugue-e2e] gate report ok=${report.ok} checks=${report.checks.length}`));

	pi.events.on("subagent:async-started", (raw) => {
		const event = isRecord(raw) ? raw : undefined;
		const runId = stringValue(event?.id) ?? stringValue(event?.runId);
		if (!runId) return;
		const agent = stringValue(event?.agent);
		roster.upsert({
			runId,
			name: roster.voice(runId)?.name ?? agent ?? "voice",
			role: roster.voice(runId)?.role ?? agent ?? "voice",
			parent: "conductor",
			origin: "subagent",
			state: "running",
			startedAt: Date.now(),
			asyncDir: stringValue(event?.asyncDir),
		});
	});

	pi.events.on("subagent:async-complete", (raw) => {
		const event = isRecord(raw) ? raw : undefined;
		const runId = stringValue(event?.id) ?? stringValue(event?.runId);
		if (!runId) return;
		const state = stringValue(event?.state);
		const mapped = state === "complete" ? "done" : state === "failed" || state === "partial" || state === "rejected" ? "failed" : state === "stopped" ? "stopped" : "done";
		roster.upsert({
			runId,
			name: roster.voice(runId)?.name ?? "voice",
			role: roster.voice(runId)?.role ?? "voice",
			parent: "conductor",
			origin: "subagent",
			state: mapped,
			endedAt: Date.now(),
		});
	});

	async function spawnSleepy(ctx: ExtensionContext): Promise<void> {
		const startedAt = Date.now();
		const reply = await rpcSpawn(pi, {
			agent: "worker",
			task: VOICE_TASK,
			model: CHILD_MODEL,
			lane: { version: 1, key: VOICE_NAME, mode: "mutation" },
		});
		roster.upsert({
			runId: reply.runId,
			name: VOICE_NAME,
			role: "worker",
			model: CHILD_MODEL,
			task: VOICE_TASK,
			parent: "conductor",
			origin: "fugue",
			state: "running",
			startedAt,
			asyncDir: reply.asyncDir,
		});
		pi.appendEntry("fugue.voice", {
			runId: reply.runId,
			name: VOICE_NAME,
			role: "worker",
			model: CHILD_MODEL,
			task: VOICE_TASK,
			parent: "conductor",
			origin: "fugue",
			startedAt,
		});
		if (process.env.FUGUE_E2E_DIR) {
			await writeFile(join(process.env.FUGUE_E2E_DIR, "run.json"), JSON.stringify(reply));
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "fugue.voice") continue;
			const data = isRecord(entry.data) ? entry.data : undefined;
			const runId = stringValue(data?.runId);
			if (!runId) continue;
			const role = stringValue(data?.role);
			roster.upsert({
				runId,
				name: stringValue(data?.name) ?? role ?? "voice",
				role: role ?? "voice",
				model: stringValue(data?.model),
				task: stringValue(data?.task),
				parent: stringValue(data?.parent) ?? "conductor",
				origin: "fugue",
				state: "running",
				startedAt: typeof data?.startedAt === "number" ? data.startedAt : undefined,
			});
		}
		notices = startNotices(pi, ctx, roster);
		if (process.env.FUGUE_E2E_DIR) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			await writeFile(join(process.env.FUGUE_E2E_DIR, "session.txt"), sessionFile ?? ctx.sessionManager.getSessionId());
			await writeFile(join(process.env.FUGUE_E2E_DIR, "ready"), String(Date.now()));
		}
		const holdMs = Number(process.env.FUGUE_E2E_HOLD_MS ?? "0");
		if (Number.isFinite(holdMs) && holdMs > 0) {
			// Keep the session (and the 5 s notice grace) alive until pi -p would exit.
			pi.on("agent_before_settle", () => delay(holdMs));
		}
	});

	pi.on("turn_start", (_event, ctx) => {
		if (process.env.FUGUE_E2E_SPAWN !== "1" || spawned) return;
		spawned = true;
		void withRetry(() => spawnSleepy(ctx), 20, 500);
	});

	pi.on("session_shutdown", () => {
		notices?.dispose();
		notices = undefined;
	});
}

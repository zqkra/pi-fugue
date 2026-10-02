/**
 * `/fugue` opens the Score panel; `/fugue doctor` prints engine health
 * (DESIGN §2 Commands): pi-subagents version, RPC ping, fleetView setting,
 * temp root, voice counts, poll timer, owner-id set size.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkCompatibility, piSubagentsVersion } from "./compat.ts";
import { ownerIds } from "./owners.ts";
import { activeWorktreeLines } from "./worktrees.ts";
import { tempRoot } from "./paths.ts";
import type { BridgeLike, Store } from "./store.ts";
import { TERMINAL_STATES } from "./types.ts";

export interface CommandDeps {
	store: Store;
	bridge: BridgeLike;
	openPanel(): Promise<void>;
}

export function registerCommands(pi: ExtensionAPI, getDeps: () => CommandDeps | undefined): void {
	pi.registerCommand("fugue", {
		description: "Open the Score panel; /fugue doctor prints engine health",
		handler: async (args, ctx) => {
			const deps = getDeps();
			if (!deps) {
				ctx.ui.notify("Fugue has no active session", "warning");
				return;
			}
			if (args.trim() === "doctor") {
				ctx.ui.notify(await doctorReport(deps), "info");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The Score panel needs interactive mode", "warning");
				return;
			}
			await deps.openPanel();
		},
	});
}

async function doctorReport(deps: CommandDeps): Promise<string> {
	const lines = ["fugue doctor"];
	const version = await readJson(join(getAgentDir(), "pi-subagents", "last-seen-version.json"));
	lines.push(`pi-subagents: ${typeof version?.version === "string" ? version.version : "unknown"}`);
	const compat = await checkCompatibility(deps.bridge, tempRoot());
	if (compat.ok) {
		lines.push(`compat: ok (pi-subagents ${(await piSubagentsVersion()) ?? "unknown"})`);
	} else {
		lines.push(`compat: ${compat.problems.length} problem${compat.problems.length === 1 ? "" : "s"} (pi-subagents ${(await piSubagentsVersion()) ?? "unknown"})`);
		for (const problem of compat.problems) lines.push(`- ${problem}`);
	}
	try {
		const ping = await deps.bridge.request<{ methods?: unknown }>("ping", {});
		const methods = Array.isArray(ping?.methods) ? ping.methods.join(",") : "?";
		lines.push(`rpc ping: ok (${methods})`);
	} catch (error) {
		lines.push(`rpc ping: ${error instanceof Error ? error.message : String(error)}`);
	}
	const configPath = join(getAgentDir(), "extensions", "subagent", "config.json");
	const config = await readJson(configPath);
	const fleetView = config?.fleetView !== false;
	lines.push(
		fleetView
			? `fleetView: true (config ${configPath}) — pi-subagents draws its own compact line; set "fleetView": false for a single Score`
			: `fleetView: false (config ${configPath})`,
	);
	lines.push(`temp root: ${tempRoot()}`);
	const snapshot = deps.store.snapshot();
	const active = snapshot.voices.filter((voice) => !TERMINAL_STATES.has(voice.state)).length;
	lines.push(`riffs: ${snapshot.voices.length} (${active} active)`);
	lines.push(`poll timer: ${deps.store.polling() ? "running" : "idle"}`);
	lines.push(`owner ids: ${ownerIds().size}`);
	lines.push(...(await activeWorktreeLines(snapshot.voices)));
	return lines.join("\n");
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

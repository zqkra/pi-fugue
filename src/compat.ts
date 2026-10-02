/**
 * Compatibility guard: Fugue reaches into pi-subagents through the event-bus
 * RPC and the on-disk `status.json` shape. A pi-subagents release can move
 * either of them, so after the first turn Fugue checks what it can see, warns
 * once on drift, and exposes the same result in `/fugue doctor`. Checks report;
 * they never throw at the caller.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tempRoot } from "./paths.ts";
import type { BridgeLike } from "./store.ts";

export interface CompatibilityReport {
	ok: boolean;
	problems: string[];
}

export interface CompatibilityOptions {
	/** Version override for tests; read from the installed package otherwise. */
	version?: string;
}

/** RPC methods Fugue calls; `spawn` and `resume` also carry every riff. */
const REQUIRED_METHODS = ["spawn", "steer", "stop", "resume"] as const;
/** RPC capabilities Fugue relies on: async launch, steering, stopping, reviving. */
const REQUIRED_CAPABILITIES = ["asyncSpawn", "steer", "stop", "resume"] as const;

/** Fugue is verified against pi-subagents 0.74.0 and later 0.x releases. */
const TESTED_MAJOR = 0;
const TESTED_MINOR = 74;

const nodeRequire = createRequire(import.meta.url);

/** `pi-subagents/package.json` as Pi resolves it, else the managed install path. */
export function piSubagentsPackageJson(): string {
	try {
		return nodeRequire.resolve("pi-subagents/package.json");
	} catch {
		return join(getAgentDir(), "npm", "node_modules", "pi-subagents", "package.json");
	}
}

let versionRead: Promise<string | undefined> | undefined;

/** Installed pi-subagents version, read once per process. */
export function piSubagentsVersion(): Promise<string | undefined> {
	versionRead ??= readInstalledVersion();
	return versionRead;
}

async function readInstalledVersion(): Promise<string | undefined> {
	try {
		const pkg = JSON.parse(await readFile(piSubagentsPackageJson(), "utf8")) as { version?: unknown };
		return typeof pkg.version === "string" && pkg.version ? pkg.version : undefined;
	} catch {
		return undefined;
	}
}

/** Version problems; empty when the installed version is known-tested. */
export function versionProblems(version: string | undefined): string[] {
	const match = version ? /^(\d+)\.(\d+)(?:\.|$)/.exec(version) : undefined;
	if (!match) return ["installed pi-subagents version is missing or unreadable"];
	if (Number(match[1]) !== TESTED_MAJOR || Number(match[2]) < TESTED_MINOR) {
		return ["installed version is outside the tested range (0.74+)"];
	}
	return [];
}

/** Problems with a `ping` reply: missing methods or capabilities. Pure. */
export function validatePing(payload: unknown): string[] {
	if (!isRecord(payload)) return ["rpc ping returned no payload"];
	const problems: string[] = [];
	const methods = Array.isArray(payload.methods) ? payload.methods.filter((method): method is string => typeof method === "string") : [];
	const missingMethods = REQUIRED_METHODS.filter((method) => !methods.includes(method));
	if (missingMethods.length > 0) problems.push(`rpc is missing methods: ${missingMethods.join(", ")}`);
	const capabilities = isRecord(payload.capabilities) ? payload.capabilities : {};
	const missingCapabilities = REQUIRED_CAPABILITIES.filter((capability) => capabilities[capability] !== true);
	if (missingCapabilities.length > 0) problems.push(`rpc is missing capabilities: ${missingCapabilities.join(", ")}`);
	return problems;
}

/**
 * Problems with the `status.json` shape Fugue reads: lifecycle artifact
 * version plus the state, lane, pid and step fields the Score needs. Pure.
 */
export function validateStatusShape(status: unknown): string[] {
	if (!isRecord(status)) return ["status.json is not an object"];
	const problems: string[] = [];
	if (status.lifecycleArtifactVersion !== 3) {
		problems.push(`lifecycleArtifactVersion is ${describe(status.lifecycleArtifactVersion)} (expected 3)`);
	}
	if (typeof status.state !== "string") problems.push("state is missing");
	if (typeof status.pid !== "number") problems.push("pid is missing");
	if (!isRecord(status.lane) || typeof status.lane.key !== "string") problems.push("lane.key is missing");
	const steps = Array.isArray(status.steps) ? status.steps : [];
	const step = steps.length > 0 && isRecord(steps[0]) ? steps[0] : undefined;
	if (!step) {
		problems.push("steps[0] is missing");
		return problems;
	}
	if (!isRecord(step.tokens) || typeof step.tokens.window !== "number") problems.push("steps[0].tokens.window is missing");
	if (typeof step.contextLimit !== "number") problems.push("steps[0].contextLimit is missing");
	// A run that never used a tool has no toolCount to report; only a step that
	// did use tools must carry the counter.
	if (!Array.isArray(step.recentTools)) problems.push("steps[0].recentTools is missing");
	else if (step.recentTools.length > 0 && typeof step.toolCount !== "number") problems.push("steps[0].toolCount is missing");
	return problems;
}

/** Check the RPC surface, the installed version and the newest status.json. Never throws. */
export async function checkCompatibility(
	bridge: BridgeLike,
	root: string,
	options: CompatibilityOptions = {},
): Promise<CompatibilityReport> {
	const problems: string[] = [];
	problems.push(...versionProblems(options.version ?? (await piSubagentsVersion())));
	try {
		problems.push(...validatePing(await bridge.request("ping", {})));
	} catch (error) {
		problems.push(`rpc ping failed: ${errorMessage(error)}`);
	}
	const status = await readNewestStatus(root);
	if (status.problem) problems.push(status.problem);
	else if (status.value !== undefined) {
		problems.push(...validateStatusShape(status.value).map((problem) => `newest status.json: ${problem}`));
	}
	return { ok: problems.length === 0, problems };
}

interface StatusRead {
	value?: unknown;
	problem?: string;
}

async function readNewestStatus(root: string): Promise<StatusRead> {
	const runsDir = join(root, "async-subagent-runs");
	let runs: string[];
	try {
		runs = await readdir(runsDir);
	} catch {
		return {};
	}
	let newest: { path: string; mtimeMs: number } | undefined;
	for (const run of runs) {
		const path = join(runsDir, run, "status.json");
		try {
			const info = await stat(path);
			if (info.isFile() && (!newest || info.mtimeMs > newest.mtimeMs)) newest = { path, mtimeMs: info.mtimeMs };
		} catch {
			// A run that has not written its status yet says nothing about the contract.
		}
	}
	if (!newest) return {};
	try {
		return { value: JSON.parse(await readFile(newest.path, "utf8")) as unknown };
	} catch (error) {
		return { problem: `newest status.json is unreadable: ${errorMessage(error)}` };
	}
}

const CHECKED_KEY = Symbol.for("fugue.compat-checked.v1");

/**
 * After the first turn (pi-subagents answers `no_active_session` before it has
 * bound a context; the bridge retries that briefly), run the check once per
 * process and warn on one line if the contract moved. Never blocks or throws.
 */
export function watchCompatibility(pi: ExtensionAPI, bridge: BridgeLike, ctx: ExtensionContext): void {
	const g = globalThis as Record<symbol, unknown>;
	if (g[CHECKED_KEY] === true) return;
	try {
		const off = pi.on("turn_end", async () => {
			off();
			// Await inside the handler: the session context stays valid until it resolves.
			await reportCompatibility(bridge, ctx);
		});
		g[CHECKED_KEY] = true;
	} catch (error) {
		console.error("fugue compatibility check could not be scheduled:", errorMessage(error));
	}
}

async function reportCompatibility(bridge: BridgeLike, ctx: ExtensionContext): Promise<void> {
	try {
		const report = await checkCompatibility(bridge, tempRoot());
		if (report.ok) return;
		const version = (await piSubagentsVersion()) ?? "unknown";
		ctx.ui.notify(`fugue: pi-subagents ${version} differs from what Fugue expects: ${report.problems[0]} (/fugue doctor)`, "warning");
	} catch (error) {
		console.error("fugue compatibility check failed:", errorMessage(error));
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
	return value === undefined ? "missing" : JSON.stringify(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Where pi-subagents keeps its run state. Mirrors `TEMP_ROOT_DIR`, `ASYNC_DIR`
 * and `RESULTS_DIR` in pi-subagents' `src/shared/types.js`.
 */

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function scopeSegment(value: string): string {
	const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

/** pi-subagents temp root, mirroring `TEMP_ROOT_DIR` in its `shared/types.js`. */
export function tempRoot(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	if (configured) return resolve(configured);
	const getuid = process.getuid;
	if (typeof getuid === "function") return join(tmpdir(), `pi-subagents-uid-${getuid()}`);
	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return join(tmpdir(), `pi-subagents-user-${scopeSegment(value)}`);
	}
	const home = env.USERPROFILE ?? env.HOME;
	return join(tmpdir(), `pi-subagents-${home ? `home-${scopeSegment(home)}` : "shared"}`);
}

export function resultsDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(tempRoot(env), "async-subagent-results");
}

export function asyncDirForRun(root: string, runId: string): string {
	return join(root, "async-subagent-runs", runId);
}

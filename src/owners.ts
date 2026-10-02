/**
 * Completion owner ids that pi-subagents used in THIS Pi process. A result file
 * whose owner is in this set can still be delivered by pi-subagents itself; any
 * other owner belongs to a dead process. Kept on globalThis so the set survives
 * /reload and /resume, which re-create extension instances in the same process.
 */

const KEY = Symbol.for("fugue.owner-ids.v1");

export function ownerIds(): Set<string> {
	const g = globalThis as Record<symbol, unknown>;
	let set = g[KEY] as Set<string> | undefined;
	if (!set) {
		set = new Set();
		g[KEY] = set;
	}
	return set;
}

export function recordOwner(id: unknown): void {
	if (typeof id === "string" && id) ownerIds().add(id);
}

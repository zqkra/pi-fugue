/**
 * Keeps the conductor's chat free while children work, like bb: the owner can
 * always keep talking. pi-subagents offers two ways to lock the turn until a
 * child settles, a blocking `bg_wait` and a foreground launch (`async: false`).
 * Fugue voices report back with a notification that starts a new turn, so
 * both only lock the owner out.
 */

import { TERMINAL_STATES, type Voice } from "./types.ts";

export const BG_WAIT_BLOCK_REASON =
	"Blocked by Fugue: riffs report back on their own with a notification that starts a new turn. " +
	"End your turn now so the owner can keep talking. Use riff_status for a snapshot.";

/** Reason to block a `bg_wait` call, or undefined to let it run. */
export function bgWaitBlockReason(input: Record<string, unknown>, voices: readonly Voice[]): string | undefined {
	if (input.nonBlocking === true) return undefined;
	const active = voices.filter((voice) => !TERMINAL_STATES.has(voice.state));
	if (active.length === 0) return undefined;
	const id = typeof input.id === "string" ? input.id.trim() : "";
	if (!id) return BG_WAIT_BLOCK_REASON;
	return active.some((voice) => voice.runId.startsWith(id)) ? BG_WAIT_BLOCK_REASON : undefined;
}

/**
 * Turn a foreground `subagent` launch into a background one, in place. Leaves
 * management actions and `clarify` launches (an interactive dialog with the
 * owner) alone. Returns true when the input changed.
 */
export function forceBackground(input: Record<string, unknown>): boolean {
	if (input.action !== undefined || input.clarify === true || input.async === true) return false;
	input.async = true;
	return true;
}

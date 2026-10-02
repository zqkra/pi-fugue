/**
 * Voice naming (DESIGN §1): normalize, validate, and allocate unique short
 * handles. Names are the only way the conductor refers to a voice, so they stay
 * unique across every voice of a session, live or settled.
 */

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,19}$/;
const MAX_NAME_LENGTH = 20;

export type NameResult = { ok: true; name: string } | { ok: false; error: string };

/** Lowercase, trim, and turn spaces/underscores into dashes. */
export function normalizeName(raw: string): string {
	return raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function parseName(raw: string): NameResult {
	const name = normalizeName(raw);
	if (name.length === 0) return { ok: false, error: "a riff name is required" };
	if (!NAME_PATTERN.test(name)) {
		return {
			ok: false,
			error: `"${name}" must start with a letter, use only a-z, 0-9 and dashes, and be at most ${MAX_NAME_LENGTH} characters`,
		};
	}
	return { ok: true, name };
}

/** Append -2, -3, ... until the name is free, keeping every candidate valid. */
export function allocateName(preferred: string, isTaken: (name: string) => boolean): string {
	if (!isTaken(preferred)) return preferred;
	for (let n = 2; ; n += 1) {
		const suffix = `-${n}`;
		const candidate = `${preferred.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
		if (!isTaken(candidate)) return candidate;
	}
}

/** Name for a raw run Fugue only observed: lane key, else role, else "voice". */
export function fallbackName(laneKey: string | undefined, role: string, isTaken: (name: string) => boolean): string {
	if (laneKey) {
		const lane = parseName(laneKey);
		if (lane.ok) return allocateName(lane.name, isTaken);
	}
	const roleName = parseName(role);
	return allocateName(roleName.ok ? roleName.name : "voice", isTaken);
}

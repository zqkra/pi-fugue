/**
 * Realistic ScoreSnapshots for UI tests and snapshot files. Times are relative
 * to `FIXTURE_NOW` so renders are deterministic.
 */

import type { MessageEdge, ScoreSnapshot, TokenUsage, Voice } from "../../src/types.ts";

export const FIXTURE_NOW = 1_700_000_000_000;

function tokens(total: number): TokenUsage {
	const input = Math.round(total * 0.85);
	return { input, output: total - input, total };
}

function voice(partial: Partial<Voice> & Pick<Voice, "runId" | "name" | "role" | "state">): Voice {
	return { parent: "conductor", origin: "fugue", ...partial };
}

/** One running worker. */
export function fixture1(): ScoreSnapshot {
	const auth = voice({
		runId: "run-auth",
		name: "auth",
		role: "worker",
		state: "running",
		model: "opencode-go/deepseek-v4.1-flash",
		thinking: "low",
		task: "Tighten the auth middleware and keep the response shape unchanged",
		startedAt: FIXTURE_NOW - 252_000,
		tokens: tokens(21_000),
		costUsd: 0.03,
		activity: { kind: "writing", detail: "src/auth/middleware.ts" },
	});
	return {
		conductor: { model: "claude-opus-5-5", thinking: "medium" },
		voices: [auth],
		edges: [],
		version: 1,
	};
}

/** The DESIGN §5.2 example: four top-level voices and one nested voice. */
export function fixture5(): ScoreSnapshot {
	const auth = voice({
		runId: "run-auth",
		name: "auth",
		role: "worker",
		state: "running",
		model: "opencode-go/deepseek-v4.1-flash",
		thinking: "low",
		task: "Tighten the auth middleware and keep the response shape unchanged",
		startedAt: FIXTURE_NOW - 252_000,
		tokens: tokens(21_000),
		costUsd: 0.03,
		activity: { kind: "writing", detail: "src/auth/middleware.ts" },
	});
	const db = voice({
		runId: "run-db",
		name: "db",
		role: "scout",
		state: "blocked",
		model: "opencode-go/deepseek-v4.1-flash",
		task: "Decide the storage engine for the audit log",
		startedAt: FIXTURE_NOW - 160_000,
		tokens: tokens(12_000),
		costUsd: 0.01,
		activity: { kind: "thinking" },
		question: { id: "q-db", message: "Postgres or SQLite?", at: FIXTURE_NOW - 120_000 },
	});
	const review = voice({
		runId: "run-review",
		name: "review",
		role: "reviewer",
		state: "running",
		model: "claude-opus-5-5",
		thinking: "medium",
		task: "Review the auth diff",
		startedAt: FIXTURE_NOW - 63_000,
		tokens: tokens(9_000),
		costUsd: 0.05,
		activity: { kind: "reading", detail: "src/auth/session.ts" },
	});
	const scout = voice({
		runId: "run-scout",
		name: "scout",
		role: "scout",
		state: "done",
		model: "claude-haiku-4-5",
		startedAt: FIXTURE_NOW - 96_000,
		endedAt: FIXTURE_NOW - 48_000,
		tokens: tokens(3_000),
		costUsd: 0,
		summary: "found 3 candidate files",
	});
	const authTests = voice({
		runId: "run-auth-tests",
		name: "auth-tests",
		role: "reviewer",
		state: "running",
		parent: "run-auth",
		model: "claude-haiku-4-5",
		startedAt: FIXTURE_NOW - 21_000,
		tokens: tokens(2_000),
		costUsd: 0.01,
		activity: { kind: "reading", detail: "test/auth.test.ts" },
	});
	const edges: MessageEdge[] = [
		{ from: "run-db", to: "conductor", kind: "asked", at: FIXTURE_NOW - 120_000, text: "Postgres or SQLite?" },
		{ from: "conductor", to: "run-auth", kind: "steered", at: FIXTURE_NOW - 90_000, text: "keep the existing session shape" },
		{ from: "run-auth", to: "run-auth-tests", kind: "told", at: FIXTURE_NOW - 20_000, text: "focus on the refresh path" },
	];
	return {
		conductor: { model: "claude-opus-5-5", thinking: "medium" },
		voices: [auth, db, review, scout, authTests],
		edges,
		version: 7,
	};
}

/** Fifteen voices: every state, two parents with children, wrapped rows. */
export function fixture15(): ScoreSnapshot {
	const auth = voice({
		runId: "run-auth",
		name: "auth",
		role: "worker",
		state: "running",
		model: "opencode-go/deepseek-v4.1-flash",
		startedAt: FIXTURE_NOW - 252_000,
		tokens: tokens(21_000),
		costUsd: 0.03,
		activity: { kind: "writing", detail: "src/auth/middleware.ts" },
	});
	const db = voice({
		runId: "run-db",
		name: "db",
		role: "scout",
		state: "blocked",
		model: "opencode-go/deepseek-v4.1-flash",
		startedAt: FIXTURE_NOW - 160_000,
		tokens: tokens(12_000),
		costUsd: 0.01,
		question: { id: "q-db", message: "Postgres or SQLite?", at: FIXTURE_NOW - 120_000 },
	});
	const review = voice({
		runId: "run-review",
		name: "review",
		role: "reviewer",
		state: "running",
		model: "claude-opus-5-5",
		startedAt: FIXTURE_NOW - 63_000,
		tokens: tokens(9_000),
		costUsd: 0.05,
		activity: { kind: "reading", detail: "src/auth/session.ts" },
	});
	const scout = voice({
		runId: "run-scout",
		name: "scout",
		role: "scout",
		state: "done",
		model: "claude-haiku-4-5",
		startedAt: FIXTURE_NOW - 96_000,
		endedAt: FIXTURE_NOW - 48_000,
		tokens: tokens(3_000),
		costUsd: 0,
	});
	const tests = voice({
		runId: "run-tests",
		name: "tests",
		role: "worker",
		state: "running",
		model: "opencode-go/deepseek-v4.1-flash",
		startedAt: FIXTURE_NOW - 190_000,
		tokens: tokens(15_000),
		costUsd: 0.02,
		activity: { kind: "running", detail: "npm test -- auth" },
	});
	const docs = voice({
		runId: "run-docs",
		name: "docs",
		role: "worker",
		state: "queued",
		model: "opencode-go/deepseek-v4.1-flash",
	});
	const api = voice({
		runId: "run-api",
		name: "api",
		role: "worker",
		state: "failed",
		model: "opencode-go/deepseek-v4.1-flash",
		startedAt: FIXTURE_NOW - 320_000,
		endedAt: FIXTURE_NOW - 160_000,
		tokens: tokens(5_000),
		costUsd: 0.01,
		error: "TS2307: Cannot find module './schema' in src/api.ts",
	});
	const ui = voice({
		runId: "run-ui",
		name: "ui",
		role: "worker",
		state: "running",
		model: "opencode-go/deepseek-v4.1-flash",
		startedAt: FIXTURE_NOW - 90_000,
		tokens: tokens(8_000),
		costUsd: 0.01,
		activity: { kind: "writing", detail: "src/ui/panel.ts" },
	});
	const perf = voice({
		runId: "run-perf",
		name: "perf",
		role: "scout",
		state: "running",
		model: "opencode-go/deepseek-v4.1-flash",
		startedAt: FIXTURE_NOW - 40_000,
		tokens: tokens(4_000),
		costUsd: 0.01,
		activity: { kind: "searching", detail: "render loop" },
	});
	const sec = voice({
		runId: "run-sec",
		name: "sec",
		role: "reviewer",
		state: "queued",
		model: "claude-opus-5-5",
	});
	const data = voice({
		runId: "run-data",
		name: "data",
		role: "worker",
		state: "done",
		model: "claude-sonnet-4-5",
		startedAt: FIXTURE_NOW - 720_000,
		endedAt: FIXTURE_NOW - 360_000,
		tokens: tokens(30_000),
		costUsd: 0.12,
		summary: "migrated 4 tables",
	});
	const authTests = voice({
		runId: "run-auth-tests",
		name: "auth-tests",
		role: "reviewer",
		state: "running",
		parent: "run-auth",
		model: "claude-haiku-4-5",
		startedAt: FIXTURE_NOW - 21_000,
		tokens: tokens(2_000),
		costUsd: 0.01,
		activity: { kind: "reading", detail: "test/auth.test.ts" },
	});
	const authFixtures = voice({
		runId: "run-auth-fixtures",
		name: "auth-fixtures",
		role: "worker",
		state: "queued",
		parent: "run-auth",
		model: "opencode-go/deepseek-v4.1-flash",
	});
	const dbSqlite = voice({
		runId: "run-db-sqlite",
		name: "db-sqlite",
		role: "scout",
		state: "done",
		parent: "run-db",
		model: "opencode-go/deepseek-v4.1-flash",
		startedAt: FIXTURE_NOW - 60_000,
		endedAt: FIXTURE_NOW - 30_000,
		tokens: tokens(1_000),
		costUsd: 0,
	});
	const reviewA11y = voice({
		runId: "run-review-a11y",
		name: "review-a11y",
		role: "reviewer",
		state: "running",
		parent: "run-review",
		model: "claude-haiku-4-5",
		startedAt: FIXTURE_NOW - 12_000,
		tokens: tokens(1_000),
		costUsd: 0,
		activity: { kind: "writing", detail: "src/ui/a11y.md" },
	});
	const edges: MessageEdge[] = [
		{ from: "run-db", to: "conductor", kind: "asked", at: FIXTURE_NOW - 120_000, text: "Postgres or SQLite?" },
		{ from: "conductor", to: "run-auth", kind: "steered", at: FIXTURE_NOW - 90_000, text: "keep the existing session shape" },
		{ from: "run-auth", to: "run-auth-tests", kind: "told", at: FIXTURE_NOW - 20_000, text: "focus on the refresh path" },
		{ from: "conductor", to: "run-ui", kind: "told", at: FIXTURE_NOW - 15_000, text: "match the footer spacing" },
	];
	return {
		conductor: { model: "claude-opus-5-5", thinking: "medium" },
		voices: [
			auth,
			db,
			review,
			scout,
			tests,
			docs,
			api,
			ui,
			perf,
			sec,
			data,
			authTests,
			authFixtures,
			dbSqlite,
			reviewA11y,
		],
		edges,
		version: 15,
	};
}

export const FIXTURES: Array<{ name: string; build: () => ScoreSnapshot }> = [
	{ name: "1", build: fixture1 },
	{ name: "5", build: fixture5 },
	{ name: "15", build: fixture15 },
];

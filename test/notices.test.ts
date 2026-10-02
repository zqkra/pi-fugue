import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import {
	buildNoticeContent,
	candidateFiles,
	extractDeliveredRunIds,
	formatDuration,
	isCandidate,
	NOTICE_CUSTOM_TYPE,
	noticeLine,
	noticeThemeLine,
	registerNoticeRenderer,
	type NoticeDetails,
	type NoticeVoice,
	type ResultPayload,
} from "../src/notices.ts";
import { resultsDir, tempRoot } from "../src/paths.ts";

// Real-shaped fixtures derived from the captured completion replay at
// /tmp/pi-subagents-uid-1000/async-subagent-results/completion-replay/0a6bb1f0-…json
// (its `completion` object plus the identity fields the runner writes).
const SESSION_FILE =
	"/home/user/.pi/agent/sessions/--home-user-Projects-demo--/2026-10-02T08-13-54-863Z_01a0fbad-512d-74e9-974d-3e2859a7e937.jsonl";
const OUTPUT_PATH =
	"/home/user/.pi/agent/sessions/--home-user-Projects-demo--/subagent-artifacts/0a6bb1f0-5767-494f-9f5c-19d7c99fde76_scout_output.md";

const completePayload: ResultPayload = {
	id: "0a6bb1f0-5767-494f-9f5c-19d7c99fde76",
	runId: "0a6bb1f0-5767-494f-9f5c-19d7c99fde76",
	sessionId: SESSION_FILE,
	completionOwnerId: "4d1f2e3a-1111-4222-8333-444455556666",
	state: "complete",
	success: true,
	timestamp: 1790928844629,
	durationMs: 252_000,
	asyncDir: "/tmp/pi-subagents-uid-1000/async-subagent-runs/0a6bb1f0-5767-494f-9f5c-19d7c99fde76",
	cwd: "/home/user/Projects/demo",
	sessionFile:
		"/home/user/.pi/agent/sessions/--home-user-Projects-demo--/2026-10-02T08-13-54-863Z_01a0fbad-512d-74e9-974d-3e2859a7e937/8ddb1415-6b60-4953-89c3-ddbe4538ea67/run-0/session.jsonl",
	agent: "scout",
	summary: "Mapped the result-file write and delivery path.",
	results: [
		{
			agent: "scout",
			usage: { input: 2848, output: 528, cacheRead: 0, cacheWrite: 0, cost: 0.000744, turns: 1 },
			success: true,
			outputState: "present",
			model: "opencode-go/deepseek-v4.1-flash:low",
			artifactPaths: { outputPath: OUTPUT_PATH },
		},
	],
};

const failedPayload: ResultPayload = {
	...completePayload,
	id: "7d2523d9-b419-48f6-8af7-ceaa1e042636",
	runId: "7d2523d9-b419-48f6-8af7-ceaa1e042636",
	state: "failed",
	success: false,
	durationMs: 160_000,
	summary: "2 tests failed",
	error: "test/gates.test.ts:12 — expected exit 0, got 1",
	results: [
		{
			agent: "worker",
			success: false,
			outputState: "present",
			model: "opencode-go/deepseek-v4.1-flash:low",
			error: "test/gates.test.ts:12 — expected exit 0, got 1",
			artifactPaths: { outputPath: OUTPUT_PATH.replace("scout", "worker") },
		},
	],
};

const NOW = 1_800_000_000_000;
const context = {
	sessionId: SESSION_FILE,
	owners: new Set(["some-other-owner"]),
	now: NOW,
	fileMtimeMs: NOW - 60_000,
};

test("formatDuration matches the Score vocabulary", () => {
	assert.equal(formatDuration(48_000), "48s");
	assert.equal(formatDuration(252_000), "4m12s");
	assert.equal(formatDuration(160_000), "2m40s");
	assert.equal(formatDuration(3_720_000), "1h02m");
	assert.equal(formatDuration(0), "0s");
});

test("isCandidate accepts an orphaned, unmarked completion from this session", () => {
	assert.equal(isCandidate(completePayload, context), true);
	assert.equal(isCandidate(completePayload, { ...context, fileMtimeMs: NOW - 10_000 }), true);
});

test("isCandidate rejects other sessions, delivered payloads and live owners", () => {
	assert.equal(isCandidate(completePayload, { ...context, sessionId: "/other/session.jsonl" }), false);
	assert.equal(isCandidate({ ...completePayload, sessionId: undefined }, context), false);
	assert.equal(isCandidate({ ...completePayload, notificationDeliveredAt: NOW - 1_000 }, context), false);
	assert.equal(isCandidate(completePayload, { ...context, owners: new Set(["4d1f2e3a-1111-4222-8333-444455556666"]) }), false);
});

test("tempRoot mirrors pi-subagents scoping and honors the env override", () => {
	assert.equal(tempRoot({ PI_SUBAGENTS_TEMP_ROOT: "/tmp/custom-root" } as NodeJS.ProcessEnv), "/tmp/custom-root");
	assert.equal(resultsDir({ PI_SUBAGENTS_TEMP_ROOT: "/tmp/custom-root" } as NodeJS.ProcessEnv), join("/tmp/custom-root", "async-subagent-results"));
	if (typeof process.getuid === "function") {
		assert.equal(tempRoot({} as NodeJS.ProcessEnv), join(tmpdir(), `pi-subagents-uid-${process.getuid()}`));
	}
});

test("isCandidate enforces the 5 s age floor on timestamp or file mtime", () => {
	assert.equal(isCandidate({ ...completePayload, timestamp: NOW - 1_000 }, context), false);
	assert.equal(isCandidate({ ...completePayload, timestamp: undefined }, { ...context, fileMtimeMs: NOW - 1_000 }), false);
	assert.equal(isCandidate({ ...completePayload, timestamp: undefined }, { ...context, fileMtimeMs: NOW - 5_000 }), true);
	assert.equal(isCandidate({ ...completePayload, timestamp: undefined }, { ...context, fileMtimeMs: NOW - 60_000, minAgeMs: 120_000 }), false);
});

test("isCandidate does not require a completionOwnerId", () => {
	assert.equal(isCandidate({ ...completePayload, completionOwnerId: undefined }, context), true);
	assert.equal(isCandidate({ ...completePayload, completionOwnerId: "" }, context), true);
});

test("extractDeliveredRunIds reads only fugue.notice details.runIds", () => {
	const entries: unknown[] = [
		{ type: "custom_message", customType: NOTICE_CUSTOM_TYPE, details: { runIds: ["a", "b"], voices: [] } },
		{ type: "custom", customType: NOTICE_CUSTOM_TYPE, details: { runIds: ["c"] } },
		{ type: "custom_message", customType: "subagent-notify", details: { runIds: ["d"] } },
		{ type: "custom_message", customType: NOTICE_CUSTOM_TYPE, details: {} },
		{ type: "custom_message", customType: NOTICE_CUSTOM_TYPE, details: { runIds: ["e", 7, null] } },
		null,
		"nope",
	];
	assert.deepEqual([...extractDeliveredRunIds(entries)].sort(), ["a", "b", "e"]);
});

const voices: NoticeVoice[] = [
	{ runId: "r1", name: "auth", role: "writer", state: "done", durationMs: 252_000, summary: "wrote it", outputPath: "/tmp/a.md" },
	{ runId: "r2", name: "db", role: "scout", state: "failed", durationMs: 160_000, summary: "tests failed", outputPath: "/tmp/b.md" },
];

test("noticeLine matches the one-line renderer format", () => {
	assert.equal(noticeLine(voices), "while away: auth done 4m12s · db failed 2m40s");
	assert.equal(noticeLine([]), "while away: no completions");
});

test("buildNoticeContent names each voice with state, duration, summary and output", () => {
	const content = buildNoticeContent(voices);
	const lines = content.split("\n");
	assert.equal(lines[0], "while away: auth done 4m12s · db failed 2m40s");
	assert.ok(content.includes("auth (writer) done in 4m12s"));
	assert.ok(content.includes("wrote it"));
	assert.ok(content.includes("output: /tmp/a.md"));
	assert.ok(content.includes("db (scout) failed in 2m40s"));
	assert.ok(content.includes("tests failed"));
	assert.ok(content.includes("output: /tmp/b.md"));
});

test("noticeThemeLine uses state tokens and dim separators", () => {
	const theme = { fg: (token: string, text: string) => `[${token}]${text}[/]` };
	const details: NoticeDetails = {
		runIds: ["r1", "r2"],
		voices: [
			{ name: "auth", role: "writer", state: "done", durationMs: 252_000 },
			{ name: "db", role: "scout", state: "failed", durationMs: 160_000 },
		],
	};
	assert.equal(
		noticeThemeLine(details, theme),
		"[dim]while away: [/][text]auth[/] [success]done[/] [dim]4m12s[/][dim] · [/][text]db[/] [error]failed[/] [dim]2m40s[/]",
	);
});

type Renderer = MessageRenderer<NoticeDetails>;

test("notice renderer emits one truncated line", () => {
	let renderer: Renderer | undefined;
	const pi = {
		registerMessageRenderer(_type: string, value: Renderer) {
			renderer = value;
		},
	} as unknown as ExtensionAPI;
	registerNoticeRenderer(pi);
	assert.ok(renderer);

	const message = {
		role: "custom" as const,
		customType: NOTICE_CUSTOM_TYPE,
		content: "notice body",
		display: true,
		details: { runIds: ["r1", "r2"], voices: voices.map(({ name, role, state, durationMs }) => ({ name, role, state, durationMs })) },
		timestamp: NOW,
	};
	const fakeTheme = { fg: (_token: string, text: string) => text } as unknown as Parameters<Renderer>[2];
	const line = renderer(message, { expanded: false, outputPad: 0 }, fakeTheme);
	assert.ok(line);
	const [full] = line.render(200);
	assert.equal(full, "while away: auth done 4m12s · db failed 2m40s");
	const [narrow] = line.render(12);
	assert.ok(visibleWidth(narrow) <= 12);

	const fallback = renderer({ ...message, details: undefined }, { expanded: false, outputPad: 0 }, fakeTheme);
	assert.ok(fallback);
	assert.deepEqual(fallback.render(80), ["while away: no completions"]);
});

test("failed fixture is rejected once marked delivered", () => {
	assert.equal(isCandidate(failedPayload, context), true);
	assert.equal(isCandidate({ ...failedPayload, notificationDeliveredAt: NOW }, context), false);
});

test("candidateFiles reads public results and pending copies only", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fugue-notices-"));
	try {
		await writeFile(join(dir, "run-public.json"), "{}");
		await writeFile(join(dir, "notes.txt"), "not json");
		await mkdir(join(dir, "result-pending", "~sha256-abc"), { recursive: true });
		await writeFile(join(dir, "result-pending", "~sha256-abc", "run-pending.json"), "{}");
		await mkdir(join(dir, "result-index", "runs"), { recursive: true });
		await writeFile(join(dir, "result-index", "runs", "run-index.json"), "{}");
		await mkdir(join(dir, "completion-replay"), { recursive: true });
		await writeFile(join(dir, "completion-replay", "run-replay.json"), "{}");
		const files = (await candidateFiles(dir)).map((path) => relative(dir, path)).sort();
		assert.deepEqual(files, ["result-pending/~sha256-abc/run-pending.json", "run-public.json"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
	formatGateReport,
	parseGateConfig,
	registerGates,
	runGate,
	selectGates,
	tailText,
} from "../src/gates.ts";
import type { GateCheck, GateReport } from "../src/types.ts";

interface GateToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: GateReport;
	isError?: boolean;
}

interface GateTool {
	execute(
		toolCallId: string,
		params: { cwd?: string; only?: string[] },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionToolContext,
	): Promise<GateToolResult>;
}

function captureGateTool(): { tool: GateTool; reports: GateReport[] } {
	let captured: GateTool | undefined;
	const reports: GateReport[] = [];
	const pi = {
		registerTool(value: unknown) {
			captured = value as GateTool;
		},
	} as unknown as ExtensionAPI;
	registerGates(pi, (report) => reports.push(report));
	assert.ok(captured);
	return { tool: captured, reports };
}

function toolContext(cwd: string): ExtensionToolContext {
	return { cwd } as ExtensionToolContext;
}

async function tempProject(config: string | undefined): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "fugue-gates-"));
	if (config !== undefined) {
		await mkdir(join(dir, ".pi"), { recursive: true });
		await writeFile(join(dir, ".pi", "fugue.json"), config);
	}
	return dir;
}

test("parseGateConfig accepts valid config and defaults the timeout", () => {
	const parsed = parseGateConfig('{"gates":[{"name":"build","run":"npm run build"}]}');
	assert.deepEqual(parsed, { ok: true, value: { gates: [{ name: "build", run: "npm run build", timeoutMs: 600_000 }] } });
});

test("parseGateConfig rejects malformed config with a clear message", () => {
	const invalidJson = parseGateConfig("{nope");
	assert.equal(invalidJson.ok, false);
	assert.match(invalidJson.ok ? "" : invalidJson.message, /not valid JSON/);

	const notObject = parseGateConfig("[]");
	assert.equal(notObject.ok, false);
	assert.match(notObject.ok ? "" : notObject.message, /"gates" array/);

	const badName = parseGateConfig('{"gates":[{"name":"","run":"true"}]}');
	assert.match(badName.ok ? "" : badName.message, /name must be a non-empty string/);

	const badRun = parseGateConfig('{"gates":[{"name":"x","run":" "}]}');
	assert.match(badRun.ok ? "" : badRun.message, /run must be a non-empty shell command/);

	const badTimeout = parseGateConfig('{"gates":[{"name":"x","run":"true","timeoutMs":0}]}');
	assert.match(badTimeout.ok ? "" : badTimeout.message, /timeoutMs must be a positive number/);

	const empty = parseGateConfig('{"gates":[]}');
	assert.match(empty.ok ? "" : empty.message, /at least one check/);
});

test("selectGates keeps order, filters by name and rejects unknown names", () => {
	const config = { gates: [
		{ name: "build", run: "true", timeoutMs: 1 },
		{ name: "test", run: "true", timeoutMs: 1 },
	] };
	const all = selectGates(config, undefined);
	assert.deepEqual(all.ok ? all.value.map((gate) => gate.name) : [], ["build", "test"]);
	const only = selectGates(config, ["test"]);
	assert.deepEqual(only.ok ? only.value.map((gate) => gate.name) : [], ["test"]);
	const blank = selectGates(config, [" "]);
	assert.deepEqual(blank.ok ? blank.value.map((gate) => gate.name) : [], ["build", "test"]);
	const unknown = selectGates(config, ["lint"]);
	assert.equal(unknown.ok, false);
	assert.match(unknown.ok ? "" : unknown.message, /Available: build, test/);
});

test("tailText keeps the last 40 lines and drops trailing blanks", () => {
	const text = Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n") + "\n\n";
	const tail = tailText(text);
	const lines = tail.split("\n");
	assert.equal(lines.length, 40);
	assert.equal(lines[0], "line 10");
	assert.equal(lines[39], "line 49");
});

test("formatGateReport shows every check with exit code, duration and tail", () => {
	const checks: GateCheck[] = [
		{ name: "build", command: "npm run build", ok: true, exitCode: 0, durationMs: 812, tail: "built" },
		{ name: "test", command: "npm test", ok: false, exitCode: 1, durationMs: 421, tail: "1 failing", note: "killed by SIGKILL" },
	];
	const report: GateReport = { cwd: "/tmp/proj", at: 1, ok: false, checks };
	const text = formatGateReport(report);
	assert.ok(text.startsWith("gates 1/2 passed in /tmp/proj"));
	assert.ok(text.includes("PASS build (npm run build) exit 0 812ms"));
	assert.ok(text.includes("built"));
	assert.ok(text.includes("FAIL test (npm test) exit 1 421ms killed by SIGKILL"));
	assert.ok(text.includes("1 failing"));
});

test("runGate resolves a timeout as a recorded failure", async () => {
	const startedAt = Date.now();
	const check = await runGate({ name: "slow", run: "sleep 5", timeoutMs: 200 }, { cwd: tmpdir() });
	assert.equal(check.ok, false);
	assert.equal(check.exitCode, null);
	assert.match(check.note ?? "", /timeout after 200ms/);
	assert.ok(Date.now() - startedAt < 4_000);
});

test("fugue_gate runs every check and reports pass and fail", async () => {
	const dir = await tempProject(
		JSON.stringify({
			gates: [
				{ name: "pass", run: "echo pass-tail" },
				{ name: "fail", run: "echo fail-tail; exit 3" },
			],
		}),
	);
	try {
		const { tool, reports } = captureGateTool();
		const result = await tool.execute("call-1", {}, undefined, undefined, toolContext(dir));
		assert.equal(result.isError, true);
		assert.equal(reports.length, 1);
		const report = result.details;
		assert.ok(report);
		assert.equal(report.cwd, dir);
		assert.equal(report.ok, false);
		assert.deepEqual(report.checks.map((check) => check.name), ["pass", "fail"]);
		assert.equal(report.checks[0].ok, true);
		assert.equal(report.checks[0].exitCode, 0);
		assert.ok(report.checks[0].tail.includes("pass-tail"));
		assert.equal(report.checks[1].ok, false);
		assert.equal(report.checks[1].exitCode, 3);
		assert.ok(report.checks[1].tail.includes("fail-tail"));
		const text = result.content[0].text ?? "";
		assert.ok(text.includes("gates 1/2 passed"));
		assert.ok(text.includes("PASS pass"));
		assert.ok(text.includes("FAIL fail"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("fugue_gate only[] runs the selected checks", async () => {
	const dir = await tempProject(
		JSON.stringify({ gates: [
			{ name: "pass", run: "echo pass-tail" },
			{ name: "fail", run: "echo fail-tail; exit 3" },
		] }),
	);
	try {
		const { tool } = captureGateTool();
		const result = await tool.execute("call-2", { only: ["fail"] }, undefined, undefined, toolContext(dir));
		assert.equal(result.isError, true);
		assert.deepEqual(result.details?.checks.map((check) => check.name), ["fail"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("fugue_gate without config explains how to create one", async () => {
	const dir = await tempProject(undefined);
	try {
		const { tool, reports } = captureGateTool();
		const result = await tool.execute("call-3", {}, undefined, undefined, toolContext(dir));
		assert.equal(result.isError, true);
		assert.equal(result.details, undefined);
		assert.match(result.content[0].text ?? "", /\.pi\/fugue\.json/);
		assert.equal(reports.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a timeout kills the whole process group and settles promptly", async () => {
	const started = Date.now();
	const check = await runGate(
		{ name: "hang", run: "sleep 30 & sleep 30; wait", timeoutMs: 300 },
		{ cwd: process.cwd() },
	);
	assert.equal(check.ok, false);
	assert.match(check.note ?? "", /timeout/);
	assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
});

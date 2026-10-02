/**
 * Gates: project checks declared in `.pi/fugue.json`, run sequentially with
 * `bash -lc` in a fixed cwd. Every check is recorded pass or fail with its exit
 * code, duration and output tail; a failing check never stops the rest. The
 * `fugue_gate` tool exposes the report to the conductor and to the Score.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { GateCheck, GateReport } from "./types.ts";

export const DEFAULT_GATE_TIMEOUT_MS = 600_000;
export const GATE_TAIL_LINES = 40;
const MAX_TAIL_CHARS = 512 * 1024;

const CONFIG_EXAMPLE = `{
  "gates": [
    { "name": "build", "run": "npm run build", "timeoutMs": 600000 }
  ]
}`;

export interface GateConfigEntry {
	name: string;
	run: string;
	timeoutMs: number;
}

export interface GateConfig {
	gates: GateConfigEntry[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Parse and validate `.pi/fugue.json` content. Pure, so tests can hit every error. */
export function parseGateConfig(text: string): ParseResult<GateConfig> {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return { ok: false, message: `not valid JSON (${errorMessage(error)})` };
	}
	if (!isRecord(raw) || !Array.isArray(raw.gates)) {
		return { ok: false, message: 'expected an object with a "gates" array' };
	}
	const gates: GateConfigEntry[] = [];
	for (const [index, entry] of raw.gates.entries()) {
		if (!isRecord(entry)) return { ok: false, message: `gates[${index}] must be an object` };
		const { name, run, timeoutMs } = entry;
		if (typeof name !== "string" || !name.trim()) {
			return { ok: false, message: `gates[${index}].name must be a non-empty string` };
		}
		if (typeof run !== "string" || !run.trim()) {
			return { ok: false, message: `gates[${index}].run must be a non-empty shell command` };
		}
		const timeout = timeoutMs === undefined ? DEFAULT_GATE_TIMEOUT_MS : timeoutMs;
		if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
			return { ok: false, message: `gates[${index}].timeoutMs must be a positive number` };
		}
		gates.push({ name: name.trim(), run, timeoutMs: timeout });
	}
	if (gates.length === 0) return { ok: false, message: '"gates" must contain at least one check' };
	return { ok: true, value: { gates } };
}

/** Apply an optional `only` filter; unknown names are an error, not a silent skip. */
export function selectGates(config: GateConfig, only: readonly string[] | undefined): ParseResult<GateConfigEntry[]> {
	if (!only || only.length === 0) return { ok: true, value: config.gates };
	const wanted = new Set(only.map((name) => name.trim()).filter(Boolean));
	if (wanted.size === 0) return { ok: true, value: config.gates };
	const available = config.gates.map((gate) => gate.name);
	const unknown = [...wanted].filter((name) => !available.includes(name));
	if (unknown.length > 0) {
		return { ok: false, message: `unknown gate${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Available: ${available.join(", ")}` };
	}
	return { ok: true, value: config.gates.filter((gate) => wanted.has(gate.name)) };
}

/** Last `lines` lines of combined output, without trailing blank lines. */
export function tailText(text: string, lines = GATE_TAIL_LINES): string {
	const split = text.replace(/\r\n?/g, "\n").split("\n");
	while (split.length > 0 && split[split.length - 1] === "") split.pop();
	return split.slice(-lines).join("\n");
}

interface OutputTail {
	chunks: string[];
	size: number;
}

function pushTail(tail: OutputTail, text: string): void {
	if (!text) return;
	tail.chunks.push(text);
	tail.size += text.length;
	while (tail.chunks.length > 1 && tail.size > MAX_TAIL_CHARS) tail.size -= tail.chunks.shift()!.length;
}

export interface RunGateOptions {
	cwd: string;
	signal?: AbortSignal;
}

/** Run one check in `cwd`; never rejects, always resolves to a recorded result. */
export function runGate(gate: GateConfigEntry, options: RunGateOptions): Promise<GateCheck> {
	return new Promise((resolveCheck) => {
		const startedAt = Date.now();
		const tail: OutputTail = { chunks: [], size: 0 };
		let finished = false;
		let timedOut = false;
		let aborted = false;

		// Own process group: a timeout must also kill what the check spawned (npm -> node),
		// or those grandchildren keep the pipes open and the check never settles.
		const child = spawn("bash", ["-lc", gate.run], {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const killGroup = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
			settle(null, `timeout after ${gate.timeoutMs}ms`);
		}, gate.timeoutMs);
		timer.unref?.();

		const onAbort = () => {
			aborted = true;
			killGroup();
			settle(null, "aborted");
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const settle = (exitCode: number | null, note?: string) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolveCheck({
				name: gate.name,
				command: gate.run,
				ok: exitCode === 0,
				exitCode,
				durationMs: Date.now() - startedAt,
				tail: tailText(tail.chunks.join("")),
				...(note ? { note } : {}),
			});
		};

		child.stdout?.on("data", (data: Buffer) => pushTail(tail, data.toString()));
		child.stderr?.on("data", (data: Buffer) => pushTail(tail, data.toString()));
		child.on("error", (error) => settle(null, `failed to run bash: ${errorMessage(error)}`));
		child.on("close", (code, signal) => {
			if (timedOut) settle(null, `timeout after ${gate.timeoutMs}ms`);
			else if (aborted) settle(null, "aborted");
			else if (signal) settle(code, `killed by ${signal}`);
			else settle(code);
		});
	});
}

/** Run every selected check, in order, without stopping at the first failure. */
export async function runGates(cwd: string, gates: readonly GateConfigEntry[], signal?: AbortSignal): Promise<GateReport> {
	const checks: GateCheck[] = [];
	for (const gate of gates) {
		if (signal?.aborted) break;
		checks.push(await runGate(gate, { cwd, signal }));
	}
	return { cwd, at: Date.now(), ok: checks.length > 0 && checks.every((check) => check.ok), checks };
}

export function formatGateReport(report: GateReport): string {
	const passed = report.checks.filter((check) => check.ok).length;
	const lines = [`gates ${passed}/${report.checks.length} passed in ${report.cwd}`];
	for (const check of report.checks) {
		const exit = check.exitCode === null ? "exit ?" : `exit ${check.exitCode}`;
		const note = check.note ? ` ${check.note}` : "";
		lines.push("", `${check.ok ? "PASS" : "FAIL"} ${check.name} (${check.command}) ${exit} ${check.durationMs}ms${note}`);
		if (check.tail) lines.push(check.tail);
	}
	return lines.join("\n");
}

async function loadGateConfig(cwd: string): Promise<ParseResult<{ config: GateConfig }>> {
	const path = join(cwd, ".pi", "fugue.json");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return { ok: false, message: `no gate config at ${path}. Create .pi/fugue.json with:\n${CONFIG_EXAMPLE}` };
	}
	const parsed = parseGateConfig(text);
	if (!parsed.ok) return { ok: false, message: `invalid gate config at ${path}: ${parsed.message}` };
	return { ok: true, value: { config: parsed.value } };
}

interface GateToolResult {
	text: string;
	report?: GateReport;
	isError: boolean;
}

async function executeGateTool(
	params: { cwd?: string; only?: string[] },
	ctx: ExtensionToolContext,
	signal: AbortSignal | undefined,
	onReport: (report: GateReport) => void,
): Promise<GateToolResult> {
	const cwd = params.cwd?.trim() ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
	const loaded = await loadGateConfig(cwd);
	if (!loaded.ok) return { text: loaded.message, isError: true };
	const selected = selectGates(loaded.value.config, params.only);
	if (!selected.ok) return { text: selected.message, isError: true };
	const report = await runGates(cwd, selected.value, signal);
	onReport(report);
	return { text: formatGateReport(report), report, isError: !report.ok };
}

function lineComponent(line: string) {
	return {
		invalidate() {},
		render(width: number) {
			return [truncateToWidth(line, width)];
		},
	};
}

function firstText(result: { content: readonly { type: string; text?: string }[] }): string | undefined {
	for (const block of result.content) {
		if (block.type === "text" && typeof block.text === "string") return block.text;
	}
	return undefined;
}

const GATE_PROMPT_GUIDELINES = [
	"Run gates after a writer riff settles and before accepting its work.",
	"Then spawn a fresh reviewer riff on the diff whose last line must be VERDICT: PASS or VERDICT: FAIL.",
	"On FAIL, riff_tell the writer with the findings; at most 3 rounds, then ask the owner.",
];

/** Register `fugue_gate`; `onReport` receives every completed report for the Score. */
export function registerGates(pi: ExtensionAPI, onReport: (report: GateReport) => void): void {
	pi.registerTool({
		name: "fugue_gate",
		label: "Fugue gates",
		description: "Run the project's .pi/fugue.json checks in order and report every pass or fail with output.",
		promptSnippet: "fugue_gate — run the project's gate checks",
		promptGuidelines: GATE_PROMPT_GUIDELINES,
		parameters: Type.Object({
			cwd: Type.Optional(Type.String({ description: "Directory containing .pi/fugue.json; defaults to the session cwd." })),
			only: Type.Optional(Type.Array(Type.String(), { description: "Run only these gate names." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<GateReport | undefined>> {
			const result = await executeGateTool(params, ctx, signal, onReport);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.report,
				...(result.isError ? { isError: true } : {}),
			};
		},
		renderCall(args, theme) {
			const extras: string[] = [];
			if (args.cwd) extras.push(args.cwd);
			if (args.only?.length) extras.push(args.only.join(", "));
			const line = theme.fg("accent", "fugue_gate") + (extras.length ? theme.fg("dim", ` ${extras.join(" ")}`) : "");
			return lineComponent(line);
		},
		renderResult(result, _options, theme) {
			if (!result.details) {
				const text = firstText(result)?.split("\n")[0] ?? "gate config error";
				return lineComponent(theme.fg("error", text));
			}
			const { ok, checks } = result.details;
			const passed = checks.filter((check) => check.ok).length;
			return lineComponent(theme.fg(ok ? "success" : "error", `${ok ? "✓" : "✗"} gates ${passed}/${checks.length}`));
		},
	});
}

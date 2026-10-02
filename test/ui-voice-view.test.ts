import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScoreActions, ScoreSnapshot } from "../src/types.ts";
import { VoiceView } from "../src/ui/voice-view.ts";
import { assertFits, darkTheme, shiftToNow, stripAnsi } from "./helpers.ts";
import { fixture5 } from "./fixtures/snapshots.ts";

interface Harness {
	view: VoiceView;
	calls: string[];
	notices: string[];
	setPrompt(value: string | undefined): void;
	setConfirm(value: boolean): void;
	readCount(): number;
}

function makeView(snapshot: ScoreSnapshot, runId: string): Harness {
	const calls: string[] = [];
	const notices: string[] = [];
	let promptValue: string | undefined = "hello";
	let confirmValue = true;
	let reads = 0;
	const actions: ScoreActions = {
		tell: async (id, message, mode) => {
			calls.push(`tell:${id}:${message}:${mode}`);
			return "steered";
		},
		resume: async (id, message) => {
			calls.push(`resume:${id}:${message}`);
			return "resumed";
		},
		stop: async (id) => {
			calls.push(`stop:${id}`);
			return "stopped";
		},
		readOutput: async () => {
			reads++;
			return ["+ adding src/auth/middleware.ts", "- removing legacy check"];
		},
	};
	const view = new VoiceView({
		theme: darkTheme(),
		rows: 40,
		runId,
		getSnapshot: () => snapshot,
		actions,
		prompt: async () => promptValue,
		confirm: async () => confirmValue,
		notify: (message) => {
			notices.push(message);
		},
		requestRender: () => {},
		done: () => {},
	});
	return {
		view,
		calls,
		notices,
		setPrompt: (value) => {
			promptValue = value;
		},
		setConfirm: (value) => {
			confirmValue = value;
		},
		readCount: () => reads,
	};
}

/** Lines inside the overlay frame, without the `│ ` / ` │` borders. */
function framedBody(lines: string[]): string[] {
	return lines.slice(1, -1).map((line) => stripAnsi(line).slice(2, -2));
}

test("the overlay is framed and every line spans the full width", () => {
	const { view } = makeView(shiftToNow(fixture5()), "run-auth");
	const lines = view.render(80).map(stripAnsi);
	assert.ok(lines[0].startsWith("┌") && lines.at(-1)!.startsWith("└"));
	for (const line of lines) assert.equal(line.length, 80, line);
});

test("header, task, activity and edges render and fit", async () => {
	const { view } = makeView(shiftToNow(fixture5()), "run-auth");
	await view.refresh();
	await new Promise((resolve) => setImmediate(resolve));
	for (const width of [40, 60, 100, 160]) {
		assertFits(view.render(width), width, `voice view ${width}`);
	}
	const plain = framedBody(view.render(100));
	const header = plain[0];
	assert.ok(header.includes("auth") && header.includes("worker"), header);
	assert.ok(header.includes("deepseek-v4.1-flash"), header);
	assert.ok(header.includes("writing") && header.includes("4m12s"), header);
	assert.ok(header.includes("21k") && header.includes("$0.03"), header);
	assert.ok(plain.some((line) => line.includes("task")), "missing task");
	assert.ok(plain.some((line) => line.includes("activity")), "missing activity");
	assert.ok(plain.some((line) => line.includes("messages")), "missing messages");
	assert.ok(plain.some((line) => line.includes("adding src/auth/middleware.ts")), "missing output tail");
});

test("task wrapping stops at four lines", async () => {
	const snapshot = shiftToNow(fixture5());
	const voice = snapshot.voices.find((item) => item.runId === "run-auth")!;
	const long = { ...snapshot, voices: snapshot.voices.map((item) => (item.runId === voice.runId ? { ...item, task: "one ".repeat(200) } : item)) };
	const { view } = makeView(long, "run-auth");
	const lines = framedBody(view.render(60));
	const taskLines = lines.filter((line) => line.startsWith(" task") || (line.startsWith("      ") && line.trim() !== ""));
	assert.ok(taskLines.length <= 4, `task took ${taskLines.length} lines`);
	assert.ok(taskLines[taskLines.length - 1].trimEnd().endsWith("…"));
});

test("s steers a running voice", async () => {
	const { view, calls, notices } = makeView(shiftToNow(fixture5()), "run-auth");
	await view.steer();
	assert.deepEqual(calls, ["tell:run-auth:hello:steer"]);
	assert.deepEqual(notices, ["steered"]);
});

test("s refuses a settled voice", async () => {
	const { view, calls, notices } = makeView(shiftToNow(fixture5()), "run-scout");
	await view.steer();
	assert.deepEqual(calls, []);
	assert.ok(notices[0]?.includes("only a running voice"), notices[0]);
});

test("t follows up while running and resumes once settled", async () => {
	const running = makeView(shiftToNow(fixture5()), "run-auth");
	await running.view.tell();
	assert.deepEqual(running.calls, ["tell:run-auth:hello:follow_up"]);

	const settled = makeView(shiftToNow(fixture5()), "run-scout");
	await settled.view.tell();
	assert.deepEqual(settled.calls, ["resume:run-scout:hello"]);
});

test("x confirms before stopping", async () => {
	const refused = makeView(shiftToNow(fixture5()), "run-auth");
	refused.setConfirm(false);
	await refused.view.stop();
	assert.deepEqual(refused.calls, []);

	const accepted = makeView(shiftToNow(fixture5()), "run-auth");
	await accepted.view.stop();
	assert.deepEqual(accepted.calls, ["stop:run-auth"]);
});

test("cancelled prompts do nothing", async () => {
	const { view, calls, setPrompt } = makeView(shiftToNow(fixture5()), "run-auth");
	setPrompt(undefined);
	await view.steer();
	assert.deepEqual(calls, []);
});

test("refresh is throttled while a request is in flight", async () => {
	const harness = makeView(shiftToNow(fixture5()), "run-auth");
	harness.view.refresh();
	harness.view.refresh();
	assert.equal(harness.readCount(), 1);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.readCount(), 1);
});

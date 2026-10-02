// Engine module E2E: child guard and `/fugue doctor`. Plain .mjs, not part of
// `npm test`.
import assert from "node:assert/strict";
import { registerCommands } from "../../src/commands.ts";
import { Store } from "../../src/store.ts";
import fugue from "../../src/index.ts";

// 1. PI_SUBAGENT_CHILD=1 must stop the factory before it registers anything.
process.env.PI_SUBAGENT_CHILD = "1";
const calls = [];
const childPi = {
	on: (name) => calls.push(`on:${name}`),
	registerTool: () => calls.push("registerTool"),
	registerCommand: () => calls.push("registerCommand"),
	events: { on: () => () => {}, emit: () => {} },
	appendEntry: () => {},
	getThinkingLevel: () => "high",
};
fugue(childPi);
assert.deepEqual(calls, [], `child guard leaked registrations: ${JSON.stringify(calls)}`);
delete process.env.PI_SUBAGENT_CHILD;
console.log("PASS PI_SUBAGENT_CHILD=1 registers nothing");

// 2. /fugue doctor reports ping, config, temp root, voices, timer, owners.
let command;
const pi = {
	registerCommand: (name, options) => {
		command = { name, options };
	},
};
const bridge = {
	async request(method) {
		assert.equal(method, "ping");
		return { methods: ["ping", "spawn", "status", "steer", "stop", "resume"] };
	},
};
const store = new Store({
	bridge,
	conductor: {},
	tempRoot: "/tmp",
	now: () => 0,
	isProcessAlive: () => true,
});
const registrations = [];
registerCommands(pi, () => ({ store, bridge, openPanel: async () => {} }));
assert.equal(command.name, "fugue");
const messages = [];
await command.options.handler("doctor", {
	mode: "print",
	ui: { notify: (message, type) => messages.push({ message, type }) },
});
const report = messages[0].message;
assert.match(report, /^fugue doctor\n/);
assert.match(report, /pi-subagents: \d+\.\d+\.\d+/);
assert.match(report, /rpc ping: ok \(ping,spawn,status,steer,stop,resume\)/);
assert.match(report, /fleetView: (true|false)/);
assert.match(report, /temp root: \//);
assert.match(report, /voices: 0 \(0 active\)/);
assert.match(report, /poll timer: idle/);
assert.match(report, /owner ids: \d+/);
console.log("PASS /fugue doctor");
console.log(report);
store.dispose();

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Bridge, BridgeError } from "../src/bridge.ts";

interface FakeBus {
	handlers: Map<string, Set<(data: unknown) => void>>;
	emitter: {
		on(channel: string, handler: (data: unknown) => void): () => void;
		emit(channel: string, data: unknown): void;
	};
}

function fakePi(): FakeBus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const emitter = {
		on(channel: string, handler: (data: unknown) => void): () => void {
			let set = handlers.get(channel);
			if (!set) handlers.set(channel, (set = new Set()));
			set.add(handler);
			return () => set.delete(handler);
		},
		emit(channel: string, data: unknown): void {
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
	return { handlers, emitter };
}

/** Answer requests with a handler that sees method and params. */
function responder(bus: FakeBus, answer: (method: string, params: Record<string, unknown>, attempt: number) => unknown): void {
	const attempts = new Map<string, number>();
	bus.emitter.on("subagents:rpc:v1:request", (raw) => {
		const request = raw as { requestId: string; method: string; params?: Record<string, unknown> };
		const attempt = (attempts.get(request.method) ?? 0) + 1;
		attempts.set(request.method, attempt);
		bus.emitter.emit(`subagents:rpc:v1:reply:${request.requestId}`, answer(request.method, request.params ?? {}, attempt));
	});
}

async function withKeepAlive<T>(work: () => Promise<T>): Promise<T> {
	const keepAlive = setInterval(() => {}, 5);
	try {
		return await work();
	} finally {
		clearInterval(keepAlive);
	}
}

test("bridge pings once on first use and returns reply data", async () => {
	const bus = fakePi();
	const methods: string[] = [];
	responder(bus, (method) => {
		methods.push(method);
		return { success: true, data: { ok: method } };
	});
	const bridge = new Bridge({ events: bus.emitter } as unknown as ExtensionAPI);
	assert.deepEqual(await bridge.request("echo", { value: 1 }), { ok: "echo" });
	assert.deepEqual(await bridge.request("echo", { value: 2 }), { ok: "echo" });
	assert.deepEqual(methods, ["ping", "echo", "echo"]);
});

test("bridge maps error replies to BridgeError codes", async () => {
	const bus = fakePi();
	responder(bus, (method) => method === "ping"
		? { success: true, data: {} }
		: { success: false, error: { code: "invalid_params", message: "bad params" } });
	const bridge = new Bridge({ events: bus.emitter } as unknown as ExtensionAPI);
	await assert.rejects(bridge.request("spawn", {}), (error: unknown) => {
		assert.ok(error instanceof BridgeError);
		assert.equal(error.code, "invalid_params");
		assert.equal(error.message, "bad params");
		return true;
	});
});

test("bridge retries no_active_session and then succeeds", async () => {
	const bus = fakePi();
	let spawnAttempts = 0;
	responder(bus, (method, _params, attempt) => {
		if (method === "ping") return { success: true, data: {} };
		spawnAttempts = attempt;
		if (attempt < 3) return { success: false, error: { code: "no_active_session", message: "not bound" } };
		return { success: true, data: { details: { runId: "run-1" } } };
	});
	const bridge = new Bridge({ events: bus.emitter } as unknown as ExtensionAPI);
	assert.deepEqual(await withKeepAlive(() => bridge.request("spawn", {})), { details: { runId: "run-1" } });
	assert.equal(spawnAttempts, 3);
});

test("bridge rejects with a timeout when nothing answers", async () => {
	const bus = fakePi();
	const bridge = new Bridge({ events: bus.emitter } as unknown as ExtensionAPI);
	await assert.rejects(withKeepAlive(() => bridge.request("ping", {}, { timeoutMs: 20 })), (error: unknown) => {
		assert.ok(error instanceof BridgeError);
		assert.equal(error.code, "timeout");
		return true;
	});
});

/**
 * Typed client for pi-subagents' event-bus RPC (DESIGN §2 Bridge). Requests
 * reply on `subagents:rpc:v1:reply:<requestId>`; `no_active_session` means the
 * extension has not bound a session yet and is retried briefly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REQUEST_EVENT = "subagents:rpc:v1:request";
const READY_EVENT = "subagents:rpc:v1:ready";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";
const DEFAULT_TIMEOUT_MS = 15_000;
const NO_ACTIVE_RETRIES = 3;
const NO_ACTIVE_DELAY_MS = 100;

export class BridgeError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "BridgeError";
		this.code = code;
	}
}

export interface RequestOptions {
	timeoutMs?: number;
}

interface RpcReply {
	success?: boolean;
	data?: unknown;
	error?: { code?: string; message?: string };
}

export class Bridge {
	private readonly pi: ExtensionAPI;
	private ready = false;
	private readyCheck: Promise<void> | undefined;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		pi.events.on(READY_EVENT, () => {
			this.ready = true;
		});
	}

	async request<T = unknown>(method: string, params: object = {}, options: RequestOptions = {}): Promise<T> {
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		await this.ensureReady(timeoutMs);
		for (let attempt = 0; ; attempt += 1) {
			try {
				return await this.send<T>(method, params, timeoutMs);
			} catch (error) {
				const retryable = error instanceof BridgeError && error.code === "no_active_session";
				if (!retryable || attempt >= NO_ACTIVE_RETRIES - 1) throw error;
				await delay(NO_ACTIVE_DELAY_MS);
			}
		}
	}

	private async ensureReady(timeoutMs: number): Promise<void> {
		if (this.ready) return;
		this.readyCheck ??= this.send("ping", {}, timeoutMs)
			.then(() => {
				this.ready = true;
			})
			.finally(() => {
				this.readyCheck = undefined;
			});
		return this.readyCheck;
	}

	private send<T>(method: string, params: object, timeoutMs: number): Promise<T> {
		const requestId = crypto.randomUUID();
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new BridgeError("timeout", `subagents RPC ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
			const off = this.pi.events.on(REPLY_PREFIX + requestId, (raw) => {
				clearTimeout(timer);
				off();
				const reply = raw as RpcReply | undefined;
				if (reply?.success) {
					resolve(reply.data as T);
					return;
				}
				const code = reply?.error?.code ?? "execution_failed";
				const message = reply?.error?.message ?? `subagents RPC ${method} failed`;
				reject(new BridgeError(code, message));
			});
			this.pi.events.emit(REQUEST_EVENT, { version: 1, requestId, method, params });
		});
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

/**
 * Minimal CDP client over the browser-level WebSocket endpoint.
 *
 * The viewer process runs in a Herdr pane, separate from the Pi process that
 * owns the Playwright/CloakBrowser context, so it talks raw CDP rather than
 * sharing a Playwright handle. Uses undici's WebSocket (Node >= 20.18.1).
 */

export interface CdpTarget {
	targetId: string;
	type: string;
	title: string;
	url: string;
	attached?: boolean;
}

type Handler = (params: Record<string, unknown>) => void;

interface Pending {
	resolve: (value: Record<string, unknown>) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

import { WebSocket } from "undici";

export function validateBrowserWsUrl(httpEndpoint: string, raw: string): string {
	const endpoint = new URL(httpEndpoint);
	const ws = new URL(raw);
	if (
		ws.protocol !== "ws:" ||
		ws.hostname !== endpoint.hostname ||
		ws.port !== endpoint.port ||
		!ws.pathname.startsWith("/devtools/browser/")
	) {
		throw new Error("CDP endpoint returned an unexpected browser WebSocket URL");
	}
	return ws.href;
}

/** Fetch the browser-level WS endpoint from a CDP http endpoint. */
export async function browserWsUrl(httpEndpoint: string): Promise<string> {
	const endpoint = new URL(httpEndpoint);
	const res = await fetch(new URL("/json/version", endpoint), {
		signal: AbortSignal.timeout(5_000),
	});
	if (!res.ok) throw new Error(`CDP /json/version failed: HTTP ${res.status}`);
	const body = (await res.json()) as { webSocketDebuggerUrl?: string };
	if (!body.webSocketDebuggerUrl) throw new Error("CDP endpoint exposed no webSocketDebuggerUrl");
	return validateBrowserWsUrl(endpoint.href, body.webSocketDebuggerUrl);
}

export class CdpClient {
	private ws: WebSocket | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	/** key: `${sessionId ?? ""}:${method}` */
	private readonly handlers = new Map<string, Set<Handler>>();
	private closeHandler: (() => void) | undefined;

	async connect(wsUrl: string, timeoutMs = 10_000): Promise<void> {
		const ws = new WebSocket(wsUrl);
		this.ws = ws;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				ws.close();
				reject(new Error("CDP connect timed out"));
			}, timeoutMs);
			ws.addEventListener(
				"open",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
			ws.addEventListener(
				"error",
				() => {
					clearTimeout(timer);
					reject(new Error("CDP websocket error"));
				},
				{ once: true },
			);
		});

		ws.addEventListener("message", (event) => {
			this.onMessage(String((event as { data: unknown }).data));
		});
		ws.addEventListener("close", () => {
			for (const [, p] of this.pending) {
				clearTimeout(p.timer);
				p.reject(new Error("CDP connection closed"));
			}
			this.pending.clear();
			this.closeHandler?.();
		});
	}

	onClose(fn: () => void): void {
		this.closeHandler = fn;
	}

	private onMessage(raw: string): void {
		let msg: {
			id?: number;
			method?: string;
			params?: Record<string, unknown>;
			sessionId?: string;
			result?: Record<string, unknown>;
			error?: { message?: string };
		};
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}

		if (typeof msg.id === "number") {
			const pending = this.pending.get(msg.id);
			if (!pending) return;
			this.pending.delete(msg.id);
			clearTimeout(pending.timer);
			if (msg.error) pending.reject(new Error(msg.error.message ?? "CDP error"));
			else pending.resolve(msg.result ?? {});
			return;
		}

		if (msg.method) {
			const key = `${msg.sessionId ?? ""}:${msg.method}`;
			for (const fn of this.handlers.get(key) ?? []) fn(msg.params ?? {});
			// Wildcard listeners (any session) use "*:method".
			for (const fn of this.handlers.get(`*:${msg.method}`) ?? []) {
				fn({ ...(msg.params ?? {}), __sessionId: msg.sessionId });
			}
		}
	}

	on(method: string, fn: Handler, sessionId?: string): void {
		const key = `${sessionId ?? ""}:${method}`;
		const set = this.handlers.get(key) ?? new Set<Handler>();
		set.add(fn);
		this.handlers.set(key, set);
	}

	/** Listen across every session; params gain __sessionId. */
	onAny(method: string, fn: Handler): void {
		this.on(method, fn, "*");
	}

	off(method: string, fn: Handler, sessionId?: string): void {
		this.handlers.get(`${sessionId ?? ""}:${method}`)?.delete(fn);
	}

	offSession(sessionId: string): void {
		for (const key of this.handlers.keys()) {
			if (key.startsWith(`${sessionId}:`)) this.handlers.delete(key);
		}
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
		timeoutMs = 20_000,
	): Promise<Record<string, unknown>> {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("CDP not connected"));
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP ${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			const payload: Record<string, unknown> = { id, method, params };
			if (sessionId) payload.sessionId = sessionId;
			ws.send(JSON.stringify(payload));
		});
	}

	close(): void {
		try {
			this.ws?.close();
		} catch {
			// already gone
		}
		this.ws = undefined;
	}
}

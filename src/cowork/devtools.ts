/** DevTools capture and raw CDP for the active cowork browser. */

import type {
	BrowserContext,
	CDPSession,
	Page,
	Request,
} from "playwright-core";

import { abortable, throwIfAborted } from "../utils.js";

const BUFFER_LIMIT = 200;
const DEFAULT_MAX_CHARS = 12_000;
const MAX_CHARS = 50_000;
const SECRET_HEADER = /^(authorization|cookie|proxy-authorization|set-cookie)$/i;

export interface ConsoleEntry {
	type: string;
	text: string;
	url?: string;
	line?: number;
	column?: number;
}

export interface NetworkEntry {
	method: string;
	url: string;
	resourceType: string;
	status?: number;
	failure?: string;
	requestHeaders?: Record<string, string>;
	responseHeaders?: Record<string, string>;
}

export interface CdpEvent {
	method: string;
	params?: object;
}

interface PageBuffers {
	console: ConsoleEntry[];
	network: NetworkEntry[];
	pendingNetwork: Set<Promise<void>>;
}

let buffers = new WeakMap<Page, PageBuffers>();
let installed = new WeakSet<Page>();
let pageSessions = new WeakMap<Page, CDPSession>();
let browserSessions = new WeakMap<BrowserContext, CDPSession>();
let sessionEvents = new WeakMap<CDPSession, CdpEvent[]>();
const liveSessions = new Set<CDPSession>();

export function pushBounded<T>(items: T[], item: T, limit = BUFFER_LIMIT): void {
	items.push(item);
	if (items.length > limit) items.splice(0, items.length - limit);
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).map(([name, value]) => [
			name,
			SECRET_HEADER.test(name) ? "[redacted]" : value,
		]),
	);
}

function pageBuffers(page: Page): PageBuffers {
	let current = buffers.get(page);
	if (!current) {
		current = { console: [], network: [], pendingNetwork: new Set() };
		buffers.set(page, current);
	}
	return current;
}

async function networkEntry(request: Request): Promise<NetworkEntry> {
	const response = await request.response().catch(() => null);
	return {
		method: request.method(),
		url: request.url(),
		resourceType: request.resourceType(),
		status: response?.status(),
		failure: request.failure()?.errorText,
		requestHeaders: redactHeaders(await request.allHeaders().catch(() => ({}))),
		responseHeaders: response
			? redactHeaders(await response.allHeaders().catch(() => ({})))
			: undefined,
	};
}

/** Capture console and completed requests from launch onward. Idempotent per page. */
export function installDevtoolsBuffers(page: Page): void {
	if (installed.has(page)) return;
	installed.add(page);
	const current = pageBuffers(page);
	page.on("console", (message) => {
		const location = message.location();
		pushBounded(current.console, {
			type: message.type(),
			text: message.text(),
			url: location.url || undefined,
			line: location.lineNumber,
			column: location.columnNumber,
		});
	});
	const captureRequest = (request: Request) => {
		const work = networkEntry(request)
			.then((entry) => pushBounded(current.network, entry))
			.finally(() => current.pendingNetwork.delete(work));
		current.pendingNetwork.add(work);
	};
	page.on("requestfinished", captureRequest);
	page.on("requestfailed", captureRequest);
}

const CONSOLE_LEVELS = new Set([
	"log",
	"debug",
	"info",
	"error",
	"warning",
	"dir",
	"dirxml",
	"table",
	"trace",
	"clear",
	"startGroup",
	"startGroupCollapsed",
	"endGroup",
	"assert",
	"profile",
	"profileEnd",
	"count",
	"timeEnd",
]);

export function takeConsoleEntries(page: Page, filter?: string): ConsoleEntry[] {
	const current = pageBuffers(page);
	const entries = current.console.splice(0);
	const needle = filter?.trim().toLowerCase();
	if (!needle) return entries;
	if (CONSOLE_LEVELS.has(needle)) return entries.filter((entry) => entry.type === needle);
	return entries.filter((entry) => `${entry.type} ${entry.text}`.toLowerCase().includes(needle));
}

export async function takeNetworkEntries(page: Page, filter?: string): Promise<NetworkEntry[]> {
	const current = pageBuffers(page);
	await Promise.all([...current.pendingNetwork]);
	const entries = current.network.splice(0);
	const needle = filter?.trim().toLowerCase();
	return needle ? entries.filter((entry) => entry.url.toLowerCase().includes(needle)) : entries;
}

export function formatCdpJson(value: unknown, requestedMaxChars = DEFAULT_MAX_CHARS): string {
	const maxChars = Math.max(100, Math.min(MAX_CHARS, Math.floor(requestedMaxChars)));
	const text = JSON.stringify(value, null, 2) ?? "null";
	if (text.length <= maxChars) return text;
	const suffix = `\n…[truncated ${text.length - maxChars} chars]`;
	return text.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

const BLOCKED_CDP = new Set([
	"network.setrequestinterception",
	"target.createbrowsercontext",
	"target.disposebrowsercontext",
	"target.sendmessagetotarget",
	"target.createtarget",
	"target.closetarget",
	"target.attachtotarget",
	"target.setautoattach",
	"target.exposedevtoolsprotocol",
	"browser.close",
	"browser.crash",
	"browser.crashgpuprocess",
	"page.crash",
]);

export function isBlockedCdpMethod(method: string): boolean {
	const lower = method.trim().toLowerCase();
	return lower.startsWith("fetch.") || BLOCKED_CDP.has(lower);
}

function trackCdpSession(session: CDPSession): void {
	liveSessions.add(session);
	const events: CdpEvent[] = [];
	sessionEvents.set(session, events);
	session.on("event", ({ method, params }) => {
		pushBounded(events, { method, params });
	});
	session.once("close", () => liveSessions.delete(session));
}

async function cdpSession(page: Page, target: "page" | "browser"): Promise<CDPSession> {
	if (target === "page") {
		let session = pageSessions.get(page);
		if (!session) {
			session = await page.context().newCDPSession(page);
			pageSessions.set(page, session);
			trackCdpSession(session);
		}
		return session;
	}

	const context = page.context();
	let session = browserSessions.get(context);
	if (!session) {
		const browser = context.browser();
		if (!browser) throw new Error("Browser-level CDP is unavailable for this cowork session");
		session = await browser.newBrowserCDPSession();
		browserSessions.set(context, session);
		trackCdpSession(session);
	}
	return session;
}

export async function takeCdpEvents(
	page: Page,
	target: "page" | "browser",
	filter?: string,
): Promise<CdpEvent[]> {
	const session = await cdpSession(page, target);
	const events = sessionEvents.get(session)?.splice(0) ?? [];
	const needle = filter?.trim().toLowerCase();
	return needle ? events.filter((event) => event.method.toLowerCase().includes(needle)) : events;
}

export async function sendCdpCommand(
	page: Page,
	target: "page" | "browser",
	method: string,
	params: Record<string, unknown> = {},
	signal?: AbortSignal,
): Promise<unknown> {
	const command = method.trim();
	if (!/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(command)) {
		throw new Error("CDP method must use Domain.command form");
	}
	if (isBlockedCdpMethod(command)) {
		throw new Error(
			`CDP ${command} is blocked because it can disable URL guards or terminate the shared browser`,
		);
	}
	throwIfAborted(signal);
	const session = await cdpSession(page, target);
	const send = session.send as unknown as (
		method: string,
		params?: Record<string, unknown>,
	) => Promise<unknown>;
	return abortable(send.call(session, command, params), signal);
}

export async function resetDevtools(): Promise<void> {
	const sessions = [...liveSessions];
	liveSessions.clear();
	await Promise.all(sessions.map((session) => session.detach().catch(() => {})));
	buffers = new WeakMap();
	installed = new WeakSet();
	pageSessions = new WeakMap();
	browserSessions = new WeakMap();
	sessionEvents = new WeakMap();
}

/** Persistent headed or headless CloakBrowser session for web_cowork. */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";

import { installBrowserUrlGuard } from "../browser-guard.js";
import { validateUrl, abortable, throwIfAborted } from "../utils.js";
import {
	cloakDownloadLaunchOptions,
	ensureChromeDownloadPrefs,
	resolveDownloadDir,
} from "../read/downloads.js";
import { installDevtoolsBuffers, resetDevtools } from "./devtools.js";
import { clearCoworkRefs, resetCoworkRefs } from "./refs.js";

export const DEFAULT_COWORK_PROFILE = join(homedir(), ".cloakbrowser", "cowork-profile");
const DEFAULT_NAV_TIMEOUT_MS = 60_000;

export interface CoworkPageInfo {
	index: number;
	active: boolean;
	url: string;
	title: string;
}

export interface CoworkSessionStatus {
	open: boolean;
	url?: string;
	title?: string;
	userDataDir?: string;
	headless?: boolean;
	pageIndex?: number;
	pageCount?: number;
}

export interface CoworkSession {
	context: BrowserContext;
	page: Page;
	userDataDir: string;
	headless: boolean;
	takeBlockedUrlError: () => string | null;
}

let session: CoworkSession | undefined;

/** Reuse a live session when the profile matches; ignore headless. */
export function shouldKeepCoworkSession(
	current: { userDataDir: string } | undefined,
	userDataDir: string,
): boolean {
	return Boolean(current && current.userDataDir === userDataDir);
}

/** wait is headed-only: no desktop window to finish in. */
export function coworkWaitError(status: { open?: boolean; headless?: boolean }): string | null {
	if (status.open && status.headless) {
		return "action=wait needs a visible cowork window. Close and reopen without headless, or use snapshot/evaluate.";
	}
	return null;
}

function expandHome(path: string): string {
	if (path.startsWith("~/") || path === "~") {
		return resolve(homedir(), path.slice(2) || ".");
	}
	return path;
}

export function resolveUserDataDir(configured?: string): string {
	const raw = configured?.trim() || DEFAULT_COWORK_PROFILE;
	return expandHome(raw);
}

function isPageAlive(page: Page): boolean {
	try {
		return !page.isClosed();
	} catch {
		return false;
	}
}

async function isContextAlive(context: BrowserContext): Promise<boolean> {
	try {
		void context.pages();
		return true;
	} catch {
		return false;
	}
}

async function clearSession(): Promise<void> {
	resetCoworkRefs();
	const current = session;
	session = undefined;
	if (!current) return;
	await resetDevtools();
	await current.context.close().catch(() => {});
}

function recoverActivePage(current: CoworkSession): boolean {
	if (isPageAlive(current.page)) return true;
	const fallback = current.context.pages().find(isPageAlive);
	if (!fallback) return false;
	current.page = fallback;
	installDevtoolsBuffers(fallback);
	clearCoworkRefs();
	return true;
}

/** True when a live cowork session exists. */
export function isCoworkSessionOpen(): boolean {
	return Boolean(session && recoverActivePage(session));
}

export async function listCoworkPages(): Promise<CoworkPageInfo[]> {
	const current = await requireCoworkSession();
	const pages = current.context.pages().filter(isPageAlive);
	return Promise.all(
		pages.map(async (page, index) => ({
			index,
			active: page === current.page,
			url: page.url(),
			title: await page.title().catch(() => ""),
		})),
	);
}

export async function selectCoworkPage(index: number): Promise<CoworkPageInfo> {
	const current = await requireCoworkSession();
	const pages = current.context.pages().filter(isPageAlive);
	if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
		throw new Error(`pageIndex must be between 0 and ${Math.max(0, pages.length - 1)}`);
	}
	current.page = pages[index]!;
	installDevtoolsBuffers(current.page);
	clearCoworkRefs();
	return {
		index,
		active: true,
		url: current.page.url(),
		title: await current.page.title().catch(() => ""),
	};
}

export async function getCoworkStatus(): Promise<CoworkSessionStatus> {
	if (!session) return { open: false };
	if (!(await isContextAlive(session.context)) || !recoverActivePage(session)) {
		await clearSession();
		return { open: false };
	}
	try {
		const pages = session.context.pages().filter(isPageAlive);
		return {
			open: true,
			url: session.page.url(),
			title: await session.page.title(),
			userDataDir: session.userDataDir,
			headless: session.headless,
			pageIndex: pages.indexOf(session.page),
			pageCount: pages.length,
		};
	} catch {
		await clearSession();
		return { open: false };
	}
}

export async function ensureCoworkSession(options: {
	userDataDir?: string;
	downloadDir?: string;
	headless?: boolean;
}): Promise<CoworkSession> {
	const userDataDir = resolveUserDataDir(options.userDataDir);
	const downloadDir = resolveDownloadDir(options.downloadDir);
	const headless = options.headless === true;

	if (session) {
		const alive = (await isContextAlive(session.context)) && recoverActivePage(session);
		// headless is create-time only — a live window must not die because open omitted/flipped the flag
		if (alive && shouldKeepCoworkSession(session, userDataDir)) {
			return session;
		}
		await clearSession();
	}

	mkdirSync(userDataDir, { recursive: true });
	ensureChromeDownloadPrefs(userDataDir, downloadDir);
	const downloadOpts = cloakDownloadLaunchOptions(downloadDir);
	const cloak = await import("cloakbrowser");
	const context = await cloak.launchPersistentContext({
		userDataDir,
		headless,
		launchOptions: downloadOpts.launchOptions,
		contextOptions: { ...downloadOpts.contextOptions, serviceWorkers: "block" },
	});
	const takeBlockedUrlError = await installBrowserUrlGuard(context, true);
	context.on("page", installDevtoolsBuffers);

	const page = context.pages()[0] ?? (await context.newPage());
	for (const openPage of context.pages()) installDevtoolsBuffers(openPage);

	session = { context, page, userDataDir, headless, takeBlockedUrlError };
	return session;
}

export async function requireCoworkSession(): Promise<CoworkSession> {
	if (!session || !(await isContextAlive(session.context)) || !recoverActivePage(session)) {
		await clearSession();
		throw new Error("No open web_cowork session. Call action=open with a url first.");
	}
	return session;
}

export async function navigateCoworkPage(
	page: Page,
	url: string,
	timeoutMs = DEFAULT_NAV_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<{ url: string; title: string; status: number }> {
	const ssrf = validateUrl(url, true);
	if (ssrf) throw new Error(ssrf);

	throwIfAborted(signal);
	clearCoworkRefs();

	const takeBlockedUrlError =
		session?.page === page ? session.takeBlockedUrlError : () => null;
	takeBlockedUrlError();
	let response: { status: () => number } | null = null;
	try {
		response = await abortable(
			page.goto(url, { waitUntil: "load", timeout: timeoutMs }),
			signal,
		);
	} catch (err) {
		throwIfAborted(signal);
		const blocked = takeBlockedUrlError();
		if (blocked) throw new Error(blocked);
		response = await abortable(
			page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }),
			signal,
		);
	}

	const blocked = takeBlockedUrlError();
	if (blocked) throw new Error(blocked);
	const finalUrl = page.url();
	const finalSsrf = validateUrl(finalUrl, true);
	if (finalSsrf) throw new Error(finalSsrf);

	return {
		url: finalUrl,
		title: await abortable(page.title().catch(() => ""), signal),
		status: response?.status() ?? 200,
	};
}

export async function closeCoworkSession(): Promise<void> {
	await clearSession();
}

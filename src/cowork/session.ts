/** Persistent headed CloakBrowser session for web_cowork. */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";

import { validateUrl, abortable, throwIfAborted } from "../utils.js";
import {
	cloakDownloadLaunchOptions,
	ensureChromeDownloadPrefs,
	resolveDownloadDir,
} from "../read/downloads.js";
import { clearCoworkRefs } from "./refs.js";

export const DEFAULT_COWORK_PROFILE = join(homedir(), ".cloakbrowser", "cowork-profile");
const DEFAULT_NAV_TIMEOUT_MS = 60_000;

export interface CoworkSessionStatus {
	open: boolean;
	url?: string;
	title?: string;
	userDataDir?: string;
}

interface SessionState {
	context: BrowserContext;
	page: Page;
	userDataDir: string;
}

let session: SessionState | undefined;

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
		// Touch pages(); throws if browser already closed.
		void context.pages();
		return true;
	} catch {
		return false;
	}
}

async function clearSession(): Promise<void> {
	clearCoworkRefs();
	const current = session;
	session = undefined;
	if (!current) return;
	await current.context.close().catch(() => {});
}

/** True when a live cowork session exists. */
export function isCoworkSessionOpen(): boolean {
	return Boolean(session && isPageAlive(session.page));
}

export async function getCoworkStatus(): Promise<CoworkSessionStatus> {
	if (!session) {
		return { open: false };
	}
	if (!(await isContextAlive(session.context)) || !isPageAlive(session.page)) {
		await clearSession();
		return { open: false };
	}
	let url: string | undefined;
	let title: string | undefined;
	try {
		url = session.page.url();
		title = await session.page.title();
	} catch {
		await clearSession();
		return { open: false };
	}
	return {
		open: true,
		url,
		title,
		userDataDir: session.userDataDir,
	};
}

export async function ensureCoworkSession(options: {
	userDataDir?: string;
	downloadDir?: string;
}): Promise<SessionState> {
	const userDataDir = resolveUserDataDir(options.userDataDir);
	const downloadDir = resolveDownloadDir(options.downloadDir);

	if (session) {
		if ((await isContextAlive(session.context)) && isPageAlive(session.page)) {
			if (session.userDataDir === userDataDir) {
				return session;
			}
			await clearSession();
		} else {
			await clearSession();
		}
	}

	mkdirSync(userDataDir, { recursive: true });
	ensureChromeDownloadPrefs(userDataDir, downloadDir);
	const downloadOpts = cloakDownloadLaunchOptions(downloadDir);

	const cloak = await import("cloakbrowser");
	// launchPersistentContext takes launch + context options flat.
	const context = await cloak.launchPersistentContext({
		userDataDir,
		headless: false,
		...downloadOpts.launchOptions,
		...downloadOpts.contextOptions,
	});

	const existing = context.pages();
	const page = existing[0] ?? (await context.newPage());

	session = { context, page, userDataDir };
	return session;
}

export async function requireCoworkSession(): Promise<SessionState> {
	if (!session || !(await isContextAlive(session.context)) || !isPageAlive(session.page)) {
		await clearSession();
		throw new Error(
			"No open web_cowork session. Call action=open with a url first.",
		);
	}
	return session;
}

export async function navigateCoworkPage(
	page: Page,
	url: string,
	timeoutMs = DEFAULT_NAV_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<{ url: string; title: string; status: number }> {
	const ssrf = validateUrl(url);
	if (ssrf) throw new Error(ssrf);

	throwIfAborted(signal);
	clearCoworkRefs();

	let response: { status: () => number } | null = null;
	try {
		response = await abortable(
			page.goto(url, { waitUntil: "load", timeout: timeoutMs }),
			signal,
		);
	} catch (err) {
		throwIfAborted(signal);
		response = await abortable(
			page.goto(url, {
				waitUntil: "domcontentloaded",
				timeout: timeoutMs,
			}),
			signal,
		);
	}

	const finalUrl = page.url();
	const finalSsrf = validateUrl(finalUrl);
	if (finalSsrf) throw new Error(finalSsrf);

	const title = await abortable(page.title().catch(() => ""), signal);
	return {
		url: finalUrl,
		title,
		status: response?.status() ?? 200,
	};
}

export async function closeCoworkSession(): Promise<void> {
	await clearSession();
}

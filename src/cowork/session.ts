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
import { clearCoworkRefs, resetCoworkRefs } from "./refs.js";
import type { ResolvedHerdrConfig } from "./herdr/config.js";
import { viewLogPath } from "./herdr/config.js";
import {
	closeHerdrBrowserPane,
	freePort,
	openHerdrBrowserPane,
	paneExists,
	waitForCdp,
} from "./herdr/pane.js";

export const DEFAULT_COWORK_PROFILE = join(homedir(), ".cloakbrowser", "cowork-profile");
const DEFAULT_NAV_TIMEOUT_MS = 60_000;

export interface CoworkSessionStatus {
	open: boolean;
	url?: string;
	title?: string;
	userDataDir?: string;
	/** Herdr pane id when the browser renders in a pane. */
	herdrPaneId?: string;
	herdrFallbackReason?: string;
}

interface SessionState {
	context: BrowserContext;
	page: Page;
	userDataDir: string;
	/** Set when the browser is rendered inside a Herdr pane. */
	herdr?: { paneId: string; cdpEndpoint: string };
	/** Why the Herdr pane was not used, when it was requested. */
	herdrFallbackReason?: string;
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
	resetCoworkRefs();
	const current = session;
	session = undefined;
	if (!current) return;
	if (current.herdr) {
		await closeHerdrBrowserPane(current.herdr.paneId).catch(() => {});
	}
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
	if (
		!(await isContextAlive(session.context)) ||
		!isPageAlive(session.page) ||
		(session.herdr && !(await paneExists(session.herdr.paneId)))
	) {
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
		herdrPaneId: session.herdr?.paneId,
		herdrFallbackReason: session.herdrFallbackReason,
	};
}

export async function ensureCoworkSession(options: {
	userDataDir?: string;
	downloadDir?: string;
	herdr?: ResolvedHerdrConfig;
	/** First URL to show, used for a fresh tab in the pane view. */
	initialUrl?: string;
	/** Progress notes for the tool result (pane opened, fell back, …). */
	onNote?: (note: string) => void;
}): Promise<SessionState> {
	const userDataDir = resolveUserDataDir(options.userDataDir);
	const downloadDir = resolveDownloadDir(options.downloadDir);
	const wantHerdr = options.herdr?.enabled === true;

	if (session) {
		const alive = (await isContextAlive(session.context)) && isPageAlive(session.page);
		const modeMatches = wantHerdr === Boolean(session.herdr);
		const paneAlive = !session.herdr || (await paneExists(session.herdr.paneId));
		if (alive && modeMatches && paneAlive && session.userDataDir === userDataDir) {
			return session;
		}
		await clearSession();
	}

	mkdirSync(userDataDir, { recursive: true });
	ensureChromeDownloadPrefs(userDataDir, downloadDir);
	const downloadOpts = cloakDownloadLaunchOptions(downloadDir);

	// A Herdr pane renders frames itself, so Chromium runs headless there.
	const cdpPort = wantHerdr
		? options.herdr!.cdpPort || (await freePort())
		: 0;

	const cloak = await import("cloakbrowser");
	// launchPersistentContext takes launch + context options flat.
	const context = await cloak.launchPersistentContext({
		userDataDir,
		headless: wantHerdr,
		...downloadOpts.launchOptions,
		...downloadOpts.contextOptions,
		...(wantHerdr ? { args: [`--remote-debugging-port=${cdpPort}`] } : {}),
	});

	const existing = context.pages();
	const page = existing[0] ?? (await context.newPage());

	session = { context, page, userDataDir };

	if (wantHerdr) {
		const cfg = options.herdr!;
		try {
			const cdpEndpoint = await waitForCdp(cdpPort);
			const pane = await openHerdrBrowserPane({
				cfg,
				cdpEndpoint,
				initialUrl: options.initialUrl,
				logPath: viewLogPath(),
			});
			session.herdr = { paneId: pane.paneId, cdpEndpoint };
			options.onNote?.(`Herdr browser pane ${pane.paneId} (CDP ${cdpEndpoint})`);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (!cfg.fallbackToWindow) {
				await clearSession();
				throw new Error(`Herdr browser pane failed to open:\n${reason}`);
			}
			// Headless Chromium with no pane would be invisible: relaunch headed.
			session.herdrFallbackReason = reason;
			options.onNote?.(`Herdr pane unavailable, using a desktop window instead:\n${reason}`);
			await context.close().catch(() => {});
			const headed = await cloak.launchPersistentContext({
				userDataDir,
				headless: false,
				...downloadOpts.launchOptions,
				...downloadOpts.contextOptions,
			});
			const headedPage = headed.pages()[0] ?? (await headed.newPage());
			session = {
				context: headed,
				page: headedPage,
				userDataDir,
				herdrFallbackReason: reason,
			};
		}
	}

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
	const ssrf = validateUrl(url, true);
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
	const finalSsrf = validateUrl(finalUrl, true);
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

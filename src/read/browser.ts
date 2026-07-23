/** CloakBrowser page render. */

import { config } from "../config.js";
import { validateUrl, timeoutSignal } from "../utils.js";
import { cloakDownloadLaunchOptions, resolveDownloadDir } from "./downloads.js";

export interface BrowserRenderResult {
	url: string;
	finalUrl: string;
	status: number;
	html: string;
}

type CloakPage = {
	goto: (
		u: string,
		opts: { waitUntil: string; timeout: number },
	) => Promise<{ status: () => number } | null>;
	content: () => Promise<string>;
	url: () => string;
	close: () => Promise<void>;
	evaluate: (fn: () => void) => Promise<unknown>;
	waitForTimeout?: (ms: number) => Promise<void>;
};

type CloakContext = {
	newPage: () => Promise<CloakPage>;
	close: () => Promise<void>;
};

type CloakBrowser = {
	close: () => Promise<void>;
	newContext: (opts?: Record<string, unknown>) => Promise<CloakContext>;
};

async function settleAndDismissOverlays(page: CloakPage): Promise<void> {
	await new Promise((r) => setTimeout(r, 1500));
	try {
		await page.evaluate(() => {
			const selectors = [
				"[aria-label='Close']",
				"[aria-label='close']",
				"button.close",
				"[class*='modal'] button",
				"[class*='cookie'] button",
				"[id*='onetrust'] button",
				"[class*='overlay'] button",
			];
			for (const sel of selectors) {
				document.querySelectorAll(sel).forEach((el) => {
					try {
						(el as HTMLElement).click();
					} catch {
						// ignore
					}
				});
			}
			document
				.querySelectorAll(
					"[class*='modal'],[class*='overlay'],[id*='onetrust'],[class*='signup'],[class*='join-community']",
				)
				.forEach((el) => {
					(el as HTMLElement).style.setProperty("display", "none", "important");
				});
		});
	} catch {
		// page may navigate mid-evaluate
	}
	await new Promise((r) => setTimeout(r, 500));
}

export async function renderWithCloakBrowser(
	url: string,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		/** Default true. Set false to show the browser window. */
		headless?: boolean;
	} = {},
): Promise<BrowserRenderResult> {
	const ssrf = validateUrl(url);
	if (ssrf) throw new Error(ssrf);

	const signal = timeoutSignal(options.signal, options.timeoutMs ?? 30_000);
	const headless = options.headless !== false;
	const timeout = options.timeoutMs ?? 30_000;
	const cloak = await import("cloakbrowser");

	let browser: CloakBrowser | undefined;
	const onAbort = () => {
		void browser?.close().catch(() => {});
	};
	signal.addEventListener("abort", onAbort, { once: true });

	try {
		if (signal.aborted) throw new DOMException("Aborted", "AbortError");

		const downloadOpts = cloakDownloadLaunchOptions(resolveDownloadDir(config.cowork?.downloadDir));
		browser = (await cloak.launch({
			headless,
			...downloadOpts.launchOptions,
		})) as unknown as CloakBrowser;
		const context = await browser.newContext(downloadOpts.contextOptions);
		const page = await context.newPage();
		try {
			let response: { status: () => number } | null = null;
			try {
				response = await page.goto(url, { waitUntil: "load", timeout });
			} catch {
				if (signal.aborted) throw new DOMException("Aborted", "AbortError");
				response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
			}
			if (signal.aborted) throw new DOMException("Aborted", "AbortError");

			await settleAndDismissOverlays(page);

			const finalUrl = page.url();
			const finalSsrf = validateUrl(finalUrl);
			if (finalSsrf) throw new Error(finalSsrf);

			let html = "";
			for (let attempt = 0; attempt < 4; attempt++) {
				if (signal.aborted) throw new DOMException("Aborted", "AbortError");
				try {
					html = await page.content();
					break;
				} catch {
					await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
				}
			}
			if (!html) {
				html = (await page.evaluate(() => document.documentElement?.outerHTML ?? "")) as string;
			}
			if (!html) throw new Error("Failed to read page content after navigation settled");

			return {
				url,
				finalUrl,
				status: response?.status() ?? 200,
				html,
			};
		} finally {
			await page.close().catch(() => {});
			await context.close().catch(() => {});
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		if (browser) {
			await browser.close().catch(() => {});
		}
	}
}

/** Ephemeral browsers are closed per render; hook kept for process-exit symmetry. */
export async function closeAllBrowsers(): Promise<void> {
	// no persistent browser pool
}

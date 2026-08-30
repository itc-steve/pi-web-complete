import type { BrowserContext, Page } from "playwright-core";
import { validateUrl } from "./utils.js";

/** Block unsafe browser requests before dispatch; returns and clears latest error. */
export async function installBrowserUrlGuard(
	target: BrowserContext | Page,
	allowFile = false,
): Promise<() => string | null> {
	let blocked: string | null = null;
	await target.route("**/*", async (route) => {
		const error = validateUrl(route.request().url(), allowFile);
		if (error) {
			blocked = error;
			await route.abort("blockedbyclient");
			return;
		}
		await route.continue();
	});
	return () => {
		const error = blocked;
		blocked = null;
		return error;
	};
}

/** CloakBrowser download directory helpers (default ~/Downloads). */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_DOWNLOAD_DIR = join(homedir(), "Downloads");

function expandHome(path: string): string {
	if (path.startsWith("~/") || path === "~") {
		return resolve(homedir(), path.slice(2) || ".");
	}
	return path;
}

/** Resolve configured download dir; default ~/Downloads. */
export function resolveDownloadDir(configured?: string): string {
	const raw = configured?.trim() || DEFAULT_DOWNLOAD_DIR;
	return expandHome(raw);
}

/**
 * Point Chromium's native Save/Download UI at downloadDir by merging
 * Default/Preferences before launch (persistent profiles).
 */
export function ensureChromeDownloadPrefs(userDataDir: string, downloadDir: string): void {
	mkdirSync(downloadDir, { recursive: true });
	const prefsPath = join(userDataDir, "Default", "Preferences");
	mkdirSync(dirname(prefsPath), { recursive: true });

	let prefs: Record<string, unknown> = {};
	if (existsSync(prefsPath)) {
		try {
			prefs = JSON.parse(readFileSync(prefsPath, "utf-8")) as Record<string, unknown>;
		} catch {
			prefs = {};
		}
	}

	const prevDownload =
		prefs.download && typeof prefs.download === "object"
			? (prefs.download as Record<string, unknown>)
			: {};
	const prevSavefile =
		prefs.savefile && typeof prefs.savefile === "object"
			? (prefs.savefile as Record<string, unknown>)
			: {};

	prefs.download = {
		...prevDownload,
		default_directory: downloadDir,
		prompt_for_download: false,
	};
	prefs.savefile = {
		...prevSavefile,
		default_directory: downloadDir,
	};

	writeFileSync(prefsPath, JSON.stringify(prefs));
}

/** CloakBrowser / Playwright options to force downloads into downloadDir. */
export function cloakDownloadLaunchOptions(downloadDir: string): {
	launchOptions: { downloadsPath: string };
	contextOptions: { acceptDownloads: true };
} {
	mkdirSync(downloadDir, { recursive: true });
	return {
		launchOptions: { downloadsPath: downloadDir },
		contextOptions: { acceptDownloads: true },
	};
}

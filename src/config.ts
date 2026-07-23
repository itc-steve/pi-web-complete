/** Config loading for pi-web-complete. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendConfig, BackendName, SearchConfig } from "./types.js";
import { BACKEND_NAMES } from "./types.js";
import { resolveBackendKey } from "./credentials.js";
import { getAgentDir } from "./utils.js";

export let config: SearchConfig = {
	defaultBackend: "auto",
	backends: {},
};

function loadConfig(cwd: string): SearchConfig {
	const globalPath = join(getAgentDir(), "extensions", "search.json");
	const projectPath = join(cwd, ".pi", "search.json");

	let loaded: SearchConfig = {
		defaultBackend: "auto",
		backends: {},
	};

	if (existsSync(globalPath)) {
		try {
			loaded = { ...loaded, ...JSON.parse(readFileSync(globalPath, "utf-8")) };
		} catch {
			// ignore
		}
	}

	const preProjectBackends = { ...(loaded.backends ?? {}) };

	if (existsSync(projectPath)) {
		try {
			const project = JSON.parse(readFileSync(projectPath, "utf-8"));
			loaded = { ...loaded, ...project };
			if (loaded.backends == null) {
				loaded.backends = preProjectBackends;
			}
			if (project.backends && typeof project.backends === "object") {
				const merged: Record<string, BackendConfig | undefined> = {
					...preProjectBackends,
					...loaded.backends,
				};
				for (const [key, val] of Object.entries(project.backends)) {
					const bc = val as BackendConfig | undefined;
					if (bc && merged[key]) {
						merged[key] = { ...merged[key], ...bc };
					} else {
						merged[key] = bc;
					}
				}
				loaded.backends = merged as SearchConfig["backends"];
			}
		} catch {
			// ignore
		}
	}

	if (
		loaded.defaultBackend &&
		loaded.defaultBackend !== "auto" &&
		!BACKEND_NAMES.includes(loaded.defaultBackend as BackendName)
	) {
		loaded.defaultBackend = "auto";
	}

	return clampConfig(loaded);
}

/** Soft clamps — never reject configs, only bound extreme values. */
function clampConfig(loaded: SearchConfig): SearchConfig {
	if (typeof loaded.numResults === "number" && Number.isFinite(loaded.numResults)) {
		loaded.numResults = Math.max(1, Math.min(20, Math.floor(loaded.numResults)));
	}

	if (loaded.read && typeof loaded.read === "object") {
		const read = { ...loaded.read };
		if (typeof read.timeoutSeconds === "number" && Number.isFinite(read.timeoutSeconds)) {
			read.timeoutSeconds = Math.max(5, Math.min(300, Math.floor(read.timeoutSeconds)));
		}
		if (typeof read.maxChars === "number" && Number.isFinite(read.maxChars) && read.maxChars > 0) {
			read.maxChars = Math.min(Math.floor(read.maxChars), 500_000);
		}
		if (
			typeof read.excerptMaxChars === "number" &&
			Number.isFinite(read.excerptMaxChars) &&
			read.excerptMaxChars > 0
		) {
			read.excerptMaxChars = Math.min(Math.floor(read.excerptMaxChars), 100_000);
		}
		if (typeof read.maxBytes === "number" && Number.isFinite(read.maxBytes) && read.maxBytes > 0) {
			read.maxBytes = Math.min(Math.floor(read.maxBytes), 50 * 1024 * 1024);
		}
		loaded.read = read;
	}

	if (loaded.backends && typeof loaded.backends === "object") {
		for (const name of BACKEND_NAMES) {
			const bc = loaded.backends[name];
			if (!bc) continue;
			const next = { ...bc };
			if (typeof next.timeout === "number" && Number.isFinite(next.timeout)) {
				next.timeout = Math.max(1_000, Math.min(120_000, Math.floor(next.timeout)));
			}
			if (typeof next.maxResults === "number" && Number.isFinite(next.maxResults)) {
				next.maxResults = Math.max(1, Math.min(20, Math.floor(next.maxResults)));
			}
			loaded.backends[name] = next;
		}
	}

	return loaded;
}

let activeBackendsList: string[] = [];
let configCacheTime = 0;
let configCacheCwd = "";
const CONFIG_TTL_MS = 10_000;

export function refreshConfig(cwd: string, force = false): string[] {
	const now = Date.now();
	if (!force && cwd === configCacheCwd && now - configCacheTime < CONFIG_TTL_MS) {
		return activeBackendsList;
	}

	config = loadConfig(cwd);
	configCacheTime = now;
	configCacheCwd = cwd;

	// Enabled + keyed only — skip doomed attempts in auto shuffle.
	activeBackendsList = Object.entries(config.backends || {})
		.filter(
			([name, bc]) =>
				BACKEND_NAMES.includes(name as BackendName) &&
				bc?.enabled &&
				resolveBackendKey(name, config) !== undefined,
		)
		.map(([name]) => name);

	return activeBackendsList;
}

export function getActiveBackends(): string[] {
	return activeBackendsList;
}

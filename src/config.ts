/** Config loading for pi-web-complete. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendConfig, BackendName, SearchConfig } from "./types.js";
import { BACKEND_NAMES } from "./types.js";
import { loadEnvFiles, resolveBackendKey } from "./credentials.js";
import { getAgentDir } from "./utils.js";

export let config: SearchConfig = {
	defaultBackend: "auto",
	backends: {},
};

/** First existing path that parses as JSON, else null. */
function readJsonFile(paths: string[]): Record<string, unknown> | null {
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		} catch {
			// ignore bad JSON; try next candidate
		}
	}
	return null;
}

function loadConfig(cwd: string): SearchConfig {
	const agentDir = getAgentDir();
	// Prefer web.json; fall back to legacy search.json locations once.
	const globalFile = readJsonFile([
		join(agentDir, "web.json"),
		join(agentDir, "extensions", "search.json"), // legacy
	]);
	const projectFile = readJsonFile([
		join(cwd, ".pi", "web.json"),
		join(cwd, ".pi", "search.json"), // legacy
	]);

	let loaded: SearchConfig = {
		defaultBackend: "auto",
		backends: {},
	};

	if (globalFile) {
		loaded = { ...loaded, ...globalFile } as SearchConfig;
	}

	const preProjectBackends = { ...(loaded.backends ?? {}) };

	if (projectFile) {
		const project = projectFile;
		loaded = { ...loaded, ...project } as SearchConfig;
		if (loaded.backends == null) {
			loaded.backends = preProjectBackends;
		}
		if (project.backends && typeof project.backends === "object") {
			const merged: Record<string, BackendConfig | undefined> = {
				...preProjectBackends,
				...loaded.backends,
			};
			for (const [key, val] of Object.entries(
				project.backends as Record<string, BackendConfig | undefined>,
			)) {
				const bc = val;
				if (bc && merged[key]) {
					merged[key] = { ...merged[key], ...bc };
				} else {
					merged[key] = bc;
				}
			}
			loaded.backends = merged as SearchConfig["backends"];
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

	// Keep web.env in sync with config force-reload (same as pi-fgt fortigate.env)
	loadEnvFiles(cwd, force);
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

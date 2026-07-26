/**
 * API key resolution — same pattern as pi-fgt:
 *   JSON: apiKeyEnv name only (no secrets)
 *   ENV:  ~/.pi/agent/web.env (+ optional .pi/web.env)
 * Order: process.env[apiKeyEnv] → project web.env → global web.env → legacy literal apiKey
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SearchConfig } from "./types.js";
import { getAgentDir } from "./utils.js";

let envFileCache: Record<string, string> = {};
let envFileCacheTime = 0;
let envFileCacheCwd = "";
const ENV_TTL_MS = 10_000;

/** Parse KEY=VALUE dotenv (no export keyword required). Quotes stripped. # comments ok. */
export function parseEnvFile(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
		const eq = body.indexOf("=");
		if (eq <= 0) continue;
		const key = body.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		let val = body.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		out[key] = val;
	}
	return out;
}

function readEnvPath(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	try {
		return parseEnvFile(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

/** Load global + project web.env (project wins). Call from refreshConfig. */
export function loadEnvFiles(cwd: string, force = false): Record<string, string> {
	const now = Date.now();
	if (
		!force &&
		cwd === envFileCacheCwd &&
		now - envFileCacheTime < ENV_TTL_MS
	) {
		return envFileCache;
	}

	const globalEnv = readEnvPath(join(getAgentDir(), "web.env"));
	const projectEnv = readEnvPath(join(cwd, ".pi", "web.env"));
	// project overlays global; process.env is checked separately at resolve time
	envFileCache = { ...globalEnv, ...projectEnv };
	envFileCacheTime = now;
	envFileCacheCwd = cwd;
	return envFileCache;
}

function cleanKey(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const lower = trimmed.toLowerCase();
	if (lower === "null" || lower === "undefined" || lower === "none") return undefined;
	return trimmed;
}

/**
 * Resolve a backend's API key.
 * 1) process.env[apiKeyEnv]
 * 2) web.env (project, then global — already merged by loadEnvFiles)
 * 3) legacy literal apiKey in JSON (deprecated)
 */
export function resolveBackendKey(backend: string, config: SearchConfig): string | undefined {
	const bc = config.backends?.[backend as keyof NonNullable<SearchConfig["backends"]>];
	if (!bc) return undefined;

	const envName = typeof bc.apiKeyEnv === "string" ? bc.apiKeyEnv.trim() : "";
	if (envName) {
		const fromProcess = cleanKey(process.env[envName]);
		if (fromProcess) return fromProcess;
		const fromFile = cleanKey(envFileCache[envName]);
		if (fromFile) return fromFile;
	}

	// legacy: literal apiKey still accepted so old web.json keeps working
	return cleanKey(bc.apiKey);
}

/** Resolve the Context7 API key the same way (process.env → web.env → legacy literal). */
export function resolveContext7Key(config: SearchConfig): string | undefined {
	const c7 = config.context7;
	if (!c7 || c7.enabled === false) return undefined;
	const envName = typeof c7.apiKeyEnv === "string" ? c7.apiKeyEnv.trim() : "";
	if (envName) {
		const fromProcess = cleanKey(process.env[envName]);
		if (fromProcess) return fromProcess;
		const fromFile = cleanKey(envFileCache[envName]);
		if (fromFile) return fromFile;
	}
	return cleanKey(c7.apiKey);
}

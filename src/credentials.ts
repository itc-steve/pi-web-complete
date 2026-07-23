/** Literal-only API key resolution. */

import type { SearchConfig } from "./types.js";

/** Trimmed literal apiKey from config, or undefined. No env / !shell. */
export function resolveBackendKey(backend: string, config: SearchConfig): string | undefined {
	const key = config.backends?.[backend as keyof NonNullable<SearchConfig["backends"]>]?.apiKey;
	if (typeof key !== "string") return undefined;
	const trimmed = key.trim();
	if (!trimmed) return undefined;
	const lower = trimmed.toLowerCase();
	if (lower === "null" || lower === "undefined" || lower === "none") return undefined;
	return trimmed;
}

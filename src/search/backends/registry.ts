/** Backend registry and dispatcher. */

import type { BackendName, BackendRunner, BackendConfig, SearchResult } from "../../types.js";
import { MISSING_KEY_HELP, waitForCooldown, markCooldown } from "../../utils.js";
import { resolveBackendKey } from "../../credentials.js";
import { config } from "../../config.js";

import { searchBrave } from "./brave.js";
import { searchSerper } from "./serper.js";
import { searchTavily } from "./tavily.js";
import { searchExa } from "./exa.js";
import { searchLinkup } from "./linkup.js";

export const BACKEND_DEFS: Record<BackendName, BackendRunner> = {
	brave: {
		label: "Brave",
		search: async (query, numResults, { key, signal, backendConfig }) => {
			const result = await searchBrave(
				query,
				numResults,
				key!,
				signal,
				backendConfig?.timeout,
			);
			return { results: result.results };
		},
	},
	serper: {
		label: "Serper",
		search: async (query, numResults, { key, signal, backendConfig }) => {
			const result = await searchSerper(
				query,
				numResults,
				key!,
				signal,
				backendConfig?.timeout,
			);
			return { results: result.results };
		},
	},
	tavily: {
		label: "Tavily",
		search: async (query, numResults, { key, signal, backendConfig }) => {
			const result = await searchTavily(
				query,
				numResults,
				key!,
				signal,
				backendConfig?.timeout,
			);
			return { results: result.results };
		},
	},
	exa: {
		label: "Exa",
		search: async (query, numResults, { key, signal, backendConfig }) => {
			const result = await searchExa(query, numResults, key!, signal, backendConfig?.timeout);
			return { results: result.results };
		},
	},
	linkup: {
		label: "Linkup",
		search: async (query, numResults, { key, signal, backendConfig }) => {
			const result = await searchLinkup(
				query,
				numResults,
				key!,
				signal,
				backendConfig?.depth,
				backendConfig?.timeout,
			);
			return { results: result.results };
		},
	},
};

export async function runBackend(
	backend: string,
	query: string,
	numResults: number,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	await waitForCooldown(backend, signal);
	const def = BACKEND_DEFS[backend as BackendName];
	if (!def) throw new Error(`Unknown backend: ${backend}`);

	const key = resolveBackendKey(backend, config);
	if (!key) {
		throw new Error(`${def.label} backend not configured. ${MISSING_KEY_HELP}`);
	}

	const bc = (config.backends as Record<string, BackendConfig> | undefined)?.[backend];
	const capped = bc?.maxResults ? Math.min(numResults, bc.maxResults) : numResults;

	try {
		const result = await def.search(query, capped, { key, signal, backendConfig: bc });
		return result.results;
	} finally {
		markCooldown(backend);
	}
}

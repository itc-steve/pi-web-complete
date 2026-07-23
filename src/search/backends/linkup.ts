/** Linkup backend. */

import { timeoutSignal, sanitizeError } from "../../utils.js";
import { parseLinkup } from "./parsers.js";
import type { SearchResult } from "../../types.js";

export async function searchLinkup(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
	depth?: "standard" | "deep",
	timeoutMs?: number,
): Promise<{ results: SearchResult[] }> {
	const body: Record<string, unknown> = {
		q: query,
		outputType: "searchResults",
		depth: depth || "standard",
	};

	const response = await fetch("https://api.linkup.so/v1/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: timeoutSignal(signal, timeoutMs),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Linkup ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	return { results: parseLinkup(data, numResults) };
}

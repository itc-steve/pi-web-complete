/** Result parsers for the 5 search backends. */

export interface ParsedResult {
	title: string;
	url: string;
	snippet: string;
	content?: string;
}

export function parseBrave(data: Record<string, unknown>, numResults: number): ParsedResult[] {
	const web = data.web;
	if (!web || typeof web !== "object") return [];
	const rawResults = (web as Record<string, unknown>).results;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: ((r.description as string) || "").slice(0, 500),
	}));
}

export function parseSerper(data: Record<string, unknown>, numResults: number): ParsedResult[] {
	const rawResults = data.organic;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.link as string) || "",
		snippet: (r.snippet as string) || "",
	}));
}

export function parseTavily(data: Record<string, unknown>, numResults: number): ParsedResult[] {
	const rawResults = data.results;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: (r.content as string) || "",
		content: r.content as string,
	}));
}

export function parseExa(data: Record<string, unknown>, numResults: number): ParsedResult[] {
	const rawResults = data.results;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: ((r.text as string) || (r.highlight as string) || "").slice(0, 500),
	}));
}

export function parseLinkup(data: Record<string, unknown>, numResults: number): ParsedResult[] {
	const rawResults = data.searchResults || data.results || data.data;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || (r.name as string) || "",
		url: (r.url as string) || "",
		snippet: ((r.content as string) || (r.snippet as string) || "").slice(0, 500),
	}));
}

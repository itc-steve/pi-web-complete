/** Result formatting for web_search. */

import type { SearchResult } from "../types.js";

// ── Snippet budget ───────────────────────────────────────────────────

/** Max characters per-result snippet in formatResults. */
export const SNIPPET_CAP = 500;

// ── De-duplication ───────────────────────────────────────────────────

const TRACKING_PARAMS = new Set([
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_term",
	"utm_content",
	"utm_id",
	"gclid",
	"fbclid",
	"ref_src",
	"mc_cid",
	"mc_eid",
]);

function normalizeUrlKey(raw: string): string | null {
	try {
		const u = new URL(raw);
		const host = u.hostname.toLowerCase().replace(/^www\./, "");
		let path = u.pathname.replace(/\/+$/, "");
		// Strip all utm_* (wildcard) and named tracking params
		const params = new URLSearchParams(u.search);
		for (const key of [...params.keys()]) {
			const lk = key.toLowerCase();
			if (lk.startsWith("utm_") || TRACKING_PARAMS.has(lk)) {
				params.delete(key);
			}
		}
		const search = params.toString();
		return `${u.protocol}//${host}${path}${search ? "?" + search : ""}`;
	} catch {
		return null;
	}
}

/**
 * Collapse duplicate search results by normalized URL key.
 *
 * Normalization: lowercase host, strip www. prefix, strip trailing
 * slash from path, drop fragment, drop tracking query params (utm_*, gclid,
 * fbclid, ref_src, mc_cid, mc_eid).
 *
 * Keeps the FIRST occurrence and preserves order.
 * Invalid URLs pass through untouched.
 */
export function dedupeResults(results: SearchResult[]): SearchResult[] {
	const seen = new Set<string>();
	const out: SearchResult[] = [];

	for (const r of results) {
		const key = normalizeUrlKey(r.url);
		if (key === null) {
			// Unparseable URL — keep as-is, never a duplicate match
			out.push(r);
		} else if (!seen.has(key)) {
			seen.add(key);
			out.push(r);
		}
		// else: duplicate — skip
	}

	return out;
}

// ── Formatters ───────────────────────────────────────────────────────

export function formatResultsCompact(
	results: SearchResult[],
): string {
	if (results.length === 0) return "No results.";
	const lines = results.map((r, i) => {
		const title = (r.title || "Untitled").slice(0, 60);
		const url = r.url.length > 50 ? r.url.slice(0, 47) + "..." : r.url;
		return `${i + 1}. ${title} — ${url}`;
	});
	return lines.join("\n");
}

export function formatResults(
	query: string,
	backend: string,
	results: SearchResult[],
): string {
	const before = results.length;
	const deduped = dedupeResults(results);
	const safeQuery = query.replace(/[\n\r]/g, " ").replace(/^#/gm, "\\#");
	const removed = before - deduped.length;

	const header = removed > 0
		? `Results: ${deduped.length} (${removed} duplicate${removed > 1 ? "s" : ""} removed)`
		: `Results: ${deduped.length}`;

	const lines: string[] = [
		`## Search Results: "${safeQuery}"`,
		`Backend: ${backend}  ·  ${header}`,
		"",
	];

	for (let i = 0; i < deduped.length; i++) {
		const r = deduped[i];
		lines.push(`### ${i + 1}. ${r.title || "Untitled"}`);
		lines.push(`   URL: ${r.url}`);
		const displayText = r.snippet || r.content || "";
		if (displayText) {
			const text = displayText.slice(0, SNIPPET_CAP);
			lines.push(`   ${text}${displayText.length > SNIPPET_CAP ? "..." : ""}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}



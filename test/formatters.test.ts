/**
 * Deduplication and formatting — moved from inline self-check in formatters.ts.
 *
 * Run:  npx tsx test/formatters.test.ts
 */

import assert from "node:assert/strict";
import { dedupeResults, formatResults, SNIPPET_CAP } from "../src/search/formatters.js";
import type { SearchResult } from "../src/types.js";

const mk = (u: string, t = "T"): SearchResult => ({ url: u, title: t });

// 1. utm_* stripping
{
	const a = mk("https://example.com/page?utm_source=google&utm_medium=cpc&q=hello");
	const b = mk("https://example.com/page?q=hello");
	assert.strictEqual(dedupeResults([a, b]).length, 1, "utm stripping");
}

// 2. www. prefix collapse (m. and amp. no longer collapsed — distinct hosts)
{
	const www = mk("https://www.example.com/page");
	const base = mk("https://example.com/page");
	assert.strictEqual(dedupeResults([www, base]).length, 1, "www. prefix collapsed");
}

// 3. trailing-slash equivalence
{
	assert.strictEqual(dedupeResults([mk("https://example.com/page/"), mk("https://example.com/page")]).length, 1, "trailing slash");
}

// 4. fragment stripping
{
	assert.strictEqual(dedupeResults([mk("https://example.com/page#section"), mk("https://example.com/page")]).length, 1, "fragment stripped");
}

// 5. order preservation, first kept
{
	const x = mk("https://a.com/1", "A");
	const y = mk("https://b.com/2", "B");
	const z = mk("https://c.com/3", "C");
	const r = dedupeResults([x, y, mk("https://a.com/1", "DupA"), z]);
	assert.strictEqual(r.length, 3);
	assert.strictEqual(r[0].title, "A");
	assert.strictEqual(r[1].title, "B");
	assert.strictEqual(r[2].title, "C");
}

// 6. invalid URL passes through
{
	assert.strictEqual(dedupeResults([mk("not-a-url", "Bad")]).length, 1);
}

// 7. gclid/fbclid stripped
{
	assert.strictEqual(dedupeResults([mk("https://example.com/x?gclid=123&fbclid=abc&q=test"), mk("https://example.com/x?q=test")]).length, 1);
}

// 8. ref_src stripped (bare ref is NOT stripped — load-bearing for GitHub/GitLab tags)
{
	assert.strictEqual(
		dedupeResults([mk("https://example.com/x?ref_src=tw&q=test"), mk("https://example.com/x?q=test")]).length,
		1,
		"ref_src stripped",
	);
	assert.strictEqual(
		dedupeResults([mk("https://github.com/foo/bar?ref=v2.1.0"), mk("https://github.com/foo/bar?ref=v3.0.0")]).length,
		2,
		"bare ref: kept — different tag refs stay separate",
	);
}

// 9. m. prefix: m.signal.org is NOT collapsed against signal.org (distinct host)
{
	assert.strictEqual(
		dedupeResults([mk("https://m.signal.org/news"), mk("https://signal.org/news")]).length,
		2,
		"m. prefix: distinct host, not deduped",
	);
}

// 10. amp. prefix: amp.example.com is NOT collapsed against example.com
{
	assert.strictEqual(
		dedupeResults([mk("https://amp.example.com/page"), mk("https://example.com/page")]).length,
		2,
		"amp. prefix: distinct host, not deduped",
	);
}

// 11. SNIPPET_CAP restored to 500
assert.strictEqual(SNIPPET_CAP, 500, "SNIPPET_CAP is 500");

// 12. formatResults header notes duplicates removed
{
	const out = formatResults("test", "brave", [
		mk("https://example.com/page", "A"),
		mk("https://example.com/page", "B"),
		mk("https://other.com", "C"),
	]);
	assert.ok(out.includes("Results: 2 (1 duplicate removed)"));
}

// 13. SNIPPET_CAP truncation at 500 chars
{
	const longSnippet = "x".repeat(600);
	const results: SearchResult[] = [{ url: "https://example.com/p", title: "Long", snippet: longSnippet }];
	const out = formatResults("test", "brave", results);
	// The formatted output includes the snippet truncated to 500 + "..."
	const truncated = "x".repeat(500) + "...";
	assert.ok(out.includes(truncated), "snippet truncated at 500 chars");
}

console.log("All formatters tests passed.");

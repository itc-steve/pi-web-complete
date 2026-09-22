/** Next-page ("stitch") discovery. No fetching — the parent walks the links. */

import { validateUrl } from "../utils.js";

/** Extra pages fetched after the first (4 total). */
export const MAX_STITCH_PAGES = 3;

const LINK_TAG = /<link\b[^>]*>/gi;
const ANCHOR_TAG = /<a\b[^>]*>/gi;
const REL_ATTR = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const HREF_ATTR = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function attr(tag: string, re: RegExp): string | null {
	const m = re.exec(tag);
	if (!m) return null;
	return m[1] ?? m[2] ?? m[3] ?? null;
}

function relHasNext(tag: string): boolean {
	const rel = attr(tag, REL_ATTR);
	if (!rel) return false;
	return rel.toLowerCase().split(/\s+/).includes("next");
}

function firstNext(scope: string, tagRe: RegExp, base: URL): string | null {
	tagRe.lastIndex = 0;
	for (let m: RegExpExecArray | null; (m = tagRe.exec(scope)); ) {
		const tag = m[0];
		if (!relHasNext(tag)) continue;
		const href = attr(tag, HREF_ATTR);
		if (!href) continue;
		let next: URL;
		try {
			next = new URL(href, base);
		} catch {
			continue;
		}
		if (next.origin !== base.origin) continue; // same origin only
		// href="#" / same path+query = same document, fragment only
		if (next.pathname === base.pathname && next.search === base.search)
			continue;
		if (validateUrl(next.href)) continue; // SSRF guard
		return next.href;
	}
	return null;
}

/**
 * First `rel="next"` target: `<link>` in the first 64k, then `<a>` anywhere.
 * Returns the resolved absolute URL, or null (missing, cross-origin,
 * same-document fragment, or SSRF-blocked).
 */
export function findRelNext(html: string, baseUrl: string): string | null {
	let base: URL;
	try {
		base = new URL(baseUrl);
	} catch {
		return null;
	}
	return (
		firstNext(html.slice(0, 65536), LINK_TAG, base) ??
		firstNext(html, ANCHOR_TAG, base)
	);
}

/** Divider between stitched parts. `index` starts at 2. */
export function stitchPartMarker(index: number, url: string): string {
	return `\n\n--- part ${index}: ${url} ---\n\n`;
}

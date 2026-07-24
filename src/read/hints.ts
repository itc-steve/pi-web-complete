/** Meta-refresh, alternate links, and page metadata from HTML. */

import { validateUrl } from "../utils.js";
import type { ReadFormat } from "../types.js";

export interface PageMeta {
	title?: string;
	author?: string;
	published?: string;
	site?: string;
	language?: string;
}

const MAX_REFRESH_HOPS = 5;
/** Follow meta-refresh only when delay is short (true redirect shells). */
const MAX_REFRESH_DELAY_SEC = 10;

function attr(tag: string, name: string): string | undefined {
	const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
	const m = tag.match(re);
	return m?.[1] ?? m?.[2] ?? m?.[3];
}

function resolveAgainst(baseUrl: string, href: string): string | null {
	try {
		const abs = new URL(href, baseUrl).href;
		return validateUrl(abs) ? null : abs;
	} catch {
		return null;
	}
}

function parseRefreshContent(content: string): { delay: number; url: string } | null {
	// "0;url=https://…" | "0; URL='/path'" | "5;url=…"
	const m = content
		.trim()
		.match(/^(\d+(?:\.\d+)?)\s*;\s*url\s*=\s*['"]?([^'";]+)['"]?\s*$/i);
	if (!m) return null;
	const delay = Number(m[1]);
	if (!Number.isFinite(delay)) return null;
	const url = m[2].trim();
	return url ? { delay, url } : null;
}

/**
 * Parse a short meta-refresh redirect target.
 * Returns null for long delays, missing URL, or SSRF-blocked targets.
 */
export function findMetaRefreshUrl(html: string, baseUrl: string): string | null {
	const head = html.slice(0, 32_768);
	const re = /<meta\b[^>]*>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(head))) {
		const tag = m[0];
		const httpEquiv = (attr(tag, "http-equiv") ?? "").toLowerCase();
		if (httpEquiv !== "refresh") continue;
		const content = attr(tag, "content");
		if (!content) continue;
		const parsed = parseRefreshContent(content);
		if (!parsed || parsed.delay > MAX_REFRESH_DELAY_SEC) continue;
		const next = resolveAgainst(baseUrl, parsed.url);
		if (next) return next;
	}
	return null;
}

/** MIME types preferred per output format (first match wins). */
const ALTERNATE_TYPES: Record<ReadFormat, string[]> = {
	markdown: [
		"text/markdown",
		"text/x-markdown",
		"text/plain",
		"application/json",
		"text/html",
	],
	text: ["text/plain", "text/markdown", "text/x-markdown", "text/html"],
	html: ["text/html", "application/xhtml+xml", "text/plain"],
};

function normalizeMime(type: string): string {
	return type.split(";")[0].trim().toLowerCase();
}

/**
 * Collect rel=alternate hrefs that match the requested format, preferred-type order.
 * Same-document and SSRF-blocked targets are dropped.
 */
export function findAlternateUrls(
	html: string,
	baseUrl: string,
	format: ReadFormat,
): string[] {
	const preferred = ALTERNATE_TYPES[format] ?? ALTERNATE_TYPES.markdown;
	const head = html.slice(0, 64_768);
	const byType = new Map<string, string[]>();

	const re = /<link\b[^>]*>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(head))) {
		const tag = m[0];
		const rel = (attr(tag, "rel") ?? "").toLowerCase();
		if (!/\balternate\b/.test(rel)) continue;
		const type = normalizeMime(attr(tag, "type") ?? "");
		const href = attr(tag, "href");
		if (!href || !type || !preferred.includes(type)) continue;
		const abs = resolveAgainst(baseUrl, href);
		if (!abs) continue;
		try {
			if (new URL(abs).href === new URL(baseUrl).href) continue;
		} catch {
			continue;
		}
		const list = byType.get(type) ?? [];
		if (!list.includes(abs)) list.push(abs);
		byType.set(type, list);
	}

	const out: string[] = [];
	for (const type of preferred) {
		for (const u of byType.get(type) ?? []) {
			if (!out.includes(u)) out.push(u);
		}
	}
	return out;
}

function metaByKeys(html: string, keys: string[]): string | undefined {
	// Index once, then pick by preferred key order (not document order).
	const found = new Map<string, string>();
	const head = html.slice(0, 64_768);
	const re = /<meta\b[^>]*>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(head))) {
		const tag = m[0];
		const name = (
			attr(tag, "name") ??
			attr(tag, "property") ??
			attr(tag, "itemprop") ??
			""
		).toLowerCase();
		if (!name || found.has(name)) continue;
		const content = attr(tag, "content")?.trim();
		if (content) found.set(name, content);
	}
	for (const key of keys) {
		const hit = found.get(key.toLowerCase());
		if (hit) return hit;
	}
	return undefined;
}

/** Drop empty / placeholder meta (e.g. bare "@" from twitter:creator shells). */
function cleanMetaValue(value: string | undefined, kind: "author" | "generic" = "generic"): string | undefined {
	if (!value) return undefined;
	const t = value.trim();
	if (!t) return undefined;
	if (kind === "author") {
		if (t === "@" || t === "@null" || t.length < 2) return undefined;
	}
	return t;
}

export function parsePageMeta(html: string, url: string): PageMeta {
	const head = html.slice(0, 64_768);
	const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = cleanMetaValue(
		metaByKeys(html, ["og:title", "twitter:title"]) ??
			titleMatch?.[1]?.replace(/<[^>]+>/g, "").trim(),
	);

	const author = cleanMetaValue(
		metaByKeys(html, [
			"author",
			"article:author",
			"og:article:author",
			"twitter:creator",
		]),
		"author",
	);

	const published = cleanMetaValue(
		metaByKeys(html, [
			"article:published_time",
			"og:article:published_time",
			"date",
			"publish_date",
			"dc.date",
			"DC.date.issued",
			"pubdate",
		]),
	);

	let site = cleanMetaValue(
		metaByKeys(html, ["og:site_name", "application-name", "twitter:site"]),
	);
	if (!site) {
		try {
			site = new URL(url).hostname;
		} catch {
			// ignore
		}
	}

	const langMatch = head.match(/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i);
	const language = cleanMetaValue(
		langMatch?.[1]?.trim() || metaByKeys(html, ["og:locale", "language", "dc.language"]),
	);

	return {
		title,
		author,
		published,
		site,
		language,
	};
}

/** True when extracted content is thin enough to try alternates. */
export const THIN_CONTENT_CHARS = 400;

export function isThinContent(chars: number): boolean {
	return chars < THIN_CONTENT_CHARS;
}

/** Follow meta-refresh hops via the given fetch function. */
export async function fetchWithMetaRefresh<T extends { html: string; finalUrl: string }>(
	url: string,
	doFetch: (url: string) => Promise<T>,
	maxHops: number = MAX_REFRESH_HOPS,
): Promise<T> {
	const seen = new Set<string>();
	let current = url;
	let last: T | undefined;

	for (let hop = 0; hop < maxHops; hop++) {
		if (seen.has(current)) break;
		seen.add(current);
		last = await doFetch(current);
		const next = findMetaRefreshUrl(last.html, last.finalUrl || current);
		if (!next || seen.has(next) || next === last.finalUrl) {
			return last;
		}
		current = next;
	}
	return last ?? doFetch(current);
}

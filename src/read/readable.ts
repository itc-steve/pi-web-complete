/** Mozilla Readability extraction via linkedom. */

import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { normalizeWhitespace } from "./markdown.js";

export interface ReadableExtraction {
	ok: boolean;
	reason?: string;
	title?: string;
	textContent?: string;
	contentHtml?: string;
}

export function extractReadable(html: string): ReadableExtraction {
	try {
		const { document } = parseHTML(html);
		const h1Text = (document.querySelector("h1")?.textContent ?? "").trim();
		const fallbackTitle =
			h1Text.length > 0 ? h1Text : (document.querySelector("title")?.textContent ?? "").trim();
		const clone = document.cloneNode(true) as Document;
		if (!isProbablyReaderable(clone)) {
			return { ok: false, reason: "unsuitable" };
		}
		const article = new Readability(clone).parse();
		if (!article?.textContent) {
			return { ok: false, reason: "failed" };
		}
		return {
			ok: true,
			title:
				article.title && article.title.length > 0
					? article.title
					: fallbackTitle.length > 0
						? fallbackTitle
						: undefined,
			textContent: normalizeWhitespace(article.textContent),
			contentHtml: article.content ?? undefined,
		};
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : "failed",
		};
	}
}

/**
 * Prefer Readability only when it improves (or at least preserves) content.
 * Rejects short promo/modal extracts that beat rich pages in Readability's scoring.
 */
export function readableIsBetter(readableText: string | undefined, baselineText: string): boolean {
	const r = readableText?.length ?? 0;
	const b = baselineText.length;
	if (r < 250) return false;
	// Never replace a substantial page with a much shorter "article" (signup walls, etc.)
	if (b >= 500 && r < b * 0.5) return false;
	if (b < 800) return r >= Math.max(250, b * 1.15);
	return r >= b * 0.5;
}

/** Pull a rough title + visible text from raw HTML without Readability. */
export function extractFast(html: string): { title?: string; text: string; html: string } {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu);
	const title = titleMatch?.[1]?.replace(/<[^>]+>/gu, "").trim();
	const text = normalizeWhitespace(
		html
			.replace(/<script[\s\S]*?<\/script>/giu, " ")
			.replace(/<style[\s\S]*?<\/style>/giu, " ")
			.replace(/<noscript[\s\S]*?<\/noscript>/giu, " ")
			.replace(/<[^>]+>/gu, " "),
	);
	return { title, text, html };
}

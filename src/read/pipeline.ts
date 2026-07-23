/** Local read pipeline: fast → fingerprint → readable → browser. */

import type { ReadFormat, ReadMode } from "../types.js";
import { fetchUrl, type FetchResult } from "./fetch.js";
import { fingerprintFetch } from "./fingerprint.js";
import { renderWithCloakBrowser } from "./browser.js";
import { extractFast, extractReadable, readableIsBetter } from "./readable.js";
import { htmlToMarkdown, htmlToText, sanitizeForContext } from "./markdown.js";

export interface ReadOptions {
	mode?: ReadMode;
	format?: ReadFormat;
	onlyMainContent?: boolean;
	removeImages?: boolean;
	/**
	 * Truncate materialized body. Omit / 0 = no truncate.
	 * For excerpt ranking, callers pass a large budget (e.g. 100k) so mid-page
	 * sections remain available before web_read selects query-ranked chunks.
	 */
	maxChars?: number;
	maxBytes?: number;
	timeoutMs?: number;
	/** CloakBrowser headless mode. Default true. */
	headless?: boolean;
	signal?: AbortSignal;
}

export interface ReadResult {
	url: string;
	finalUrl: string;
	title?: string;
	mode: string;
	format: ReadFormat;
	content: string;
	status: number;
	chars: number;
}

interface PageSignals {
	blockedLikely: boolean;
	spaLikely: boolean;
	sparseDom: boolean;
	textLength: number;
}

const BLOCK_PATTERNS = [
	/captcha/iu,
	/cloudflare/iu,
	/access denied/iu,
	/temporarily blocked/iu,
	/unusual traffic/iu,
	/please verify you are a human/iu,
];

const SPA_PATTERNS = [
	/id=["'](?:root|app|__next)["']/iu,
	/__NEXT_DATA__/u,
	/window\.__INITIAL_STATE__/u,
	/data-reactroot/iu,
	/enable javascript/iu,
];

function analyzeSignals(status: number, html: string, text: string): PageSignals {
	const statusBlocked = status === 401 || status === 403 || status === 429 || status === 503;
	const blockedLikely =
		statusBlocked || BLOCK_PATTERNS.some((p) => p.test(html) || p.test(text));
	const spaLikely = SPA_PATTERNS.some((p) => p.test(html));
	const htmlLength = html.length;
	const textLength = text.length;
	const textDensity = htmlLength > 0 ? textLength / htmlLength : 0;
	// Absolute text length wins over density — heavy community pages pack
	// megabytes of chrome around a solid article and must not look "sparse".
	const sparseDom =
		textLength < 200 || (textLength < 1200 && textDensity < 0.03);
	return { blockedLikely, spaLikely, sparseDom, textLength };
}

function materialize(
	html: string,
	text: string,
	format: ReadFormat,
	removeImages: boolean,
	onlyMainContent: boolean,
	title?: string,
): { content: string; title?: string } {
	let workingHtml = html;
	let workingText = text;
	let workingTitle = title;

	if (onlyMainContent) {
		const readable = extractReadable(html);
		if (
			readable.ok &&
			readable.contentHtml &&
			readableIsBetter(readable.textContent, text)
		) {
			workingHtml = readable.contentHtml;
			workingText = readable.textContent ?? workingText;
			workingTitle = readable.title ?? workingTitle;
		}
	}

	if (format === "html") {
		return { content: workingHtml, title: workingTitle };
	}
	if (format === "text") {
		return {
			content: workingText || htmlToText(workingHtml),
			title: workingTitle,
		};
	}
	return {
		content: htmlToMarkdown(workingHtml, { removeImages }),
		title: workingTitle,
	};
}

function truncate(content: string, maxChars?: number): string {
	const cleaned = sanitizeForContext(content);
	if (!maxChars || maxChars <= 0 || cleaned.length <= maxChars) return cleaned;
	return cleaned.slice(0, maxChars) + "\n\n…[truncated]";
}

function fromFetch(
	fetched: FetchResult,
	mode: string,
	options: Required<
		Pick<ReadOptions, "format" | "onlyMainContent" | "removeImages">
	> &
		Pick<ReadOptions, "maxChars">,
): ReadResult {
	const fast = extractFast(fetched.html);
	const { content, title } = materialize(
		fetched.html,
		fast.text,
		options.format,
		options.removeImages,
		options.onlyMainContent,
		fast.title,
	);
	const truncated = truncate(content, options.maxChars);
	return {
		url: fetched.url,
		finalUrl: fetched.finalUrl,
		title,
		mode,
		format: options.format,
		content: truncated,
		status: fetched.status,
		chars: truncated.length,
	};
}

export async function readUrl(url: string, options: ReadOptions = {}): Promise<ReadResult> {
	const mode = options.mode ?? "auto";
	const format = options.format ?? "markdown";
	const onlyMainContent = options.onlyMainContent ?? true;
	const removeImages = options.removeImages ?? false;
	const timeoutMs = options.timeoutMs ?? 30_000;
	const maxBytes = options.maxBytes;
	const headless = options.headless !== false;
	const signal = options.signal;
	const matOpts = { format, onlyMainContent, removeImages, maxChars: options.maxChars };
	const browserOpts = { signal, timeoutMs, headless };

	if (mode === "browser") {
		const rendered = await renderWithCloakBrowser(url, browserOpts);
		const fast = extractFast(rendered.html);
		const { content, title } = materialize(
			rendered.html,
			fast.text,
			format,
			removeImages,
			onlyMainContent,
			fast.title,
		);
		let truncated = truncate(content, options.maxChars);

		// Community sites often redirect CloakBrowser to SSO/signup while plain
		// HTTP still serves the article. Prefer the richer extract.
		if (truncated.length < 1500 || /log\s*in|sign\s*up|sso|exclusive benefits/i.test(truncated)) {
			try {
				const http = await fetchUrl(url, { signal, timeoutMs, maxBytes });
				const httpResult = fromFetch(http, "browser-fallback-fast", matOpts);
				if (httpResult.chars > truncated.length * 1.5) {
					return httpResult;
				}
			} catch {
				// keep browser result
			}
		}

		return {
			url,
			finalUrl: rendered.finalUrl,
			title,
			mode: "browser",
			format,
			content: truncated,
			status: rendered.status,
			chars: truncated.length,
		};
	}

	if (mode === "fingerprint") {
		const fetched = await fingerprintFetch(url, { signal, timeoutMs, maxBytes });
		return fromFetch(fetched, "fingerprint", matOpts);
	}

	// fast / readable / auto all start with undici
	const fastFetch = await fetchUrl(url, { signal, timeoutMs, maxBytes });
	const fast = extractFast(fastFetch.html);
	const signals = analyzeSignals(fastFetch.status, fastFetch.html, fast.text);

	if (mode === "fast") {
		return fromFetch(fastFetch, "fast", matOpts);
	}

	if (mode === "readable") {
		const readable = extractReadable(fastFetch.html);
		if (
			readable.ok &&
			readable.contentHtml &&
			readableIsBetter(readable.textContent, fast.text)
		) {
			const { content, title } = materialize(
				readable.contentHtml,
				readable.textContent ?? "",
				format,
				removeImages,
				false, // already applied
				readable.title ?? fast.title,
			);
			const truncated = truncate(content, options.maxChars);
			return {
				url: fastFetch.url,
				finalUrl: fastFetch.finalUrl,
				title,
				mode: "readable",
				format,
				content: truncated,
				status: fastFetch.status,
				chars: truncated.length,
			};
		}
		return fromFetch(fastFetch, "readable-fallback-fast", matOpts);
	}

	// === AUTO ===
	if (signals.blockedLikely) {
		try {
			const fp = await fingerprintFetch(url, { signal, timeoutMs, maxBytes });
			const fpFast = extractFast(fp.html);
			const fpSignals = analyzeSignals(fp.status, fp.html, fpFast.text);
			if (!fpSignals.blockedLikely && !fpSignals.sparseDom) {
				return fromFetch(fp, "fingerprint", matOpts);
			}
			if (fpSignals.spaLikely || fpSignals.sparseDom) {
				const rendered = await renderWithCloakBrowser(url, browserOpts);
				const rFast = extractFast(rendered.html);
				const { content, title } = materialize(
					rendered.html,
					rFast.text,
					format,
					removeImages,
					onlyMainContent,
					rFast.title,
				);
				const truncated = truncate(content, options.maxChars);
				return {
					url,
					finalUrl: rendered.finalUrl,
					title,
					mode: "browser",
					format,
					content: truncated,
					status: rendered.status,
					chars: truncated.length,
				};
			}
			return fromFetch(fp, "fingerprint", matOpts);
		} catch {
			// fall through to readable/browser on fingerprint failure
		}
	}

	if (signals.sparseDom || signals.textLength < 800) {
		const readable = extractReadable(fastFetch.html);
		if (
			readable.ok &&
			readable.contentHtml &&
			readableIsBetter(readable.textContent, fast.text)
		) {
			const readableText = readable.textContent ?? "";
			const { content, title } = materialize(
				readable.contentHtml,
				readableText,
				format,
				removeImages,
				false,
				readable.title ?? fast.title,
			);
			const truncated = truncate(content, options.maxChars);
			const stillThin = truncated.length < 200 && signals.spaLikely;
			if (!stillThin) {
				return {
					url: fastFetch.url,
					finalUrl: fastFetch.finalUrl,
					title,
					mode: "readable",
					format,
					content: truncated,
					status: fastFetch.status,
					chars: truncated.length,
				};
			}
		}

		if (signals.spaLikely || signals.sparseDom) {
			const rendered = await renderWithCloakBrowser(url, browserOpts);
			const rFast = extractFast(rendered.html);
			const { content, title } = materialize(
				rendered.html,
				rFast.text,
				format,
				removeImages,
				onlyMainContent,
				rFast.title,
			);
			const truncated = truncate(content, options.maxChars);
			return {
				url,
				finalUrl: rendered.finalUrl,
				title,
				mode: "browser",
				format,
				content: truncated,
				status: rendered.status,
				chars: truncated.length,
			};
		}
	}

	return fromFetch(fastFetch, "fast", matOpts);
}

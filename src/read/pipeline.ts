/** Local read pipeline: fast → fingerprint → readable → browser. */

import type { ReadFormat, ReadMode } from "../types.js";
import { fetchUrl, type FetchResult } from "./fetch.js";
import { fingerprintFetch } from "./fingerprint.js";
import { renderWithCloakBrowser } from "./browser.js";
import { extractFast, extractReadable, readableIsBetter } from "./readable.js";
import { htmlToMarkdown, htmlToText, sanitizeForContext } from "./markdown.js";
import {
	findAlternateUrls,
	isThinContent,
	parsePageMeta,
	type PageMeta,
} from "./hints.js";
import { tryReadGitHubIssue } from "./github.js";

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
	author?: string;
	published?: string;
	site?: string;
	language?: string;
	mode: string;
	format: ReadFormat;
	content: string;
	status: number;
	chars: number;
}

type MatOpts = Required<
	Pick<ReadOptions, "format" | "onlyMainContent" | "removeImages">
> &
	Pick<ReadOptions, "maxChars" | "maxBytes" | "timeoutMs" | "signal">;

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

/** Cap alternate follow-ups so a page full of link tags can't fan out. */
const MAX_ALTERNATE_TRIES = 3;

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

function withMeta(result: ReadResult, html: string, pageUrl: string): ReadResult {
	const meta: PageMeta = parsePageMeta(html, pageUrl);
	return {
		...result,
		title: result.title || meta.title,
		author: meta.author,
		published: meta.published,
		site: meta.site,
		language: meta.language,
	};
}

function fromFetch(fetched: FetchResult, mode: string, options: MatOpts): ReadResult {
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
	return withMeta(
		{
			url: fetched.url,
			finalUrl: fetched.finalUrl,
			title,
			mode,
			format: options.format,
			content: truncated,
			status: fetched.status,
			chars: truncated.length,
		},
		fetched.html,
		fetched.finalUrl || fetched.url,
	);
}

function isHtmlish(contentType: string): boolean {
	const t = contentType.split(";")[0].trim().toLowerCase();
	return t === "text/html" || t === "application/xhtml+xml" || t === "";
}

function contentFromAlternateBody(
	body: string,
	contentType: string,
	format: ReadFormat,
	removeImages: boolean,
	maxChars?: number,
): string {
	const mime = contentType.split(";")[0].trim().toLowerCase();
	if (mime.includes("html")) {
		const fast = extractFast(body);
		const { content } = materialize(
			body,
			fast.text,
			format,
			removeImages,
			true,
			fast.title,
		);
		return truncate(content, maxChars);
	}
	// markdown / plain / json — return as-is (json pretty-print if valid)
	let text = body.replace(/\r\n/g, "\n").trim();
	if (mime.includes("json")) {
		try {
			text = JSON.stringify(JSON.parse(text), null, 2);
		} catch {
			// keep raw
		}
	}
	return truncate(text, maxChars);
}

/**
 * When extraction is thin, follow rel=alternate targets that match the format.
 * Returns a richer result or the original.
 */
async function maybeFollowAlternates(
	result: ReadResult,
	html: string,
	options: MatOpts,
): Promise<ReadResult> {
	if (!isThinContent(result.chars)) return result;

	const alts = findAlternateUrls(
		html,
		result.finalUrl || result.url,
		options.format,
	).slice(0, MAX_ALTERNATE_TRIES);
	if (alts.length === 0) return result;

	let best = result;
	for (const altUrl of alts) {
		try {
			const fetched = await fetchUrl(altUrl, {
				signal: options.signal,
				timeoutMs: options.timeoutMs,
				maxBytes: options.maxBytes,
			});
			let content: string;
			let title = best.title;
			let metaHtml = fetched.html;

			if (isHtmlish(fetched.contentType)) {
				const fast = extractFast(fetched.html);
				const mat = materialize(
					fetched.html,
					fast.text,
					options.format,
					options.removeImages,
					options.onlyMainContent,
					fast.title,
				);
				content = truncate(mat.content, options.maxChars);
				title = mat.title ?? title;
			} else {
				content = contentFromAlternateBody(
					fetched.html,
					fetched.contentType,
					options.format,
					options.removeImages,
					options.maxChars,
				);
				// non-HTML alternates: keep parent page meta, just swap body
				metaHtml = html;
			}

			if (content.length > best.chars) {
				best = withMeta(
					{
						url: result.url,
						finalUrl: fetched.finalUrl,
						title,
						mode: `${result.mode}+alternate`,
						format: options.format,
						content,
						status: fetched.status,
						chars: content.length,
					},
					metaHtml,
					fetched.finalUrl || altUrl,
				);
				// good enough — stop early
				if (!isThinContent(best.chars)) break;
			}
		} catch {
			// try next alternate
		}
	}
	return best;
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
	const matOpts: MatOpts = {
		format,
		onlyMainContent,
		removeImages,
		maxChars: options.maxChars,
		maxBytes,
		timeoutMs,
		signal,
	};
	const browserOpts = { signal, timeoutMs, headless };

	// GitHub issues/PRs: REST API beats HTML chrome (unless mode=browser forces render).
	if (mode !== "browser") {
		const gh = await tryReadGitHubIssue(url, {
			format,
			maxChars: options.maxChars,
			timeoutMs,
			signal,
		});
		if (gh) return gh;
	}

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
				const httpResult = await maybeFollowAlternates(
					fromFetch(http, "browser-fallback-fast", matOpts),
					http.html,
					matOpts,
				);
				if (httpResult.chars > truncated.length * 1.5) {
					return httpResult;
				}
			} catch {
				// keep browser result
			}
		}

		const browserResult = withMeta(
			{
				url,
				finalUrl: rendered.finalUrl,
				title,
				mode: "browser",
				format,
				content: truncated,
				status: rendered.status,
				chars: truncated.length,
			},
			rendered.html,
			rendered.finalUrl || url,
		);
		return maybeFollowAlternates(browserResult, rendered.html, matOpts);
	}

	if (mode === "fingerprint") {
		const fetched = await fingerprintFetch(url, { signal, timeoutMs, maxBytes });
		return maybeFollowAlternates(fromFetch(fetched, "fingerprint", matOpts), fetched.html, matOpts);
	}

	// fast / readable / auto all start with undici
	const fastFetch = await fetchUrl(url, { signal, timeoutMs, maxBytes });
	const fast = extractFast(fastFetch.html);
	const signals = analyzeSignals(fastFetch.status, fastFetch.html, fast.text);

	if (mode === "fast") {
		return maybeFollowAlternates(fromFetch(fastFetch, "fast", matOpts), fastFetch.html, matOpts);
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
			const result = withMeta(
				{
					url: fastFetch.url,
					finalUrl: fastFetch.finalUrl,
					title,
					mode: "readable",
					format,
					content: truncated,
					status: fastFetch.status,
					chars: truncated.length,
				},
				fastFetch.html,
				fastFetch.finalUrl || fastFetch.url,
			);
			return maybeFollowAlternates(result, fastFetch.html, matOpts);
		}
		return maybeFollowAlternates(
			fromFetch(fastFetch, "readable-fallback-fast", matOpts),
			fastFetch.html,
			matOpts,
		);
	}

	// === AUTO ===
	if (signals.blockedLikely) {
		try {
			const fp = await fingerprintFetch(url, { signal, timeoutMs, maxBytes });
			const fpFast = extractFast(fp.html);
			const fpSignals = analyzeSignals(fp.status, fp.html, fpFast.text);
			if (!fpSignals.blockedLikely && !fpSignals.sparseDom) {
				return maybeFollowAlternates(
					fromFetch(fp, "fingerprint", matOpts),
					fp.html,
					matOpts,
				);
			}
			if (fpSignals.spaLikely || fpSignals.sparseDom) {
				// Try alternates on the fingerprint HTML before launching a browser.
				const fpResult = await maybeFollowAlternates(
					fromFetch(fp, "fingerprint", matOpts),
					fp.html,
					matOpts,
				);
				if (!isThinContent(fpResult.chars) && !fpSignals.blockedLikely) {
					return fpResult;
				}

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
				return withMeta(
					{
						url,
						finalUrl: rendered.finalUrl,
						title,
						mode: "browser",
						format,
						content: truncated,
						status: rendered.status,
						chars: truncated.length,
					},
					rendered.html,
					rendered.finalUrl || url,
				);
			}
			return maybeFollowAlternates(fromFetch(fp, "fingerprint", matOpts), fp.html, matOpts);
		} catch {
			// fall through to readable/browser on fingerprint failure
		}
	}

	if (signals.sparseDom || signals.textLength < 800) {
		// Alternates first — often cheaper and better than Readability on empty shells.
		const altResult = await maybeFollowAlternates(
			fromFetch(fastFetch, "fast", matOpts),
			fastFetch.html,
			matOpts,
		);
		if (!isThinContent(altResult.chars) && altResult.mode.includes("alternate")) {
			return altResult;
		}

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
				const result = withMeta(
					{
						url: fastFetch.url,
						finalUrl: fastFetch.finalUrl,
						title,
						mode: "readable",
						format,
						content: truncated,
						status: fastFetch.status,
						chars: truncated.length,
					},
					fastFetch.html,
					fastFetch.finalUrl || fastFetch.url,
				);
				return maybeFollowAlternates(result, fastFetch.html, matOpts);
			}
		}

		if (signals.spaLikely || signals.sparseDom) {
			// Prefer a successful alternate over browser when we already found one.
			if (altResult.chars > 200 && altResult.mode.includes("alternate")) {
				return altResult;
			}

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
			return withMeta(
				{
					url,
					finalUrl: rendered.finalUrl,
					title,
					mode: "browser",
					format,
					content: truncated,
					status: rendered.status,
					chars: truncated.length,
				},
				rendered.html,
				rendered.finalUrl || url,
			);
		}

		return altResult;
	}

	return maybeFollowAlternates(
		fromFetch(fastFetch, "fast", matOpts),
		fastFetch.html,
		matOpts,
	);
}

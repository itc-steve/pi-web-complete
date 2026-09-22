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
import {
	detectBlock,
	getHostFloor,
	liftHostFloor,
	shouldRefuseResidual,
	blockedNotice,
	type BlockVerdict,
	type LoadTier,
} from "./block.js";
import type { BrowserRenderResult } from "./browser.js";
import { archiveBanner, findWaybackSnapshot, isDeadStatus } from "./archive.js";
import { cookieHeaderFor } from "./cookies.js";
import { isAbortError } from "./errors.js";
import { extractPdfText } from "./pdf.js";
import { MAX_STITCH_PAGES, findRelNext, stitchPartMarker } from "./stitch.js";

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
	/** Wayback on 404/410 and network failure. Default auto. */
	archive?: "auto" | "never";
	/** Follow rel=next up to 3 extra pages. Default false. */
	stitch?: boolean;
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
	highBlock: boolean;
	spaLikely: boolean;
	sparseDom: boolean;
	textLength: number;
}

const SPA_PATTERNS = [
	/id=["'](?:root|app|__next)["']/iu,
	/__NEXT_DATA__/u,
	/window\.__INITIAL_STATE__/u,
	/data-reactroot/iu,
	/enable javascript/iu,
];

/** Cap alternate follow-ups so a page full of link tags can't fan out. */
const MAX_ALTERNATE_TRIES = 3;

function analyzeSignals(
	status: number,
	html: string,
	text: string,
	challengeHeader = false,
): PageSignals {
	const verdict = detectBlock(status, html, text, challengeHeader);
	const spaLikely = SPA_PATTERNS.some((p) => p.test(html));
	const htmlLength = html.length;
	const textLength = text.length;
	const textDensity = htmlLength > 0 ? textLength / htmlLength : 0;
	// Absolute text length wins over density — heavy community pages pack
	// megabytes of chrome around a solid article and must not look "sparse".
	const sparseDom =
		textLength < 200 || (textLength < 1200 && textDensity < 0.03);
	return {
		blockedLikely: verdict.confidence !== "none",
		highBlock: verdict.confidence === "high",
		spaLikely,
		sparseDom,
		textLength,
	};
}

function refuseResult(
	url: string,
	finalUrl: string,
	status: number,
	verdict: BlockVerdict,
	format: ReadFormat,
): ReadResult {
	const content = blockedNotice(finalUrl || url, status, verdict.reason ?? "blocked");
	return {
		url,
		finalUrl: finalUrl || url,
		title: "Blocked",
		mode: "blocked",
		format,
		content,
		status,
		chars: content.length,
	};
}

function pageFromBrowser(
	url: string,
	rendered: BrowserRenderResult,
	mat: MatOpts,
	format: ReadFormat,
	onlyMainContent: boolean,
	removeImages: boolean,
	climbFromHigh: boolean,
): ReadResult {
	const rFast = extractFast(rendered.html);
	const { content, title } = materialize(
		rendered.html,
		rFast.text,
		format,
		removeImages,
		onlyMainContent,
		rFast.title,
	);
	const truncated = truncate(content, mat.maxChars);
	const verdict = detectBlock(rendered.status, rendered.html, rFast.text);
	if (climbFromHigh || verdict.confidence === "high") liftHostFloor(url, "browser");
	if (shouldRefuseResidual(verdict, truncated.length)) {
		return refuseResult(url, rendered.finalUrl, rendered.status, verdict, format);
	}
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

function titleFromUrl(url: string): string | undefined {
	try {
		const seg = new URL(url).pathname.split("/").filter(Boolean).pop();
		if (!seg) return undefined;
		const decoded = decodeURIComponent(seg);
		// Only use basename when it looks like a filename — "/v1/users/42" → undefined, not "42".
		if (!/\.[a-z0-9]{1,8}$/i.test(decoded)) return undefined;
		return decoded;
	} catch {
		return undefined;
	}
}

/** HTML + XML/feeds — Readability + withMeta path (RSS/Atom are +xml). */
export function isHtmlish(contentType: string): boolean {
	const t = contentType.split(";")[0].trim().toLowerCase();
	// image/svg+xml ends in +xml but is not an HTML/feed document.
	if (t.startsWith("image/")) return false;
	return (
		t === "text/html" ||
		t === "application/xhtml+xml" ||
		t === "" ||
		t.endsWith("+xml") ||
		t === "text/xml" ||
		t === "application/xml"
	);
}

/** application/pdf Content-Type, or body starts with the %PDF- magic. */
function isPdfContent(contentType: string, body: string): boolean {
	const mime = contentType.split(";")[0].trim().toLowerCase();
	if (mime === "application/pdf") return true;
	return body.startsWith("%PDF-");
}

/** True when the body should skip HTML extraction (non-HTML MIME or PDF magic). */
export function isRawBody(contentType: string, body: string): boolean {
	return !isHtmlish(contentType) || isPdfContent(contentType, body);
}

/** Sniff real HTML even when Content-Type is wrong (e.g. text/plain). */
function looksLikeHtml(body: string): boolean {
	return /^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(body);
}

export function contentFromAlternateBody(
	body: string,
	contentType: string,
	format: ReadFormat,
	removeImages: boolean,
	maxChars?: number,
	bytes?: number,
): string {
	// PDF first — never turndown binary / application/pdf
	if (isPdfContent(contentType, body)) {
		const n = bytes ?? Buffer.byteLength(body);
		return truncate(
			`[PDF document — text extraction not supported. ${n} bytes. Open the URL directly or use an external converter.]`,
			maxChars,
		);
	}

	const mime = contentType.split(";")[0].trim().toLowerCase();
	if (mime.includes("html") || looksLikeHtml(body)) {
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

async function fromFetch(fetched: FetchResult, mode: string, options: MatOpts): Promise<ReadResult> {
	if (isPdfContent(fetched.contentType, fetched.html)) {
		const extracted = fetched.raw?.byteLength ? await extractPdfText(fetched.raw) : "";
		if (extracted) {
			const content = truncate(extracted, options.maxChars);
			return {
				url: fetched.url,
				finalUrl: fetched.finalUrl,
				title: titleFromUrl(fetched.finalUrl || fetched.url),
				mode: `${mode}+pdf`,
				format: options.format,
				content,
				status: fetched.status,
				chars: content.length,
			};
		}
	}
	// Non-HTML / PDF: skip Readability + turndown; reuse alternate-body path.
	if (isRawBody(fetched.contentType, fetched.html)) {
		const content = contentFromAlternateBody(
			fetched.html,
			fetched.contentType,
			options.format,
			options.removeImages,
			options.maxChars,
			fetched.bytes,
		);
		return {
			url: fetched.url,
			finalUrl: fetched.finalUrl,
			title: titleFromUrl(fetched.finalUrl || fetched.url),
			mode: `${mode}+raw`,
			format: options.format,
			content,
			status: fetched.status,
			chars: content.length,
		};
	}

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
					fetched.bytes,
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

function isArchiveHost(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		return host === "web.archive.org" || host === "archive.org" || host.endsWith(".archive.org");
	} catch {
		return false;
	}
}

function isNetworkFail(err: unknown): boolean {
	if (isAbortError(err)) return false;
	const msg = err instanceof Error ? err.message : String(err);
	if (/SSRF blocked|Invalid URL|Too many redirects|credentials in URL|privileged port/i.test(msg)) {
		return false;
	}
	return true;
}

async function readArchived(
	url: string,
	mode: string,
	mat: MatOpts,
): Promise<{ result: ReadResult; html: string } | null> {
	if (isArchiveHost(url)) return null;
	const snap = await findWaybackSnapshot(url, { signal: mat.signal });
	if (!snap) return null;
	try {
		const fetched = await fetchUrl(snap.snapshotUrl, {
			signal: mat.signal,
			timeoutMs: mat.timeoutMs,
			maxBytes: mat.maxBytes,
		});
		if (isDeadStatus(fetched.status)) return null;
		const result = await fromFetch(fetched, `${mode}+archive`, mat);
		const content = `${archiveBanner(snap.timestamp, snap.snapshotUrl)}\n\n${result.content}`;
		return {
			result: { ...result, url, content, chars: content.length },
			html: fetched.html,
		};
	} catch {
		return null;
	}
}

async function bounceWithCookies(
	url: string,
	mat: MatOpts,
): Promise<{ result: ReadResult; html: string } | null> {
	if (!cookieHeaderFor(url)) return null;
	try {
		const fetched = await fetchUrl(url, {
			signal: mat.signal,
			timeoutMs: mat.timeoutMs,
			maxBytes: mat.maxBytes,
		});
		const fast = extractFast(fetched.html);
		const verdict = detectBlock(
			fetched.status,
			fetched.html,
			fast.text,
			fetched.challengeHeader,
		);
		if (verdict.confidence === "high") return null;
		const result = await fromFetch(fetched, "cookie-bounce", mat);
		if (shouldRefuseResidual(verdict, result.chars)) return null;
		return { result, html: fetched.html };
	} catch {
		return null;
	}
}

async function maybeStitchPages(
	result: ReadResult,
	html: string,
	mat: MatOpts,
): Promise<ReadResult> {
	const parts = [result.content];
	const seen = new Set<string>([result.finalUrl, result.url]);
	let currentHtml = html;
	let currentUrl = result.finalUrl || result.url;
	for (let i = 0; i < MAX_STITCH_PAGES; i++) {
		const next = findRelNext(currentHtml, currentUrl);
		if (!next || seen.has(next)) break;
		seen.add(next);
		try {
			const fetched = await fetchUrl(next, {
				signal: mat.signal,
				timeoutMs: mat.timeoutMs,
				maxBytes: mat.maxBytes,
			});
			if (isDeadStatus(fetched.status) || isPdfContent(fetched.contentType, fetched.html)) {
				break;
			}
			const page = await fromFetch(fetched, "stitch", mat);
			parts.push(stitchPartMarker(i + 2, page.finalUrl) + page.content);
			currentHtml = fetched.html;
			currentUrl = page.finalUrl || next;
		} catch {
			break;
		}
	}
	if (parts.length === 1) return result;
	const content = truncate(parts.join(""), mat.maxChars);
	return { ...result, content, chars: content.length, mode: `${result.mode}+stitch` };
}

async function finalize(
	result: ReadResult,
	html: string,
	mat: MatOpts,
	stitch: boolean,
): Promise<ReadResult> {
	const out = await maybeFollowAlternates(result, html, mat);
	if (
		!stitch ||
		out.mode === "blocked" ||
		out.mode.includes("pdf") ||
		out.mode.includes("raw")
	) {
		return out;
	}
	return maybeStitchPages(out, html, mat);
}

async function climbBrowser(
	url: string,
	rendered: BrowserRenderResult,
	mat: MatOpts,
	format: ReadFormat,
	onlyMainContent: boolean,
	removeImages: boolean,
	climbFromHigh: boolean,
	stitch: boolean,
): Promise<ReadResult> {
	const preview = pageFromBrowser(
		url,
		rendered,
		mat,
		format,
		onlyMainContent,
		removeImages,
		climbFromHigh,
	);
	const bounced = await bounceWithCookies(url, mat);
	let chosen = preview;
	let html = rendered.html;
	if (
		bounced &&
		(preview.mode === "blocked" || bounced.result.chars >= preview.chars)
	) {
		chosen = bounced.result;
		html = bounced.html;
	}
	if (chosen.mode === "blocked") return chosen;
	return finalize(chosen, html, mat, stitch);
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
	const stitch = Boolean(options.stitch);
	const archiveOn = options.archive !== "never";
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

	const tryArchive = async (modeName: string) =>
		archiveOn ? readArchived(url, modeName, matOpts) : null;

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

	const autoFloor: LoadTier = mode === "auto" ? getHostFloor(url) : "fast";

	if (mode === "browser" || autoFloor === "browser") {
		const rendered = await renderWithCloakBrowser(url, browserOpts);
		const climbed = await climbBrowser(
			url,
			rendered,
			matOpts,
			format,
			onlyMainContent,
			removeImages,
			autoFloor === "browser",
			stitch,
		);

		// Forced browser: community sites often redirect CloakBrowser to SSO
		// while plain HTTP still serves the article. Skip when this host already
		// proved HTTP is blocked (host-sticky floor).
		if (
			mode === "browser" &&
			climbed.mode !== "blocked" &&
			(climbed.chars < 1500 || /log\s*in|sign\s*up|sso|exclusive benefits/i.test(climbed.content))
		) {
			try {
				const http = await fetchUrl(url, { signal, timeoutMs, maxBytes });
				const httpFast = extractFast(http.html);
				const httpBlock = detectBlock(
					http.status,
					http.html,
					httpFast.text,
					http.challengeHeader,
				);
				if (httpBlock.confidence !== "high") {
					const httpResult = await finalize(
						await fromFetch(http, "browser-fallback-fast", matOpts),
						http.html,
						matOpts,
						stitch,
					);
					if (httpResult.chars > climbed.chars * 1.5) {
						return httpResult;
					}
				}
			} catch {
				// keep browser result
			}
		}

		return climbed;
	}

	if (mode === "fingerprint") {
		try {
			const fetched = await fingerprintFetch(url, { signal, timeoutMs, maxBytes });
			if (isDeadStatus(fetched.status)) {
				const archived = await tryArchive("fingerprint");
				if (archived) return finalize(archived.result, archived.html, matOpts, stitch);
			}
			return finalize(await fromFetch(fetched, "fingerprint", matOpts), fetched.html, matOpts, stitch);
		} catch (err) {
			if (archiveOn && isNetworkFail(err)) {
				const archived = await tryArchive("fingerprint");
				if (archived) return finalize(archived.result, archived.html, matOpts, stitch);
			}
			throw err;
		}
	}

	// fast / readable / auto start with undici, unless auto already knows this host needs fingerprint.
	const startedAt: LoadTier =
		mode === "auto" && autoFloor === "fingerprint" ? "fingerprint" : "fast";
	let fastFetch: FetchResult;
	try {
		fastFetch =
			startedAt === "fingerprint"
				? await fingerprintFetch(url, { signal, timeoutMs, maxBytes })
				: await fetchUrl(url, { signal, timeoutMs, maxBytes });
	} catch (err) {
		if (archiveOn && isNetworkFail(err)) {
			const archived = await tryArchive(mode === "auto" ? "fast" : mode);
			if (archived) return finalize(archived.result, archived.html, matOpts, stitch);
		}
		throw err;
	}
	if (isDeadStatus(fastFetch.status)) {
		const archived = await tryArchive(mode === "auto" ? "fast" : mode);
		if (archived) return finalize(archived.result, archived.html, matOpts, stitch);
	}

	// PDF only: skip signal analysis, alternates, and browser. Other non-HTML
	// (text/plain, JSON, mislabeled HTML) still enters the recovery ladder so
	// maybeFollowAlternates can run; fromFetch routes the body itself via
	// contentFromAlternateBody when isRawBody is true. Browser escalation is
	// gated on !rawBody later — raw bodies never benefit from a Chromium launch.
	if (isPdfContent(fastFetch.contentType, fastFetch.html)) {
		const baseMode = mode === "auto" ? "fast" : mode;
		return fromFetch(fastFetch, baseMode, matOpts);
	}

	const rawBody = isRawBody(fastFetch.contentType, fastFetch.html);
	const fast = extractFast(fastFetch.html);
	const signals = analyzeSignals(
		fastFetch.status,
		fastFetch.html,
		fast.text,
		fastFetch.challengeHeader,
	);

	if (mode === "fast") {
		return finalize(await fromFetch(fastFetch, "fast", matOpts), fastFetch.html, matOpts, stitch);
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
			return finalize(result, fastFetch.html, matOpts, stitch);
		}
		return finalize(
			await fromFetch(fastFetch, "readable-fallback-fast", matOpts),
			fastFetch.html,
			matOpts,
			stitch,
		);
	}

	// === AUTO ===
	if (signals.blockedLikely) {
		try {
			const fp =
				startedAt === "fingerprint"
					? fastFetch
					: await fingerprintFetch(url, { signal, timeoutMs, maxBytes });
			const fpFast = extractFast(fp.html);
			const fpSignals = analyzeSignals(fp.status, fp.html, fpFast.text, fp.challengeHeader);
			if (!fpSignals.blockedLikely && !fpSignals.sparseDom) {
				if (signals.highBlock) liftHostFloor(url, "fingerprint");
				return finalize(await fromFetch(fp, "fingerprint", matOpts), fp.html, matOpts, stitch);
			}
			if (fpSignals.spaLikely || fpSignals.sparseDom || fpSignals.blockedLikely) {
				// Try alternates on the fingerprint HTML before launching a browser.
				const fpResult = await finalize(
					await fromFetch(fp, "fingerprint", matOpts),
					fp.html,
					matOpts,
					stitch,
				);
				if (!isThinContent(fpResult.chars) && !fpSignals.blockedLikely) {
					return fpResult;
				}

				// Raw bodies never benefit from browser; auto must not hard-depend on it.
				if (rawBody) {
					const fpVerdict = detectBlock(fp.status, fp.html, fpFast.text, fp.challengeHeader);
					if (shouldRefuseResidual(fpVerdict, fpResult.chars)) {
						return refuseResult(url, fp.finalUrl, fp.status, fpVerdict, format);
					}
					return fpResult;
				}

				try {
					const rendered = await renderWithCloakBrowser(url, browserOpts);
					return climbBrowser(
						url,
						rendered,
						matOpts,
						format,
						onlyMainContent,
						removeImages,
						signals.highBlock || fpSignals.highBlock,
						stitch,
					);
				} catch {
					const fpVerdict = detectBlock(fp.status, fp.html, fpFast.text, fp.challengeHeader);
					if (shouldRefuseResidual(fpVerdict, fpResult.chars)) {
						return refuseResult(url, fp.finalUrl, fp.status, fpVerdict, format);
					}
					return fpResult;
				}
			}
			if (signals.highBlock && !fpSignals.highBlock) liftHostFloor(url, "fingerprint");
			return finalize(await fromFetch(fp, "fingerprint", matOpts), fp.html, matOpts, stitch);
		} catch {
			// fall through to readable/browser on fingerprint failure
		}
	}

	if (signals.sparseDom || signals.textLength < 800) {
		// Alternates first — often cheaper and better than Readability on empty shells.
		const altResult = await finalize(
			await fromFetch(fastFetch, "fast", matOpts),
			fastFetch.html,
			matOpts,
			stitch,
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
				return finalize(result, fastFetch.html, matOpts, stitch);
			}
		}

		// Raw bodies keep alternates (above) but never escalate to browser.
		if (!rawBody && (signals.spaLikely || signals.sparseDom)) {
			// Prefer a successful alternate over browser when we already found one.
			if (altResult.chars > 200 && altResult.mode.includes("alternate")) {
				return altResult;
			}

			try {
				const rendered = await renderWithCloakBrowser(url, browserOpts);
				return climbBrowser(
					url,
					rendered,
					matOpts,
					format,
					onlyMainContent,
					removeImages,
					signals.highBlock,
					stitch,
				);
			} catch {
				// Auto ladder must degrade to the best HTTP result, not throw.
				return altResult;
			}
		}

		return altResult;
	}

	return finalize(await fromFetch(fastFetch, "fast", matOpts), fastFetch.html, matOpts, stitch);
}

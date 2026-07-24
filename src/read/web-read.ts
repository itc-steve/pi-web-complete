/** web_read tool — local CloakBrowser extraction. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { config, refreshConfig } from "../config.js";
import { setReadStatus } from "../status.js";
import { pageOutline, selectExcerpts } from "./excerpts.js";
import { readUrl } from "./pipeline.js";
import type { ReadFormat, ReadMode, ReadReturnMode } from "../types.js";

/** Cap tool text returned to the model when return=full and not saving. */
const DEFAULT_CONTEXT_MAX_CHARS = 12_000;
/** Default char budget for ranked excerpts. */
const DEFAULT_EXCERPT_MAX_CHARS = 6_000;
/**
 * Internal materialize budget when ranking excerpts so mid/late page sections
 * are still available to score (not blind head-truncated).
 */
const EXCERPT_SOURCE_MAX_CHARS = 100_000;
const SAVE_PREVIEW_CHARS = 400;

function expandHome(path: string): string {
	if (path.startsWith("~/") || path === "~") {
		return resolve(process.env.HOME || process.env.USERPROFILE || "", path.slice(2) || ".");
	}
	return path;
}

function resolveUserPath(path: string, cwd: string): string {
	if (path.includes("\0")) {
		throw new Error("Invalid path: null bytes are not allowed");
	}
	const expanded = expandHome(path);
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function slugifyFilename(title: string | undefined, url: string): string {
	const base =
		(title && title.trim()) ||
		(() => {
			try {
				const u = new URL(url);
				return u.pathname.split("/").filter(Boolean).pop() || "page";
			} catch {
				return "page";
			}
		})();
	const slug = base
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return (slug || "page") + ".md";
}

const webReadParameters = Type.Object({
	url: Type.String({
		description: "URL to fetch / open / read",
	}),
	query: Type.Optional(
		Type.String({
			description:
				"What you need from the page (keywords / focus). Used to rank excerpts when return=excerpts (default). " +
				"Strongly preferred for every chat read.",
		}),
	),
	return: Type.Optional(
		StringEnum(["excerpts", "full"] as const, {
			description:
				"Chat return shape. excerpts (default): ranked chunks vs query, or page outline if query omitted. " +
				"full: entire main-content body (subject to maxChars caps). Ignored when savePath/saveDir is set.",
		}),
	),
	mode: Type.Optional(
		StringEnum(["auto", "fast", "fingerprint", "readable", "browser"] as const, {
			description:
				"Extraction strategy. auto (default) escalates: fast → fingerprint → readable → browser. " +
				"Use browser when the user asks for CloakBrowser.",
		}),
	),
	format: Type.Optional(
		StringEnum(["markdown", "text", "html"] as const, {
			description:
				"Output format. Default: markdown. Prefer markdown; use html only with savePath/saveDir.",
		}),
	),
	onlyMainContent: Type.Optional(
		Type.Boolean({
			description: "Apply Readability main-content cleanup. Default: true.",
			default: true,
		}),
	),
	maxChars: Type.Optional(
		Type.Number({
			description:
				"Truncate extracted body (0/omit = no limit on saved files). " +
				"With return=full and no save target, chat return is still capped (~12k). " +
				"With return=excerpts, caps the excerpt budget (~6k default).",
		}),
	),
	maxBytes: Type.Optional(
		Type.Number({
			description:
				"Max download bytes (floored at 2MB; default 5MB). Oversized bodies truncate, do not fail.",
		}),
	),
	headless: Type.Optional(
		Type.Boolean({
			description:
				"CloakBrowser window visibility. true (default) = headless; false = visible. " +
				"Falls back to read.headless in web.json.",
			default: true,
		}),
	),
	savePath: Type.Optional(
		Type.String({
			description:
				"Write the full extract to this exact file (dirs created). Supports ~/…. " +
				"Returns a short summary only — use for single-file vault writes.",
		}),
	),
	saveDir: Type.Optional(
		Type.String({
			description:
				"Write the full extract into this directory as <title-slug>.md (dirs created). " +
				"Supports ~/…. Preferred for multi-page vault scrapes — returns a short summary only.",
		}),
	),
});

async function executeWebRead(
	_toolCallId: string,
	params: Record<string, any>,
	signal: AbortSignal,
	onUpdate: (update: { content: Array<{ type: string; text: string }> }) => void,
	ctx: {
		cwd: string;
		ui: { setStatus: (key: string, status: string) => void };
	},
) {
	refreshConfig(ctx.cwd);

	const readCfg = config.read ?? {};
	const mode = (params.mode ?? readCfg.defaultMode ?? "auto") as ReadMode;
	const format = (params.format ?? readCfg.defaultFormat ?? "markdown") as ReadFormat;
	const onlyMainContent = params.onlyMainContent ?? readCfg.onlyMainContent ?? true;
	const headless = params.headless ?? readCfg.headless ?? true;
	const savePathRaw = typeof params.savePath === "string" ? params.savePath.trim() : "";
	const saveDirRaw = typeof params.saveDir === "string" ? params.saveDir.trim() : "";
	const saving = Boolean(savePathRaw || saveDirRaw);
	const query = typeof params.query === "string" ? params.query.trim() : "";
	const returnMode = (
		saving
			? "full"
			: ((params.return as string | undefined) ?? readCfg.defaultReturn ?? "excerpts")
	) as ReadReturnMode;
	const wantExcerpts = !saving && returnMode === "excerpts";
	// Default strip images for chat returns — inline/base64 media is the #1 overload vector.
	const removeImages = saving
		? (readCfg.removeImages ?? false)
		: (readCfg.removeImages ?? true);

	let maxChars: number | undefined;
	if (saving) {
		maxChars =
			params.maxChars && params.maxChars > 0 ? params.maxChars : undefined;
	} else if (wantExcerpts) {
		// Fetch a large source body for ranking; chat budget applied after selectExcerpts.
		maxChars = EXCERPT_SOURCE_MAX_CHARS;
	} else {
		maxChars =
			typeof params.maxChars === "number" && params.maxChars > 0
				? params.maxChars
				: readCfg.maxChars && readCfg.maxChars > 0
					? readCfg.maxChars
					: DEFAULT_CONTEXT_MAX_CHARS;
	}

	let excerptBudget = DEFAULT_EXCERPT_MAX_CHARS;
	if (wantExcerpts) {
		excerptBudget =
			params.maxChars && params.maxChars > 0
				? params.maxChars
				: readCfg.excerptMaxChars && readCfg.excerptMaxChars > 0
					? readCfg.excerptMaxChars
					: DEFAULT_EXCERPT_MAX_CHARS;
	}

	const maxBytes = params.maxBytes ?? readCfg.maxBytes;
	const timeoutMs = (readCfg.timeoutSeconds ?? 30) * 1000;

	const setStatus = (status: string) => {
		setReadStatus(ctx.ui, status);
		onUpdate?.({ content: [{ type: "text", text: `*${status}*` }] });
	};

	setStatus(`📄 reading (${mode}${headless ? "" : ", visible"})...`);
	try {
		const result = await readUrl(params.url, {
			mode,
			format,
			onlyMainContent,
			removeImages,
			maxChars,
			maxBytes,
			timeoutMs,
			headless,
			signal,
		});

		const headerLines = [
			`# ${result.title || "Untitled"}`,
			`URL: ${result.finalUrl}`,
			`Mode: ${result.mode} · Format: ${result.format} · Status: ${result.status}` +
				(result.mode.includes("browser") ? ` · Headless: ${headless}` : ""),
		];
		if (result.author) headerLines.push(`Author: ${result.author}`);
		if (result.published) headerLines.push(`Published: ${result.published}`);
		if (result.site) headerLines.push(`Site: ${result.site}`);
		if (result.language) headerLines.push(`Language: ${result.language}`);

		if (saving) {
			const header = [...headerLines, ""].join("\n");
			const fullBody = `${header}${result.content}`;
			let abs: string;
			if (savePathRaw) {
				abs = resolveUserPath(savePathRaw, ctx.cwd);
			} else {
				const dir = resolveUserPath(saveDirRaw, ctx.cwd);
				abs = join(dir, slugifyFilename(result.title, result.finalUrl || params.url));
			}
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, fullBody, "utf-8");
			const preview = result.content.slice(0, SAVE_PREVIEW_CHARS);
			const summary = [
				`Saved: ${abs}`,
				`Title: ${result.title || "Untitled"}`,
				`URL: ${result.finalUrl}`,
				`Mode: ${result.mode} · Chars: ${result.chars} · Status: ${result.status}`,
				"",
				"Preview:",
				preview + (result.content.length > SAVE_PREVIEW_CHARS ? "…" : ""),
			].join("\n");
			setReadStatus(ctx.ui, null);
			return {
				content: [{ type: "text", text: summary }],
				details: {
					url: result.url,
					finalUrl: result.finalUrl,
					mode: result.mode,
					format: result.format,
					status: result.status,
					chars: result.chars,
					title: result.title,
					author: result.author,
					published: result.published,
					site: result.site,
					language: result.language,
					headless,
					savePath: abs,
					return: "full",
				},
			};
		}

		let body: string;
		let returnDetail: ReadReturnMode = returnMode;
		let matched: number | undefined;
		let totalChunks: number | undefined;
		let pageChars: number | undefined;

		if (wantExcerpts) {
			headerLines.push(
				`Return: excerpts` + (query ? ` · query: ${JSON.stringify(query)}` : ""),
			);
			headerLines.push("");
			if (query) {
				const selected = selectExcerpts(result.content, query, {
					maxChars: excerptBudget,
				});
				body = selected.text;
				matched = selected.matched;
				totalChunks = selected.totalChunks;
				pageChars = selected.pageChars;
			} else {
				body = pageOutline(result.content, Math.min(800, excerptBudget));
				pageChars = result.content.length;
			}
			returnDetail = "excerpts";
		} else {
			headerLines.push(`Return: full`, "");
			body = result.content;
		}

		const fullBody = `${headerLines.join("\n")}${body}`;
		setReadStatus(ctx.ui, null);
		return {
			content: [{ type: "text", text: fullBody }],
			details: {
				url: result.url,
				finalUrl: result.finalUrl,
				mode: result.mode,
				format: result.format,
				status: result.status,
				chars: fullBody.length,
				title: result.title,
				author: result.author,
				published: result.published,
				site: result.site,
				language: result.language,
				headless,
				return: returnDetail,
				query: query || undefined,
				matched,
				totalChunks,
				pageChars,
			},
		};
	} catch (err) {
		setReadStatus(ctx.ui, null);
		throw err;
	}
}

const sharedGuidelines = [
	"When the user pastes a URL or asks to check/open/verify a link, forum post, or docs page — call web_read (or web_fetch)",
	"Do NOT invent tools like web_fetch_and_index — use web_read / web_fetch for page content",
	"By default web_read returns ranked excerpts: ALWAYS pass query describing what you need from the page",
	"Use return=full only when the task needs the whole page or you cannot narrow focus",
	"When saving pages to a vault/folder or scraping many URLs, ALWAYS set saveDir or savePath — never load full bodies into chat",
	"saveDir=~/vault/foo writes ~/vault/foo/<title-slug>.md and returns a short summary only",
	"Use mode=browser when the user asks for CloakBrowser; otherwise prefer mode=auto",
	"Prefer format=markdown; avoid format=html unless savePath/saveDir is set",
];

/**
 * Register canonical web_read plus aliases for common model hallucinations
 * (web_fetch, web_fetch_and_index).
 */
export function registerWebRead(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_read",
		label: "Read Web Page",
		description:
			"PRIMARY tool for any URL the user pastes or asks you to open/check/verify " +
			"(forum posts, docs, KB articles, PowerShell snippets on a page, etc.). " +
			"Fetches locally (HTTP → fingerprint → CloakBrowser). " +
			"DEFAULT chat return is query-ranked excerpts — pass query with what you need. " +
			"Use return=full for the complete main-content body, or savePath/saveDir for vault writes (full file, summary only in chat).",
		promptSnippet:
			"Open/fetch/read a URL; pass query for ranked excerpts (default) or return=full",
		promptGuidelines: sharedGuidelines,
		parameters: webReadParameters,
		execute: executeWebRead,
	});

	// Common synonym models reach for instead of web_read
	pi.registerTool({
		name: "web_fetch",
		label: "Fetch Web Page",
		description:
			"Alias of web_read — fetch/open a URL. Default: ranked excerpts (pass query). " +
			"Use return=full for the whole page. Prefer the name web_read if both are available.",
		promptSnippet: "Fetch a URL (alias of web_read)",
		promptGuidelines: sharedGuidelines,
		parameters: webReadParameters,
		execute: executeWebRead,
	});

	// Exact hallucinated name from models blending web_* with ctx_fetch_and_index
	pi.registerTool({
		name: "web_fetch_and_index",
		label: "Fetch Web Page",
		description:
			"Alias of web_read — fetches URL content. Default: ranked excerpts (pass query). " +
			"Does not maintain a separate search index; content is returned (or saved via savePath/saveDir) the same as web_read. " +
			"Prefer calling web_read directly.",
		promptSnippet: "Fetch a URL (alias of web_read; no separate index)",
		promptGuidelines: [
			...sharedGuidelines,
			"This is NOT a separate indexer — it is web_read under another name",
		],
		parameters: webReadParameters,
		execute: executeWebRead,
	});
}

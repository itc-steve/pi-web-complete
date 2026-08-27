/**
 * context7 tool — version-current library/framework documentation from context7.com.
 *
 * Registered only when a Context7 API key resolves (config.context7.apiKeyEnv → web.env).
 * Two endpoints, both GET with `Authorization: Bearer <key>`:
 *   /api/v2/libs/search  — resolve a library name to a Context7 library ID
 *   /api/v2/context      — ranked docs + code snippets for a query
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { config, refreshConfig } from "../config.js";
import { resolveContext7Key } from "../credentials.js";
import { noteServiceUsed, refreshServicesStatus, setServiceProgress } from "../status.js";
import { sanitizeError, timeoutSignal } from "../utils.js";

const API_BASE = "https://context7.com/api/v2";
const CONTEXT7_MAX_CHARS = 12_000;
/** Context7 library IDs look like /org/repo or /org/repo/version. */
const LIBRARY_ID_RE = /^\/[^/]+\/[^/]+([/@][^/]+)?$/;

async function callContext7(
	path: string,
	params: Record<string, string>,
	key: string,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<unknown> {
	const url = `${API_BASE}${path}?${new URLSearchParams(params)}`;
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
		signal: timeoutSignal(signal, timeoutMs),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Context7 ${sanitizeError(response.status, text)}`);
	}
	const body = await response.text();
	try {
		return JSON.parse(body) as unknown;
	} catch {
		return body; // type=txt responses
	}
}

interface LibraryHit {
	id: string;
	title?: string;
	description?: string;
	trustScore?: number;
	totalSnippets?: number;
}

export function truncateContext7(text: string): {
	text: string;
	truncated: boolean;
	chars: number;
} {
	const chars = text.length;
	if (chars <= CONTEXT7_MAX_CHARS) return { text, truncated: false, chars };
	const bodyLimit = CONTEXT7_MAX_CHARS - 80;
	const newline = text.lastIndexOf("\n", bodyLimit);
	const end = newline >= bodyLimit * 0.8 ? newline : bodyLimit;
	return {
		text: `${text.slice(0, end)}\n…[truncated: ${chars - end} chars omitted; narrow query for more]`,
		truncated: true,
		chars,
	};
}

/** Resolve a plain library name ("next.js") to a Context7 library ID ("/vercel/next.js"). */
async function resolveLibraryId(
	libraryName: string,
	query: string,
	key: string,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<LibraryHit> {
	const data = (await callContext7(
		"/libs/search",
		{ libraryName, query },
		key,
		signal,
		timeoutMs,
	)) as { results?: LibraryHit[] };
	const hit = data?.results?.find((r) => typeof r?.id === "string");
	if (!hit) throw new Error(`Context7: no library matched "${libraryName}"`);
	return hit;
}

export function registerContext7(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "context7",
		label: "Context7 Docs",
		description:
			"Fetch up-to-date, version-current documentation and code snippets for a library or " +
			"framework from Context7. Use this BEFORE writing code against any third-party " +
			"library (React, Next.js, Prisma, FastAPI, Tailwind, etc.) instead of relying on " +
			"training-data memory, and when an API may have changed since training cutoff.",
		promptSnippet: "Up-to-date library/framework docs and code snippets (Context7)",
		promptGuidelines: [
			"Call context7 before writing or reviewing code that uses a third-party library or framework — training data goes stale, Context7 does not",
			"Pass library as a plain name ('next.js', 'prisma') or a Context7 ID ('/vercel/next.js'); append a version like '/vercel/next.js/v14.3.0' to pin",
			"Always pass query describing the actual task ('app router middleware auth') — results are ranked against it",
			"Prefer context7 over web_search for API/library usage questions; use web_search for news, comparisons, or libraries Context7 does not cover",
		],
		parameters: Type.Object({
			library: Type.String({
				description:
					"Library name (e.g. 'next.js', 'prisma') or Context7 library ID " +
					"(e.g. '/vercel/next.js', optionally '/vercel/next.js/v14.3.0').",
			}),
			query: Type.String({
				description:
					"The actual coding task or question — used to rank snippets (e.g. 'server actions form validation')",
			}),
			fast: Type.Optional(
				Type.Boolean({
					description:
						"Skip LLM reranking for lower latency (less relevant results). Default: false.",
					default: false,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			refreshConfig(ctx.cwd);
			const key = resolveContext7Key(config);
			if (!key) {
				throw new Error(
					"Context7 not configured. Set context7.apiKeyEnv in ~/.pi/agent/web.json and the key in ~/.pi/agent/web.env",
				);
			}
			const timeoutMs = config.context7?.timeout;
			const fast = String(params.fast ?? config.context7?.fast ?? false);

			const progress = (message: string) => {
				setServiceProgress(ctx.ui, message);
				onUpdate?.({ content: [{ type: "text", text: `*${message}*` }] });
			};

			try {
				let libraryId = params.library.trim();
				let hit: LibraryHit | undefined;
				if (!LIBRARY_ID_RE.test(libraryId)) {
					progress(`context7: resolving...`);
					hit = await resolveLibraryId(libraryId, params.query, key, signal, timeoutMs);
					libraryId = hit.id;
				}

				progress(`context7: fetching...`);
				const body = await callContext7(
					"/context",
					{ libraryId, query: params.query, type: "txt", fast },
					key,
					signal,
					timeoutMs,
				);
				const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);

				// Session footer: just "context7" next to any search backends used.
				noteServiceUsed(ctx.ui, "context7");
				const header = hit
					? `Context7: ${hit.title || libraryId} (${libraryId})\n\n`
					: `Context7: ${libraryId}\n\n`;
				const output = truncateContext7(header + (text.trim() || "No documentation found."));
				return {
					content: [{ type: "text", text: output.text }],
					details: {
						libraryId,
						query: params.query,
						chars: output.chars,
						truncated: output.truncated,
					},
				};
			} catch (err) {
				refreshServicesStatus(ctx.ui);
				throw err;
			}
		},
	});
}

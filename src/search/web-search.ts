/** web_search tool registration. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import type { BackendName } from "../types.js";
import { config, refreshConfig, getActiveBackends } from "../config.js";
import { noteSearchBackendUsed, refreshSearchStatus, setSearchProgress } from "../status.js";
import { BACKEND_DEFS, runBackend } from "./backends/registry.js";
import { formatResults, formatResultsCompact } from "./formatters.js";

function shuffle<T>(items: T[]): T[] {
	const order = [...items];
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[order[i], order[j]] = [order[j], order[i]];
	}
	return order;
}

function isAbortError(err: unknown): boolean {
	return (
		(err instanceof Error && err.name === "AbortError") ||
		(typeof DOMException !== "undefined" &&
			err instanceof DOMException &&
			err.name === "AbortError")
	);
}

export function registerWebSearch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using brave, serper, tavily, exa, and/or linkup. " +
			"Auto mode picks a random enabled backend (with shuffled fallback on failure). " +
			"Use for fact-finding, research, documentation lookups, and current events.",
		promptSnippet: "Search the web (brave / serper / tavily / exa / linkup)",
		promptGuidelines: [
			"Use web_search when you need up-to-date information, facts, or documentation from the web",
			"Auto mode picks a random enabled backend; on failure it tries the others in random order",
			"Configure backends in ~/.pi/agent/web.json; secrets in ~/.pi/agent/web.env via apiKeyEnv",
			"Prefer compact=true while exploring and keep numResults modest to avoid flooding context",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query (natural language works best)",
			}),
			numResults: Type.Optional(
				Type.Number({
					description: "Number of results (1-20, default from config or 10)",
					default: 10,
				}),
			),
			backend: Type.Optional(
				StringEnum(["brave", "serper", "tavily", "exa", "linkup", "auto"] as const, {
					description:
						"Backend to use. 'auto' picks a random configured backend (default)",
				}),
			),
			compact: Type.Optional(
				Type.Boolean({
					description:
						"When true, returns compact single-line results (title + URL). Default: false.",
					default: false,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			refreshConfig(ctx.cwd);

			const defaultNum = config.numResults ?? 10;
			const numResults = Math.max(1, Math.min(params.numResults ?? defaultNum, 20));
			const requestedBackend = params.backend || config.defaultBackend || "auto";
			const compact = Boolean(params.compact ?? config.compact);

			const setProgress = (status: string) => {
				setSearchProgress(ctx.ui, status);
				onUpdate?.({ content: [{ type: "text", text: `*${status}*` }] });
			};

			const finish = (text: string, details: Record<string, unknown>) => ({
				content: [{ type: "text", text }],
				details,
			});

			if (requestedBackend !== "auto") {
				const pinned = requestedBackend as BackendName;
				const backendLabel = BACKEND_DEFS[pinned]?.label || pinned;
				setProgress(`🔍 ${backendLabel}: searching...`);
				try {
					const results = await runBackend(pinned, params.query, numResults, signal);
					if (results.length > 0) {
						noteSearchBackendUsed(ctx.ui, pinned);
					} else {
						refreshSearchStatus(ctx.ui);
					}
					const text = compact
						? formatResultsCompact(results)
						: formatResults(params.query, pinned, results);
					return finish(text, { backend: pinned, resultCount: results.length });
				} catch (err) {
					setProgress(`❌ ${backendLabel}: failed`);
					refreshSearchStatus(ctx.ui);
					throw err;
				}
			}

			const activeBackends = getActiveBackends();
			if (activeBackends.length === 0) {
				throw new Error(
					"No search backends enabled with a resolvable key. Set apiKeyEnv in ~/.pi/agent/web.json and the value in ~/.pi/agent/web.env",
				);
			}

			const orderedBackends = shuffle(activeBackends) as BackendName[];
			const errors: string[] = [];
			const primary = orderedBackends[0];
			for (const backend of orderedBackends) {
				if (signal?.aborted) {
					throw signal.reason instanceof Error
						? signal.reason
						: new DOMException("Aborted", "AbortError");
				}
				const backendLabel = BACKEND_DEFS[backend].label;
				const hint = backend === primary ? " (auto)" : " (auto fallback)";
				setProgress(`🔍 ${backendLabel}${hint}: searching...`);
				try {
					const results = await runBackend(backend, params.query, numResults, signal);
					if (results.length === 0) {
						errors.push(`${backend}: 0 results`);
						setProgress(`🔍 ${backendLabel}: empty, trying next...`);
						continue;
					}
					noteSearchBackendUsed(ctx.ui, backend);
					const usedFallback = errors.length > 0;
					const modeTag = usedFallback
						? `${backend} (auto fallback)`
						: `${backend} (auto)`;
					const body = compact
						? formatResultsCompact(results)
						: formatResults(params.query, backend, results);
					const text =
						errors.length > 0 ? `${errors.join("; ")}\n\n${body}` : body;
					return finish(text, {
						backend: modeTag,
						resultCount: results.length,
						errors: errors.length > 0 ? errors : undefined,
					});
				} catch (err) {
					if (signal?.aborted || isAbortError(err)) throw err;
					errors.push(`${backend}: ${(err as Error).message}`);
					setProgress(`❌ ${backendLabel}: failed, trying next...`);
				}
			}

			setProgress(`❌ all backends failed`);
			refreshSearchStatus(ctx.ui);
			throw new Error(`All backends failed: ${errors.join("; ")}`);
		},
	});
}

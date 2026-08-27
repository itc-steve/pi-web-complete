/** web_cowork — shared-control CloakBrowser session for agent + user. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { config, refreshConfig } from "../config.js";
import { resolveHerdrConfig } from "./herdr/config.js";
import { pageOutline, selectExcerpts } from "../read/excerpts.js";
import { htmlToMarkdown, htmlToText } from "../read/markdown.js";
import { extractReadable, readableIsBetter } from "../read/readable.js";
import { setCoworkStatus } from "../status.js";
import {
	ACTION_TIMEOUT_MS,
	buildInteractiveSnapshot,
	clearCoworkRefs,
	prepareAndAct,
	runFillBatch,
} from "./refs.js";
import {
	closeCoworkSession,
	ensureCoworkSession,
	getCoworkStatus,
	isCoworkSessionOpen,
	navigateCoworkPage,
	requireCoworkSession,
} from "./session.js";

const DEFAULT_SNAPSHOT_MAX_CHARS = 6_000;
const POST_ACTION_MAX_CHARS = 4_000;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const MAX_WAIT_NOTE_CHARS = 1_000;

const coworkParameters = Type.Object({
	action: StringEnum(
		[
			"open",
			"navigate",
			"snapshot",
			"wait",
			"click",
			"type",
			"press",
			"scroll",
			"batch",
			"status",
			"close",
		] as const,
		{
			description:
				"Cowork action. open and state-changing actions return fresh interactive refs. " +
				"Use snapshot for content or a manual observation; batch fills 1–10 fields then optionally clicks once.",
		},
	),
	url: Type.Optional(
		Type.String({
			description: "URL for open/navigate (required for those actions).",
		}),
	),
	mode: Type.Optional(
		StringEnum(["interactive", "content", "both"] as const, {
			description:
				"snapshot mode. interactive (default): clickable refs @e1… for actions. " +
				"content: markdown/excerpts for reading (use with query). " +
				"both: refs plus content.",
		}),
	),
	ref: Type.Optional(
		Type.String({
			description:
				'Element ref from the latest result, e.g. "@e3" or "e3". Preferred for click/type/press/scroll.',
		}),
	),
	role: Type.Optional(
		Type.String({
			description:
				'ARIA role fallback when ref is unavailable, e.g. "button", "link", "textbox". Use with name.',
		}),
	),
	name: Type.Optional(
		Type.String({
			description:
				"Accessible name / label for role targeting, or button name. Prefer ref when available.",
		}),
	),
	selector: Type.Optional(
		Type.String({
			description:
				"CSS selector last resort (or @eN if models put the ref here). Prefer ref.",
		}),
	),
	text: Type.Optional(
		Type.String({
			description:
				"For type: text to enter. For click: optional visible text to click when no ref/role.",
		}),
	),
	clear: Type.Optional(
		Type.Boolean({
			description: "Clear the field before typing (action=type). Default true.",
			default: true,
		}),
	),
	fills: Type.Optional(
		Type.Array(
			Type.Object({
				ref: Type.String({ description: "Field ref from one snapshot." }),
				text: Type.String({ description: "Value to enter." }),
				clear: Type.Optional(Type.Boolean({ default: true })),
			}),
			{
				description: "For action=batch: 1–10 fields from one snapshot, filled in order.",
				minItems: 1,
				maxItems: 10,
			},
		),
	),
	clickRef: Type.Optional(
		Type.String({
			description: "For action=batch: optional final click ref from the same snapshot.",
		}),
	),
	key: Type.Optional(
		Type.String({
			description: "Key to press (action=press), e.g. Enter, Tab, Escape.",
		}),
	),
	deltaY: Type.Optional(
		Type.Number({
			description: "Vertical scroll delta in pixels (action=scroll without target). Default 600.",
		}),
	),
	query: Type.Optional(
		Type.String({
			description:
				"Focus keywords for content snapshot excerpts. Implies content when mode omitted.",
		}),
	),
	maxChars: Type.Optional(
		Type.Number({
			description: `Snapshot char budget. Default ${DEFAULT_SNAPSHOT_MAX_CHARS}.`,
		}),
	),
	message: Type.Optional(
		Type.String({
			description:
				"Message shown while waiting for the user (action=wait). User may press Enter, add a note, or cancel. " +
				'Default: "Finish in the browser, then continue."',
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: `Wait timeout in ms when no UI input is available. Default ${DEFAULT_WAIT_TIMEOUT_MS}.`,
		}),
	),
});

type CoworkParams = {
	action:
		| "open"
		| "navigate"
		| "snapshot"
		| "wait"
		| "click"
		| "type"
		| "press"
		| "scroll"
		| "batch"
		| "status"
		| "close";
	url?: string;
	mode?: "interactive" | "content" | "both";
	ref?: string;
	role?: string;
	name?: string;
	selector?: string;
	text?: string;
	clear?: boolean;
	fills?: Array<{ ref: string; text: string; clear?: boolean }>;
	clickRef?: string;
	key?: string;
	deltaY?: number;
	query?: string;
	maxChars?: number;
	message?: string;
	timeoutMs?: number;
};

function textResult(text: string, details?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function coworkUserDataDir(): string | undefined {
	return config.cowork?.userDataDir;
}

function coworkDownloadDir(): string | undefined {
	return config.cowork?.downloadDir;
}

function herdrConfig() {
	return resolveHerdrConfig(config.cowork?.herdr);
}

function progress(
	ctx: ExtensionContext,
	onUpdate: (update: { content: Array<{ type: string; text: string }> }) => void,
	msg: string,
	open = true,
): void {
	onUpdate({ content: [{ type: "text", text: msg }] });
	setCoworkStatus(ctx.ui, open, open ? msg : undefined);
}

function resolveSnapshotMode(
	params: CoworkParams,
): "interactive" | "content" | "both" {
	if (params.mode) return params.mode;
	if (params.query?.trim()) return "content";
	return "interactive";
}

async function contentSnapshot(
	page: Awaited<ReturnType<typeof requireCoworkSession>>["page"],
	query?: string,
	maxChars = DEFAULT_SNAPSHOT_MAX_CHARS,
): Promise<{ body: string; matched?: number; totalChunks?: number }> {
	const html = await page.content();

	const readable = extractReadable(html);
	let markdown: string;
	if (readable.ok && readable.contentHtml) {
		const candidate = htmlToMarkdown(readable.contentHtml, { removeImages: true });
		const baseline = htmlToMarkdown(html, { removeImages: true });
		markdown =
			readableIsBetter(candidate, baseline) || readableIsBetter(readable.textContent, baseline)
				? candidate
				: baseline;
	} else {
		markdown = htmlToMarkdown(html, { removeImages: true });
		if (markdown.length < 200) {
			markdown = htmlToText(html) || markdown;
		}
	}

	if (query?.trim()) {
		const selected = selectExcerpts(markdown, query.trim(), { maxChars });
		return {
			body: selected.text,
			matched: selected.matched,
			totalChunks: selected.totalChunks,
		};
	}

	return {
		body: pageOutline(markdown, Math.min(800, maxChars)),
	};
}

async function postActionSnapshot(
	page: Awaited<ReturnType<typeof requireCoworkSession>>["page"],
) {
	clearCoworkRefs();
	try {
		return await buildInteractiveSnapshot(page, { maxChars: POST_ACTION_MAX_CHARS });
	} catch {
		return { refs: [], text: "(Interactive observation unavailable; call snapshot.)" };
	}
}

function targetFromParams(
	params: CoworkParams,
	opts: { textIsClickTarget?: boolean } = {},
) {
	return {
		ref: params.ref,
		role: params.role,
		name: params.name,
		selector: params.selector,
		text: opts.textIsClickTarget ? params.text : undefined,
	};
}

function hasTarget(params: CoworkParams, opts: { textIsClickTarget?: boolean } = {}): boolean {
	return Boolean(
		params.ref?.trim() ||
			params.role?.trim() ||
			params.name?.trim() ||
			params.selector?.trim() ||
			(opts.textIsClickTarget && params.text?.trim()),
	);
}

async function executeCowork(
	_toolCallId: string,
	params: CoworkParams,
	signal: AbortSignal,
	onUpdate: (update: { content: Array<{ type: string; text: string }> }) => void,
	ctx: ExtensionContext,
) {
	refreshConfig(ctx.cwd);

	if (signal.aborted) {
		throw new DOMException("Aborted", "AbortError");
	}

	switch (params.action) {
		case "open": {
			if (!params.url?.trim()) throw new Error("action=open requires url");
			progress(ctx, onUpdate, "🌐 cowork: opening…");
			const notes: string[] = [];
			const { page, herdr } = await ensureCoworkSession({
				userDataDir: coworkUserDataDir(),
				downloadDir: coworkDownloadDir(),
				herdr: herdrConfig(),
				initialUrl: params.url.trim(),
				onNote: (note) => {
					notes.push(note);
					onUpdate({ content: [{ type: "text", text: note }] });
				},
			});
			const nav = await navigateCoworkPage(page, params.url.trim(), undefined, signal);
			const observation = await postActionSnapshot(page);
			progress(ctx, onUpdate, `🌐 cowork: ${nav.title || nav.url}`);
			return textResult(
				[
					herdr
						? `Opened CloakBrowser in Herdr pane ${herdr.paneId} (the user can click and type in it directly).`
						: `Opened visible CloakBrowser window.`,
					`Title: ${nav.title || "(none)"}`,
					`URL: ${nav.url}`,
					`HTTP: ${nav.status}`,
					...(notes.length ? [``, ...notes] : []),
					``,
					observation.text,
				].join("\n"),
				{
					action: "open",
					...nav,
					open: true,
					herdrPaneId: herdr?.paneId,
					refCount: observation.refs.length,
				},
			);
		}

		case "navigate": {
			if (!params.url?.trim()) throw new Error("action=navigate requires url");
			progress(ctx, onUpdate, "🌐 cowork: navigating…");
			const { page } = await requireCoworkSession();
			const nav = await navigateCoworkPage(page, params.url.trim(), undefined, signal);
			const observation = await postActionSnapshot(page);
			progress(ctx, onUpdate, `🌐 cowork: ${nav.title || nav.url}`);
			return textResult(
				[
					`Navigated.`,
					`Title: ${nav.title || "(none)"}`,
					`URL: ${nav.url}`,
					`HTTP: ${nav.status}`,
					``,
					observation.text,
				].join("\n"),
				{ action: "navigate", ...nav, open: true, refCount: observation.refs.length },
			);
		}

		case "snapshot": {
			progress(ctx, onUpdate, "🌐 cowork: snapshot…");
			const { page } = await requireCoworkSession();
			const mode = resolveSnapshotMode(params);
			const maxChars = params.maxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS;
			const title = await page.title().catch(() => "");
			const url = page.url();
			const parts = [
				`web_cowork snapshot (${mode})`,
				`Title: ${title || "(none)"}`,
				`URL: ${url}`,
				"",
			];

			let matched: number | undefined;
			let totalChunks: number | undefined;
			let refCount = 0;

			if (mode === "interactive" || mode === "both") {
				const interactive = await buildInteractiveSnapshot(page, {
					maxChars: mode === "both" ? Math.floor(maxChars * 0.55) : maxChars,
				});
				refCount = interactive.refs.length;
				parts.push(interactive.text);
			}

			if (mode === "content" || mode === "both") {
				if (mode === "both") parts.push("", "--- content ---", "");
				if (params.query?.trim()) {
					parts.push(`Query: ${params.query.trim()}`, "");
				}
				const content = await contentSnapshot(
					page,
					params.query,
					mode === "both" ? Math.floor(maxChars * 0.45) : maxChars,
				);
				parts.push(content.body);
				matched = content.matched;
				totalChunks = content.totalChunks;
			}

			progress(ctx, onUpdate, `🌐 cowork: ${title || url}`);
			return textResult(parts.join("\n"), {
				action: "snapshot",
				mode,
				url,
				refCount,
				matched,
				totalChunks,
				open: true,
			});
		}

		case "wait": {
			const message =
				params.message?.trim() || "Finish in the browser, then press Enter / continue.";
			const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
			progress(ctx, onUpdate, "🌐 cowork: waiting for user…");
			clearCoworkRefs();

			let note: string | undefined;
			let cancelled = false;
			let timedOut = false;
			if (ctx.hasUI) {
				ctx.ui.notify(message, "info");
				const reply = await ctx.ui.input(
					message,
					"Enter when done, optional note; Esc cancels",
					{ signal },
				);
				if (signal.aborted) {
					throw signal.reason instanceof Error
						? signal.reason
						: new DOMException("Aborted", "AbortError");
				}
				cancelled = reply === undefined;
				const trimmed = reply?.trim();
				if (trimmed) {
					note =
						trimmed.length > MAX_WAIT_NOTE_CHARS
							? `${trimmed.slice(0, MAX_WAIT_NOTE_CHARS)}…`
							: trimmed;
				}
			} else {
				onUpdate({
					content: [
						{
							type: "text",
							text: `Waiting ${Math.round(timeoutMs / 1000)}s for user: ${message}`,
						},
					],
				});
				await new Promise<void>((resolve, reject) => {
					const onAbort = () => {
						clearTimeout(timer);
						reject(
							signal.reason instanceof Error
								? signal.reason
								: new DOMException("Aborted", "AbortError"),
						);
					};
					const timer = setTimeout(() => {
						signal.removeEventListener("abort", onAbort);
						resolve();
					}, timeoutMs);
					if (signal.aborted) {
						onAbort();
						return;
					}
					signal.addEventListener("abort", onAbort, { once: true });
				});
				timedOut = true;
			}

			const status = await getCoworkStatus();
			const observation = status.open
				? await postActionSnapshot((await requireCoworkSession()).page)
				: { refs: [], text: "" };
			if (status.open) {
				progress(ctx, onUpdate, `🌐 cowork: ${status.title || status.url || "ready"}`);
			} else {
				setCoworkStatus(ctx.ui, false);
			}
			return textResult(
				[
					cancelled ? `Wait cancelled by user.` : timedOut ? `Wait timed out.` : `Wait finished.`,
					...(note ? [`User note: ${note}`] : []),
					status.open
						? `Session still open at: ${status.url ?? "(unknown)"}\nTitle: ${status.title || "(none)"}`
						: `Session is no longer open.`,
					...(observation.text ? [``, observation.text] : []),
				].join("\n"),
				{
					action: "wait",
					...status,
					cancelled,
					timedOut,
					note,
					refCount: observation.refs.length,
				},
			);
		}

		case "click": {
			if (!hasTarget(params, { textIsClickTarget: true })) {
				throw new Error(
					'action=click requires ref (preferred, e.g. "@e3"), or role+name, or text, or selector. Call snapshot first.',
				);
			}
			const { page } = await requireCoworkSession();
			const label = params.ref || params.name || params.selector || params.text || "";
			progress(ctx, onUpdate, `🌐 cowork: click ${label}`);
			const how = await prepareAndAct(
				page,
				targetFromParams(params, { textIsClickTarget: true }),
				async (loc) => {
					await loc.click({ timeout: ACTION_TIMEOUT_MS });
				},
				{ signal },
			);
			const observation = await postActionSnapshot(page);
			progress(ctx, onUpdate, `🌐 cowork: ${await page.title().catch(() => page.url())}`);
			return textResult(
				[`Clicked via ${how}`, `URL: ${page.url()}`, ``, observation.text].join("\n"),
				{
					action: "click",
					how,
					url: page.url(),
					open: true,
					refCount: observation.refs.length,
				},
			);
		}

		case "type": {
			if (!hasTarget(params)) {
				throw new Error(
					'action=type requires ref (preferred), or role+name, or selector for the field. Call snapshot first.',
				);
			}
			if (params.text == null) throw new Error("action=type requires text (value to enter)");
			const { page } = await requireCoworkSession();
			const label = params.ref || params.name || params.selector || "";
			progress(ctx, onUpdate, `🌐 cowork: type ${label}`);
			const clear = params.clear !== false;
			const how = await prepareAndAct(
				page,
				targetFromParams(params),
				async (loc) => {
					if (clear) {
						await loc.fill(params.text!, { timeout: ACTION_TIMEOUT_MS });
					} else {
						await loc.pressSequentially(params.text!, {
							delay: 20,
							timeout: ACTION_TIMEOUT_MS,
						});
					}
				},
				{ signal },
			);
			// Typing usually doesn't navigate; keep refs but they may still be ok.
			progress(ctx, onUpdate, `🌐 cowork: ${await page.title().catch(() => page.url())}`);
			return textResult(`Typed into ${how} (${params.text.length} chars, clear=${clear})`, {
				action: "type",
				how,
				chars: params.text.length,
				cleared: clear,
				url: page.url(),
				open: true,
			});
		}

		case "batch": {
			const fills = params.fills ?? [];
			if (fills.length === 0 || fills.length > 10) {
				throw new Error("action=batch requires 1–10 fills from one snapshot");
			}
			const { page } = await requireCoworkSession();
			progress(ctx, onUpdate, `🌐 cowork: fill ${fills.length} field(s)…`);
			let result: Awaited<ReturnType<typeof runFillBatch>>;
			try {
				result = await runFillBatch(
					page,
					fills,
					params.clickRef?.trim() || undefined,
					signal,
				);
			} catch (err) {
				if (signal.aborted) throw err;
				const observation = await postActionSnapshot(page);
				throw new Error(
					`${err instanceof Error ? err.message : String(err)}\n\n${observation.text}`,
				);
			}
			const observation = await postActionSnapshot(page);
			progress(ctx, onUpdate, `🌐 cowork: ${await page.title().catch(() => page.url())}`);
			return textResult(
				[
					`Filled ${result.filled} field(s)${result.clicked ? " and clicked final ref" : ""}.`,
					`URL: ${page.url()}`,
					``,
					observation.text,
				].join("\n"),
				{
					action: "batch",
					...result,
					url: page.url(),
					open: true,
					refCount: observation.refs.length,
				},
			);
		}

		case "press": {
			if (!params.key?.trim()) throw new Error("action=press requires key");
			const { page } = await requireCoworkSession();
			const key = params.key.trim();
			progress(ctx, onUpdate, `🌐 cowork: press ${key}`);
			if (hasTarget(params)) {
				const how = await prepareAndAct(
					page,
					targetFromParams(params),
					async (loc) => {
						await loc.press(key, { timeout: ACTION_TIMEOUT_MS });
					},
					{ signal },
				);
				const observation = await postActionSnapshot(page);
				progress(ctx, onUpdate, `🌐 cowork: ${await page.title().catch(() => page.url())}`);
				return textResult(
					[`Pressed ${key} on ${how}`, ``, observation.text].join("\n"),
					{
						action: "press",
						key,
						how,
						url: page.url(),
						open: true,
						refCount: observation.refs.length,
					},
				);
			}
			await page.keyboard.press(key);
			const observation = await postActionSnapshot(page);
			progress(ctx, onUpdate, `🌐 cowork: ${await page.title().catch(() => page.url())}`);
			return textResult([`Pressed ${key}`, ``, observation.text].join("\n"), {
				action: "press",
				key,
				url: page.url(),
				open: true,
				refCount: observation.refs.length,
			});
		}

		case "scroll": {
			const { page } = await requireCoworkSession();
			const deltaY = params.deltaY ?? 600;
			progress(ctx, onUpdate, "🌐 cowork: scroll");
			if (hasTarget(params, { textIsClickTarget: true })) {
				const how = await prepareAndAct(
					page,
					targetFromParams(params, { textIsClickTarget: true }),
					async (loc) => {
						await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
					},
					{ signal },
				);
				const observation = await postActionSnapshot(page);
				progress(ctx, onUpdate, `🌐 cowork: ${await page.title().catch(() => page.url())}`);
				return textResult(
					[`Scrolled into view: ${how}.`, ``, observation.text].join("\n"),
					{
						action: "scroll",
						how,
						url: page.url(),
						open: true,
						refCount: observation.refs.length,
					},
				);
			}
			await page.mouse.wheel(0, deltaY);
			const observation = await postActionSnapshot(page);
			progress(ctx, onUpdate, `🌐 cowork: ${await page.title().catch(() => page.url())}`);
			return textResult(
				[`Scrolled by deltaY=${deltaY}.`, ``, observation.text].join("\n"),
				{
					action: "scroll",
					deltaY,
					url: page.url(),
					open: true,
					refCount: observation.refs.length,
				},
			);
		}

		case "status": {
			const status = await getCoworkStatus();
			if (!status.open) {
				setCoworkStatus(ctx.ui, false);
				return textResult("web_cowork session: closed", { action: "status", open: false });
			}
			progress(ctx, onUpdate, `🌐 cowork: ${status.title || status.url}`);
			return textResult(
				[
					`web_cowork session: open`,
					`Title: ${status.title || "(none)"}`,
					`URL: ${status.url}`,
					`Profile: ${status.userDataDir}`,
					...(status.herdrPaneId ? [`Herdr pane: ${status.herdrPaneId}`] : []),
					...(status.herdrFallbackReason
						? [`Herdr pane unavailable: ${status.herdrFallbackReason}`]
						: []),
				].join("\n"),
				{ action: "status", ...status },
			);
		}

		case "close": {
			progress(ctx, onUpdate, "🌐 cowork: closing…");
			await closeCoworkSession();
			setCoworkStatus(ctx.ui, false);
			return textResult("web_cowork session closed.", { action: "close", open: false });
		}

		default: {
			const _exhaustive: never = params.action;
			throw new Error(`Unknown action: ${_exhaustive}`);
		}
	}
}

const coworkGuidelines = [
	"Use web_cowork when the user must see/interact with a page (login, CAPTCHA, multi-step UI) or asks to co-drive a browser",
	"Prefer web_read for one-shot page extraction without user interaction",
	"Use refs from the latest web_cowork result for click/type/batch; do not invent refs or CSS selectors",
	"open, navigate, wait, click, press, scroll, and batch return fresh refs; call snapshot only when you need content or a fresh manual observation",
	"Use web_cowork batch for multiple field fills from one snapshot, with at most one final click",
	"Use snapshot mode=content (or query=…) only when reading page text; use interactive (default) when acting",
	"Fallback if ref missing: role+name (e.g. role=button name=Submit). CSS selector is last resort",
];

export function registerWebCowork(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_cowork",
		label: "Web Cowork",
		executionMode: "sequential",
		description:
			"Open a visible CloakBrowser window for shared control with the user. " +
			"Actions return fresh interactive refs (@e1…); click/type/batch with refs from the latest result. " +
			"Actions: open, navigate, wait, snapshot, click, type, press, scroll, batch, status, close. " +
			"Prefer web_read for one-shot extraction.",
		promptSnippet:
			"Visible CloakBrowser cowork — act with refs returned by each browser step",
		promptGuidelines: coworkGuidelines,
		parameters: coworkParameters,
		execute: executeCowork,
	});
}

/** For status line updates from the extension entrypoint. */
export { isCoworkSessionOpen, getCoworkStatus };

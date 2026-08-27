/** Interactive element refs for web_cowork (snapshot → click by @eN). */

import type { Locator, Page } from "playwright-core";

const REF_ATTR = "data-cowork-ref";
const ACTION_TIMEOUT_MS = 15_000;
const MAX_INTERACTIVE = 120;

export interface InteractiveRef {
	ref: string;
	role: string;
	name: string;
	tag: string;
	href?: string;
	inputType?: string;
	placeholder?: string;
	value?: string;
	disabled?: boolean;
	checked?: boolean;
	inViewport?: boolean;
}

export interface ResolveTarget {
	ref?: string;
	role?: string;
	name?: string;
	text?: string;
	selector?: string;
}

let lastRefs: InteractiveRef[] = [];
let lastPageUrl = "";
let nextCoworkRef = 1;

export function clearCoworkRefs(): void {
	lastRefs = [];
	lastPageUrl = "";
}

export function resetCoworkRefs(): void {
	clearCoworkRefs();
	nextCoworkRef = 1;
}

export function getLastCoworkRefs(): InteractiveRef[] {
	return lastRefs;
}

function normalizeRef(raw: string): string {
	const s = raw.trim();
	if (s.startsWith("@")) return s.slice(1);
	if (s.startsWith("ref=")) return s.slice(4);
	return s;
}

function isRefToken(raw: string): boolean {
	return /^@?e\d+$/i.test(raw.trim()) || /^ref=e\d+$/i.test(raw.trim());
}

export function formatInteractiveSnapshot(refs: InteractiveRef[], maxChars = 6_000): string {
	const lines = [
		"Interactive elements (use ref like @e3 for click/type/batch — do NOT invent CSS):",
		"",
	];
	for (const r of [...refs].sort((a, b) => Number(b.inViewport !== false) - Number(a.inViewport !== false))) {
		const bits: string[] = [`@${r.ref}`, r.role || r.tag];
		if (r.name) bits.push(JSON.stringify(r.name));
		const extras: string[] = [];
		if (r.inputType) extras.push(`type=${r.inputType}`);
		if (r.placeholder) extras.push(`placeholder=${JSON.stringify(r.placeholder)}`);
		if (r.href) extras.push(`href=${r.href}`);
		if (r.value) extras.push(`value=${JSON.stringify(r.value.slice(0, 40))}`);
		if (r.disabled) extras.push("disabled");
		if (r.checked != null) extras.push(r.checked ? "checked" : "unchecked");
		if (r.inViewport === false) extras.push("offscreen");
		const line =
			bits.join(" ") + (extras.length ? ` (${extras.join(", ")})` : "");
		lines.push(line);
	}
	if (refs.length === 0) {
		lines.push("(none found — try scroll, wait, or snapshot mode=content)");
	} else {
		lines.push("");
		lines.push(`Refs are valid until the page changes; actions return fresh refs.`);
	}
	let out = lines.join("\n");
	if (out.length > maxChars) {
		out = out.slice(0, maxChars - 20) + "\n…[truncated]";
	}
	return out;
}

type DomCollectResult = {
	items: Array<{
		ref: string;
		role: string;
		name: string;
		tag: string;
		href?: string;
		inputType?: string;
		placeholder?: string;
		value?: string;
		disabled?: boolean;
		checked?: boolean;
		inViewport?: boolean;
	}>;
};

/** Stamp [data-cowork-ref] on interactive nodes and return the catalog. */
export async function buildInteractiveSnapshot(
	page: Page,
	options: { maxChars?: number } = {},
): Promise<{ refs: InteractiveRef[]; text: string }> {
	const collected = (await page.evaluate(
		({ attr, max, start }) => {
			document.querySelectorAll(`[${attr}]`).forEach((el) => {
				el.removeAttribute(attr);
			});

			const selector = [
				"a[href]",
				"button",
				"input:not([type='hidden'])",
				"select",
				"textarea",
				"summary",
				'[role="button"]',
				'[role="link"]',
				'[role="textbox"]',
				'[role="searchbox"]',
				'[role="checkbox"]',
				'[role="radio"]',
				'[role="tab"]',
				'[role="menuitem"]',
				'[role="option"]',
				'[role="switch"]',
				'[role="combobox"]',
				'[contenteditable="true"]',
			].join(",");

			const isVisible = (el: Element): boolean => {
				const html = el as HTMLElement;
				const style = window.getComputedStyle(html);
				if (
					style.display === "none" ||
					style.visibility === "hidden" ||
					style.opacity === "0" ||
					html.getAttribute("aria-hidden") === "true"
				) {
					return false;
				}
				const rect = html.getBoundingClientRect();
				if (rect.width < 1 && rect.height < 1) return false;
				return true;
			};

			const inferRole = (el: Element): string => {
				const explicit = el.getAttribute("role");
				if (explicit) return explicit;
				const tag = el.tagName.toLowerCase();
				if (tag === "a") return "link";
				if (tag === "button") return "button";
				if (tag === "select") return "combobox";
				if (tag === "textarea") return "textbox";
				if (tag === "summary") return "button";
				if (tag === "input") {
					const t = ((el as HTMLInputElement).type || "text").toLowerCase();
					if (t === "checkbox") return "checkbox";
					if (t === "radio") return "radio";
					if (t === "submit" || t === "button" || t === "reset" || t === "image") {
						return "button";
					}
					if (t === "search") return "searchbox";
					return "textbox";
				}
				if ((el as HTMLElement).isContentEditable) return "textbox";
				return tag;
			};

			const accessibleName = (el: Element): string => {
				const aria = el.getAttribute("aria-label");
				if (aria?.trim()) return aria.trim();
				const labelledBy = el.getAttribute("aria-labelledby");
				if (labelledBy) {
					const parts = labelledBy
						.split(/\s+/)
						.map((id) => document.getElementById(id)?.textContent?.trim() || "")
						.filter(Boolean);
					if (parts.length) return parts.join(" ");
				}
				if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
					const id = el.id;
					if (id) {
						const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
						if (label?.textContent?.trim()) return label.textContent.trim();
					}
					const wrapping = el.closest("label");
					if (wrapping?.textContent?.trim()) {
						return wrapping.textContent.trim().replace(/\s+/g, " ").slice(0, 120);
					}
					if (el.placeholder?.trim()) return el.placeholder.trim();
					if (el.getAttribute("name")?.trim()) return el.getAttribute("name")!.trim();
				}
				if (el instanceof HTMLInputElement) {
					const t = (el.type || "").toLowerCase();
					if ((t === "submit" || t === "button") && el.value?.trim()) {
						return el.value.trim();
					}
				}
				const title = el.getAttribute("title");
				if (title?.trim()) return title.trim();
				const text = (el.textContent || "").replace(/\s+/g, " ").trim();
				return text.slice(0, 120);
			};

			const vh = window.innerHeight || 800;
			const vw = window.innerWidth || 1200;
			const nodes = Array.from(document.querySelectorAll(selector))
				.filter(isVisible)
				.map((el) => {
					const rect = (el as HTMLElement).getBoundingClientRect();
					return {
						el,
						inViewport:
							rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw,
					};
				})
				.sort((a, b) => Number(b.inViewport) - Number(a.inViewport));
			const items: DomCollectResult["items"] = [];
			let n = 0;
			for (const { el, inViewport } of nodes) {
				if (n >= max) break;
				const ref = `e${start + n}`;
				n += 1;
				el.setAttribute(attr, ref);
				const tag = el.tagName.toLowerCase();
				const item: DomCollectResult["items"][number] = {
					ref,
					role: inferRole(el),
					name: accessibleName(el),
					tag,
					inViewport,
				};
				if (el instanceof HTMLAnchorElement && el.href) {
					item.href = el.href;
				}
				if (el instanceof HTMLInputElement) {
					item.inputType = el.type || "text";
					if (el.placeholder) item.placeholder = el.placeholder;
					const sensitive =
						(el.type || "").toLowerCase() === "password" ||
						/pass|secret|token|api[_-]?key|credential/i.test(
							`${el.name || ""} ${el.id || ""} ${el.autocomplete || ""} ${item.name}`,
						);
					if (el.value && !sensitive) item.value = el.value.slice(0, 80);
					else if (el.value && sensitive) item.value = "[redacted]";
					item.disabled = el.disabled;
					if (el.type === "checkbox" || el.type === "radio") item.checked = el.checked;
				}
				if (el instanceof HTMLButtonElement) item.disabled = el.disabled;
				if (el instanceof HTMLSelectElement) item.disabled = el.disabled;
				if (el instanceof HTMLTextAreaElement) {
					item.placeholder = el.placeholder || undefined;
					const sensitive = /pass|secret|token|api[_-]?key|credential/i.test(
						`${el.name || ""} ${el.id || ""} ${item.name}`,
					);
					if (el.value && !sensitive) item.value = el.value.slice(0, 80);
					else if (el.value && sensitive) item.value = "[redacted]";
					item.disabled = el.disabled;
				}
				items.push(item);
			}
			return { items };
		},
		{ attr: REF_ATTR, max: MAX_INTERACTIVE, start: nextCoworkRef },
	)) as DomCollectResult;

	nextCoworkRef += collected.items.length;
	lastRefs = collected.items;
	lastPageUrl = page.url();
	const text = formatInteractiveSnapshot(lastRefs, options.maxChars ?? 6_000);
	return { refs: lastRefs, text };
}

function suggestNearMisses(hint: string): string {
	if (!lastRefs.length || !hint.trim()) return "";
	const q = hint.toLowerCase();
	const scored = lastRefs
		.map((r) => {
			const hay = `${r.name} ${r.role} ${r.tag} ${r.placeholder || ""} ${r.href || ""}`.toLowerCase();
			let score = 0;
			if (hay.includes(q)) score += 5;
			for (const part of q.split(/\s+/).filter((p) => p.length > 2)) {
				if (hay.includes(part)) score += 1;
			}
			return { r, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, 5);
	if (!scored.length) {
		const sample = lastRefs
			.slice(0, 8)
			.map((r) => `@${r.ref} ${r.role}${r.name ? ` ${JSON.stringify(r.name)}` : ""}`)
			.join("; ");
		return sample ? ` Recent refs: ${sample}` : "";
	}
	return (
		" Near matches from last snapshot: " +
		scored
			.map(
				({ r }) =>
					`@${r.ref} ${r.role}${r.name ? ` ${JSON.stringify(r.name)}` : ""}`,
			)
			.join("; ")
	);
}

async function locatorFromRef(page: Page, refRaw: string): Promise<Locator> {
	const ref = normalizeRef(refRaw);
	if (!/^e\d+$/i.test(ref)) {
		throw new Error(`Invalid ref "${refRaw}". Use @e1 style refs from the last snapshot.`);
	}
	if (!lastRefs.some((r) => r.ref.toLowerCase() === ref.toLowerCase())) {
		throw new Error(
			`Unknown or stale ref @${ref}. Call action=snapshot (interactive) again, then use a ref from that list.`,
		);
	}
	if (lastPageUrl && page.url() !== lastPageUrl) {
		clearCoworkRefs();
		throw new Error(
			`Page URL changed since last snapshot (${lastPageUrl} → ${page.url()}). Call snapshot again.`,
		);
	}
	const loc = page.locator(`[${REF_ATTR}="${ref}"]`);
	const count = await loc.count();
	if (count === 0) {
		clearCoworkRefs();
		throw new Error(
			`Ref @${ref} is stale (element gone). Call action=snapshot again.${suggestNearMisses(ref)}`,
		);
	}
	return loc.first();
}

/** Build a Playwright locator from ref / role+name / text / CSS. Prefer ref. */
export async function resolveCoworkLocator(
	page: Page,
	target: ResolveTarget,
): Promise<{ locator: Locator; how: string }> {
	if (target.ref?.trim()) {
		const loc = await locatorFromRef(page, target.ref);
		return { locator: loc, how: `ref @${normalizeRef(target.ref)}` };
	}

	// Allow selector field to carry @eN for models that still put refs there.
	if (target.selector?.trim() && isRefToken(target.selector)) {
		const loc = await locatorFromRef(page, target.selector);
		return { locator: loc, how: `ref @${normalizeRef(target.selector)}` };
	}

	if (target.role?.trim()) {
		const role = target.role.trim() as Parameters<Page["getByRole"]>[0];
		const name = target.name?.trim();
		const loc = name
			? page.getByRole(role, { name: new RegExp(escapeRegExp(name), "i") })
			: page.getByRole(role);
		return {
			locator: loc.first(),
			how: name ? `role=${role} name=${JSON.stringify(name)}` : `role=${role}`,
		};
	}

	if (target.name?.trim() && !target.role) {
		const name = target.name.trim();
		const loc = page.getByRole("button", { name: new RegExp(escapeRegExp(name), "i") });
		return { locator: loc.first(), how: `name=${JSON.stringify(name)}` };
	}

	if (target.text?.trim()) {
		const t = target.text.trim();
		return {
			locator: page.getByText(t, { exact: false }).first(),
			how: `text=${JSON.stringify(t)}`,
		};
	}

	if (target.selector?.trim()) {
		return {
			locator: page.locator(target.selector.trim()).first(),
			how: `css=${target.selector.trim()}`,
		};
	}

	throw new Error(
		"Provide ref (@e3 from snapshot), or role+name, or text, or selector. Prefer ref.",
	);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function prepareAndAct(
	page: Page,
	target: ResolveTarget,
	act: (locator: Locator) => Promise<void>,
	options: { textHint?: string; signal?: AbortSignal } = {},
): Promise<string> {
	let how: string;
	try {
		if (options.signal?.aborted) {
			throw options.signal.reason instanceof Error
				? options.signal.reason
				: new DOMException("Aborted", "AbortError");
		}
		const resolved = await resolveCoworkLocator(page, target);
		how = resolved.how;
		const loc = resolved.locator;
		await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS }).catch(() => {});
		await loc.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
		if (options.signal?.aborted) {
			throw options.signal.reason instanceof Error
				? options.signal.reason
				: new DOMException("Aborted", "AbortError");
		}
		await act(loc);
		return how;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const hint =
			target.ref ||
			target.name ||
			target.selector ||
			target.role ||
			options.textHint ||
			"";
		throw new Error(`${msg}${suggestNearMisses(hint)}`);
	}
}

export interface FillStep {
	ref: string;
	text: string;
	clear?: boolean;
}

/** Fill fields from one snapshot, then optionally click once. */
export async function runFillBatch(
	page: Page,
	fills: FillStep[],
	clickRef?: string,
	signal?: AbortSignal,
): Promise<{ filled: number; clicked: boolean }> {
	let filled = 0;
	for (const step of fills) {
		try {
			await prepareAndAct(
				page,
				{ ref: step.ref },
				async (loc) => {
					if (step.clear !== false) {
						await loc.fill(step.text, { timeout: ACTION_TIMEOUT_MS });
					} else {
						await loc.pressSequentially(step.text, { delay: 20, timeout: ACTION_TIMEOUT_MS });
					}
				},
				{ signal },
			);
			filled++;
		} catch (err) {
			if (signal?.aborted) throw err;
			throw new Error(
				`Batch stopped after ${filled}/${fills.length} fills: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	if (clickRef) {
		try {
			await prepareAndAct(
				page,
				{ ref: clickRef },
				(loc) => loc.click({ timeout: ACTION_TIMEOUT_MS }),
				{ signal },
			);
		} catch (err) {
			if (signal?.aborted) throw err;
			throw new Error(
				`Batch filled ${filled}/${fills.length}, final click failed or outcome unknown: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	return { filled, clicked: Boolean(clickRef) };
}

export { ACTION_TIMEOUT_MS, REF_ATTR };

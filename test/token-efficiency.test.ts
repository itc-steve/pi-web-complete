/** Token-efficiency behavior checks. Run: npx tsx test/token-efficiency.test.ts */

import assert from "node:assert/strict";
import type { Page } from "playwright-core";

import { truncateContext7 } from "../src/context7/context7.js";
import {
	buildInteractiveSnapshot,
	clearCoworkRefs,
	formatInteractiveSnapshot,
	resetCoworkRefs,
	runFillBatch,
	type InteractiveRef,
} from "../src/cowork/refs.js";

const short = "short docs";
assert.deepEqual(truncateContext7(short), { text: short, truncated: false, chars: short.length });

const long = `${"line\n".repeat(3_000)}tail`;
const capped = truncateContext7(long);
assert.equal(capped.truncated, true);
assert.equal(capped.chars, long.length);
assert.ok(capped.text.length <= 12_000, `capped output too large: ${capped.text.length}`);
assert.match(capped.text, /truncated: \d+ chars omitted/);
assert.ok(!capped.text.includes("tail"), "must remove content beyond cap");

const refs: InteractiveRef[] = [
	{ ref: "e1", role: "button", name: "Below fold", tag: "button", inViewport: false },
	{ ref: "e2", role: "textbox", name: "Visible", tag: "input", inViewport: true },
];
const formatted = formatInteractiveSnapshot(refs);
assert.ok(formatted.indexOf("@e2") < formatted.indexOf("@e1"), "viewport refs must come first");

const actions: string[] = [];
const locator = (ref: string) => ({
	count: async () => 1,
	first() { return this; },
	scrollIntoViewIfNeeded: async () => actions.push(`scroll:${ref}`),
	waitFor: async () => actions.push(`wait:${ref}`),
	fill: async (text: string) => actions.push(`fill:${ref}:${text}`),
	pressSequentially: async (text: string) => actions.push(`press:${ref}:${text}`),
	click: async () => actions.push(`click:${ref}`),
});
const page = {
	url: () => "https://example.com/form",
	evaluate: async () => ({
		items: [
			{ ref: "e1", role: "textbox", name: "First", tag: "input", inViewport: true },
			{ ref: "e2", role: "textbox", name: "Second", tag: "input", inViewport: true },
			{ ref: "e3", role: "button", name: "Submit", tag: "button", inViewport: true },
		],
	}),
	locator: (selector: string) => locator(selector.match(/e\d+/)?.[0] ?? "unknown"),
} as unknown as Page;
await buildInteractiveSnapshot(page);
const batch = await runFillBatch(
	page,
	[
		{ ref: "@e1", text: "alpha" },
		{ ref: "@e2", text: "beta", clear: false },
	],
	"@e3",
);
assert.deepEqual(batch, { filled: 2, clicked: true });
assert.deepEqual(actions, [
	"scroll:e1", "wait:e1", "fill:e1:alpha",
	"scroll:e2", "wait:e2", "press:e2:beta",
	"scroll:e3", "wait:e3", "click:e3",
]);

resetCoworkRefs();
const uniquePage = {
	url: () => "https://example.com",
	evaluate: async (_fn: unknown, args: { start: number }) => ({
		items: [{ ref: `e${args.start}`, role: "button", name: "Same", tag: "button", inViewport: true }],
	}),
} as unknown as Page;
const firstSnapshot = await buildInteractiveSnapshot(uniquePage);
clearCoworkRefs();
const secondSnapshot = await buildInteractiveSnapshot(uniquePage);
assert.equal(firstSnapshot.refs[0]?.ref, "e1");
assert.equal(secondSnapshot.refs[0]?.ref, "e2", "refs must not alias earlier action arguments");

resetCoworkRefs();
const failingPage = {
	url: () => "https://example.com/form",
	evaluate: async () => ({
		items: [
			{ ref: "e1", role: "textbox", name: "First", tag: "input", inViewport: true },
			{ ref: "e2", role: "textbox", name: "Second", tag: "input", inViewport: true },
		],
	}),
	locator: (selector: string) => {
		const ref = selector.match(/e\d+/)?.[0];
		return {
			count: async () => 1,
			first() { return this; },
			scrollIntoViewIfNeeded: async () => {},
			waitFor: async () => {},
			fill: async () => {
				if (ref === "e2") throw new Error("field detached");
			},
		};
	},
} as unknown as Page;
await buildInteractiveSnapshot(failingPage);
await assert.rejects(
	() => runFillBatch(failingPage, [{ ref: "@e1", text: "ok" }, { ref: "@e2", text: "fail" }]),
	/Batch stopped after 1\/2 fills/,
);

console.log("Token-efficiency checks passed");

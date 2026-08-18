/**
 * Input parsing + geometry mapping for the Herdr browser view.
 *
 * Run:  npx tsx test/herdr-view.test.ts
 */

import assert from "node:assert/strict";
import {
	cdpModifiers,
	keyToCdp,
	parseAll,
	parseOne,
	type KeyEvent,
	type MouseEvent,
} from "../src/cowork/herdr/input.js";
import { resolveHerdrConfig } from "../src/cowork/herdr/config.js";
import { validateBrowserWsUrl } from "../src/cowork/herdr/cdp.js";
import { shellQuote, validateCdpVersion } from "../src/cowork/herdr/pane.js";
import {
	cellToPagePixel,
	computeLayout,
	deviceMetricsForLayout,
	toolbarRowAt,
} from "../src/cowork/herdr/geometry.js";
import {
	hitTest,
	renderToolbar,
	sanitizeTerminalText,
	type TabEntry,
} from "../src/cowork/herdr/toolbar.js";

let passed = 0;
function test(name: string, fn: () => void): void {
	fn();
	passed++;
	console.log(`  ok  ${name}`);
}

console.log("config");

test("Herdr browser zoom defaults to 75% and accepts an override", () => {
	assert.equal(resolveHerdrConfig(undefined).browserZoom, 0.75);
	assert.equal(resolveHerdrConfig({ browserZoom: 1.25 }).browserZoom, 1.25);
});

test("CDP readiness requires the expected loopback Chrome websocket", () => {
	assert.equal(validateCdpVersion("ok", 9222), false);
	assert.equal(validateCdpVersion({ webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/browser/x" }, 9222), false);
	assert.equal(validateCdpVersion({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x" }, 9222), true);
	assert.throws(() => validateBrowserWsUrl("http://127.0.0.1:9222", "wss://attacker.example/devtools/browser/x"));
	assert.equal(
		validateBrowserWsUrl("http://127.0.0.1:9222", "ws://127.0.0.1:9222/devtools/browser/x"),
		"ws://127.0.0.1:9222/devtools/browser/x",
	);
});

test("view command arguments are single-quoted safely", () => {
	assert.equal(shellQuote("/tmp/a'$(touch nope)"), "'/tmp/a'\\''$(touch nope)'");
});

console.log("SGR mouse parsing");

test("left press reports button and 1-based cell", () => {
	const { event, consumed } = parseOne("\x1b[<0;10;5M");
	assert.equal(consumed, 10);
	const m = event as MouseEvent;
	assert.equal(m.kind, "mouse");
	assert.equal(m.action, "press");
	assert.equal(m.button, "left");
	assert.equal(m.col, 10);
	assert.equal(m.row, 5);
});

test("trailing lowercase m is a release", () => {
	const m = parseOne("\x1b[<0;10;5m").event as MouseEvent;
	assert.equal(m.action, "release");
	assert.equal(m.button, "left");
});

test("bit 32 marks motion (drag)", () => {
	const m = parseOne("\x1b[<32;3;4M").event as MouseEvent;
	assert.equal(m.action, "move");
	assert.equal(m.button, "left");
});

test("bare motion without a button", () => {
	const m = parseOne("\x1b[<35;81;7M").event as MouseEvent;
	assert.equal(m.action, "move");
	assert.equal(m.button, "none");
});

test("wheel up is negative, wheel down positive", () => {
	const up = parseOne("\x1b[<64;1;1M").event as MouseEvent;
	const down = parseOne("\x1b[<65;1;1M").event as MouseEvent;
	assert.equal(up.action, "wheel");
	assert.equal(up.wheelDelta, -1);
	assert.equal(down.wheelDelta, 1);
});

test("horizontal wheel is ignored but consumed", () => {
	const { event, consumed } = parseOne("\x1b[<66;1;1M");
	assert.equal(event, null);
	assert.ok(consumed > 0);
});

test("mouse modifier bits decode", () => {
	const m = parseOne("\x1b[<28;1;1M").event as MouseEvent; // 16 ctrl + 8 alt + 4 shift
	assert.equal(m.ctrl, true);
	assert.equal(m.alt, true);
	assert.equal(m.shift, true);
});

test("a split mouse sequence waits for the rest", () => {
	const { event, consumed } = parseOne("\x1b[<0;10;");
	assert.equal(event, null);
	assert.equal(consumed, 0, "incomplete input must not be consumed");
});

console.log("key parsing");

test("printable char carries text", () => {
	const k = parseOne("a").event as KeyEvent;
	assert.equal(k.key, "a");
	assert.equal(k.text, "a");
	assert.equal(k.ctrl, false);
});

test("arrow keys map to CDP names", () => {
	assert.equal((parseOne("\x1b[A").event as KeyEvent).key, "ArrowUp");
	assert.equal((parseOne("\x1b[D").event as KeyEvent).key, "ArrowLeft");
});

test("modified arrow decodes ctrl", () => {
	const k = parseOne("\x1b[1;5C").event as KeyEvent;
	assert.equal(k.key, "ArrowRight");
	assert.equal(k.ctrl, true);
	assert.equal(k.alt, false);
});

test("tilde sequences map (PageDown, Delete)", () => {
	assert.equal((parseOne("\x1b[6~").event as KeyEvent).key, "PageDown");
	assert.equal((parseOne("\x1b[3~").event as KeyEvent).key, "Delete");
});

test("enter, tab, backspace", () => {
	assert.equal((parseOne("\r").event as KeyEvent).key, "Enter");
	assert.equal((parseOne("\t").event as KeyEvent).key, "Tab");
	assert.equal((parseOne("\x7f").event as KeyEvent).key, "Backspace");
});

test("ctrl+letter sets ctrl and the letter", () => {
	const k = parseOne("\x03").event as KeyEvent; // ctrl+c
	assert.equal(k.key, "c");
	assert.equal(k.ctrl, true);
});

test("bare ESC can be flushed after the terminal sequence timeout", () => {
	assert.equal(parseOne("\x1b").event, null);
	const k = parseAll("\x1b", true).events[0] as KeyEvent;
	assert.equal(k.key, "Escape");
});

test("parseAll drains a mixed burst and keeps the remainder", () => {
	const { events, rest } = parseAll("ab\x1b[<0;2;3M\x1b[A\x1b[<0;4;");
	assert.equal(rest, "\x1b[<0;4;", "partial tail is preserved");
	const kinds = events.map((e) => (e.kind === "key" ? `k:${e.key}` : `m:${e.action}`));
	assert.deepEqual(kinds, ["k:a", "k:b", "m:press", "k:ArrowUp"]);
});

console.log("CDP mapping");

test("modifier bitmask matches CDP (alt1 ctrl2 shift8)", () => {
	assert.equal(cdpModifiers({ alt: false, ctrl: false, shift: false }), 0);
	assert.equal(cdpModifiers({ alt: true, ctrl: false, shift: false }), 1);
	assert.equal(cdpModifiers({ alt: false, ctrl: true, shift: false }), 2);
	assert.equal(cdpModifiers({ alt: false, ctrl: false, shift: true }), 8);
	assert.equal(cdpModifiers({ alt: true, ctrl: true, shift: true }), 11);
});

test("printable keys send text, ctrl combos do not", () => {
	const printable = keyToCdp({ kind: "key", key: "a", text: "a", shift: false, alt: false, ctrl: false });
	assert.equal(printable.type, "keyDown");
	assert.equal(printable.text, "a");

	const ctrlA = keyToCdp({ kind: "key", key: "a", text: "a", shift: false, alt: false, ctrl: true });
	assert.equal(ctrlA.type, "rawKeyDown");
	assert.equal(ctrlA.text, undefined, "ctrl combos must not insert text");
});

test("Enter always carries a carriage return", () => {
	const enter = keyToCdp({ kind: "key", key: "Enter", shift: false, alt: false, ctrl: false });
	assert.equal(enter.text, "\r");
});

test("browser zoom keys carry Chromium virtual-key codes", () => {
	const minus = keyToCdp({ kind: "key", key: "-", text: "-", shift: false, alt: false, ctrl: true });
	assert.equal(minus.code, "Minus");
	assert.equal(minus.windowsVirtualKeyCode, 189);

	const equal = keyToCdp({ kind: "key", key: "=", text: "=", shift: false, alt: false, ctrl: true });
	assert.equal(equal.code, "Equal");
	assert.equal(equal.windowsVirtualKeyCode, 187);
});

console.log("geometry");

const cell = { cellWidthPx: 9, cellHeightPx: 20 };
const layout = computeLayout({
	paneCols: 80,
	paneRows: 24,
	...cell,
	toolbarRows: 2,
	statusRows: 0,
	captureScale: 1,
});

test("graphics area excludes toolbar rows", () => {
	assert.equal(layout.gridCols, 80);
	assert.equal(layout.gridRows, 22);
	assert.equal(layout.viewportRow, 2);
});

test("viewport is an exact multiple of the cell grid", () => {
	assert.equal(layout.pageWidth, 80 * 9);
	assert.equal(layout.pageHeight, 22 * 20);
});

test("captureScale shrinks the image, never the viewport", () => {
	const scaled = computeLayout({
		paneCols: 80,
		paneRows: 24,
		...cell,
		toolbarRows: 2,
		statusRows: 0,
		captureScale: 0.5,
	});
	assert.equal(scaled.pageWidth, layout.pageWidth, "viewport must not change");
	assert.equal(scaled.imageWidth, Math.round(layout.pageWidth * 0.5));
	assert.equal(scaled.imageHeight, Math.round(layout.pageHeight * 0.5));
});

test("first page cell maps to the centre of that cell", () => {
	const p = cellToPagePixel(1, 3, layout, cell);
	// 9px cell → centre 4.5 → 5; 20px cell → centre 10.
	assert.deepEqual(p, { x: 5, y: 10 });
});

test("browser zoom scales the CDP view and pointer coordinates together", () => {
	assert.equal(deviceMetricsForLayout(layout, 0.75).deviceScaleFactor, 0.75);
	// zoomed viewport must render to exactly the pane size, else blank margins
	for (const z of [0.5, 0.75, 1, 1.5, 2.5]) {
		const m = deviceMetricsForLayout(layout, z);
		assert.equal(m.scale, 1);
		assert.ok(Math.abs(m.width * m.deviceScaleFactor - layout.pageWidth) <= 1);
		assert.ok(Math.abs(m.height * m.deviceScaleFactor - layout.pageHeight) <= 1);
	}
	assert.deepEqual(cellToPagePixel(1, 3, layout, cell, 0.5), { x: 9, y: 20 });
	assert.deepEqual(cellToPagePixel(1, 3, layout, cell, 2), { x: 2, y: 5 });
});

test("toolbar rows never map into the page", () => {
	assert.equal(cellToPagePixel(5, 1, layout, cell), null);
	assert.equal(cellToPagePixel(5, 2, layout, cell), null);
	assert.ok(cellToPagePixel(5, 3, layout, cell));
});

test("clicks beyond the grid are rejected", () => {
	assert.equal(cellToPagePixel(81, 5, layout, cell), null);
	assert.equal(cellToPagePixel(5, 25, layout, cell), null);
});

test("bottom-right cell stays inside the viewport", () => {
	const p = cellToPagePixel(80, 24, layout, cell);
	assert.ok(p);
	assert.ok(p.x < layout.pageWidth, "x within viewport");
	assert.ok(p.y < layout.pageHeight, "y within viewport");
});

test("toolbarRowAt identifies toolbar rows only", () => {
	assert.equal(toolbarRowAt(1, layout), 0);
	assert.equal(toolbarRowAt(2, layout), 1);
	assert.equal(toolbarRowAt(3, layout), null);
});

test("a status row shrinks the grid from the bottom", () => {
	const withStatus = computeLayout({
		paneCols: 40,
		paneRows: 10,
		...cell,
		toolbarRows: 2,
		statusRows: 1,
		captureScale: 1,
	});
	assert.equal(withStatus.gridRows, 7);
	assert.equal(cellToPagePixel(1, 10, withStatus, cell), null, "status row is not page area");
});

test("a tiny pane still yields a usable 1-row grid", () => {
	const tiny = computeLayout({
		paneCols: 4,
		paneRows: 2,
		...cell,
		toolbarRows: 2,
		statusRows: 0,
		captureScale: 1,
	});
	assert.equal(tiny.gridRows, 1);
	assert.ok(tiny.pageHeight >= 1);
});

console.log("toolbar");

test("remote titles and URLs cannot inject terminal controls", () => {
	const payload = "safe\x1b]52;c;clipboard\x07\n\u202etail";
	const clean = sanitizeTerminalText(payload);
	assert.equal(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(clean), false);
	const { lines } = renderToolbar(
		{ tabs: [{ targetId: "t", title: payload, active: true }], url: payload, zoom: 1, loading: false },
		80,
	);
	const allowedSgr = /\x1b\[(?:0|2|7)m/g;
	assert.equal(lines.join("").replace(allowedSgr, "").includes("\x1b"), false);
});

function tabs(n: number): TabEntry[] {
	return Array.from({ length: n }, (_, i) => ({
		targetId: `t${i}`,
		title: `A very long page title number ${i}`,
		active: i === 0,
	}));
}

/** Visible width, ignoring SGR colour escapes. */
function visibleWidth(line: string): number {
	return line.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function findNewTab(regions: ReturnType<typeof renderToolbar>["regions"]) {
	return regions.find((r) => r.action.kind === "new-tab")!;
}

for (const cols of [40, 80, 120]) {
	for (const count of [1, 2, 3, 5, 8, 20]) {
		test(`[+] stays clickable at cols=${cols} tabs=${count}`, () => {
			const { lines, regions } = renderToolbar(
				{ tabs: tabs(count), url: "https://example.com", zoom: 1, loading: false },
				cols,
			);
			const plus = findNewTab(regions);
			// Regression: [+] used to be pushed past the pane edge and clipped.
			assert.ok(plus.end <= cols - 1, `[+] ends at ${plus.end}, pane is ${cols} wide`);
			assert.equal(
				hitTest(regions, 0, plus.start)?.kind,
				"new-tab",
				"clicking [+] must hit new-tab",
			);
			assert.ok(
				visibleWidth(lines[0]!) <= cols,
				`tab row is ${visibleWidth(lines[0]!)} wide, pane is ${cols}`,
			);
			assert.ok(visibleWidth(lines[1]!) <= cols, "control row must fit the pane");
		});
	}
}

test("every close button is inside the pane and hittable", () => {
	const cols = 80;
	const { regions } = renderToolbar(
		{ tabs: tabs(4), url: "u", zoom: 1, loading: false },
		cols,
	);
	const closes = regions.filter((r) => r.action.kind === "close-tab");
	assert.ok(closes.length > 0, "at least one close button is rendered");
	for (const c of closes) {
		assert.ok(c.end <= cols - 1, "close button within pane");
		assert.equal(hitTest(regions, 0, c.start)?.kind, "close-tab");
	}
});

test("no two regions on a row overlap", () => {
	const { regions } = renderToolbar(
		{ tabs: tabs(3), url: "u", zoom: 1, loading: false },
		80,
	);
	for (const row of [0, 1]) {
		const sorted = regions.filter((r) => r.row === row).sort((a, b) => a.start - b.start);
		for (let i = 1; i < sorted.length; i++) {
			// The URL field intentionally spans to the pane edge; skip that pair.
			if (sorted[i]!.action.kind === "focus-url") continue;
			assert.ok(
				sorted[i]!.start > sorted[i - 1]!.end,
				`row ${row}: ${sorted[i - 1]!.action.kind} overlaps ${sorted[i]!.action.kind}`,
			);
		}
	}
});

test("reload becomes stop while loading", () => {
	const idle = renderToolbar({ tabs: tabs(1), url: "u", zoom: 1, loading: false }, 80);
	const busy = renderToolbar({ tabs: tabs(1), url: "u", zoom: 1, loading: true }, 80);
	assert.ok(idle.regions.some((r) => r.action.kind === "reload"));
	assert.ok(busy.regions.some((r) => r.action.kind === "stop"));
});

test("clicking empty toolbar space does nothing harmful", () => {
	const { regions } = renderToolbar(
		{ tabs: tabs(1), url: "u", zoom: 1, loading: false },
		80,
	);
	// Row 2 of a 2-row toolbar does not exist; must not throw or match.
	assert.equal(hitTest(regions, 5, 5), null);
});

console.log(`\n${passed} checks passed`);

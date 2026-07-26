/**
 * MIME routing + charset/meta-sniff interaction tests.
 *
 * Run:  npx tsx test/mime.test.ts
 */

import assert from "node:assert/strict";
import { readBodyCapped } from "../src/read/fetch.js";
import {
	contentFromAlternateBody,
	isHtmlish,
	isRawBody,
} from "../src/read/pipeline.js";

function makeMockResponse(
	bytes: Uint8Array,
	headers: Record<string, string> = {},
) {
	const stream = new ReadableStream({
		start(ctrl) {
			ctrl.enqueue(bytes);
			ctrl.close();
		},
	});
	return {
		body: { getReader: () => stream.getReader() },
		arrayBuffer: async () => bytes.buffer as ArrayBuffer,
		headers: {
			get: (name: string) => headers[name.toLowerCase()] ?? null,
		},
	};
}

async function main() {
	// --- BUG 1: text/plain mentioning <meta charset> must stay intact ---
	const mention =
		'Docs: set <meta charset="utf-16le"> in the <head> of an HTML page.\n' +
		"This is plain documentation, not HTML.";
	const plainBytes = new TextEncoder().encode(mention);
	const plainResp = makeMockResponse(plainBytes, {
		"content-type": "text/plain; charset=utf-8",
	});
	const plainDecoded = await readBodyCapped(plainResp, 1024);
	assert.equal(
		plainDecoded.text,
		mention,
		`text/plain with meta mention corrupted: ${JSON.stringify(plainDecoded.text)}`,
	);
	// also: no charset header, only a mention in body — must NOT sniff as utf-16le
	const plainNoCt = makeMockResponse(plainBytes, {
		"content-type": "text/plain",
	});
	const plainNoCtDecoded = await readBodyCapped(plainNoCt, 1024);
	assert.equal(
		plainNoCtDecoded.text,
		mention,
		`text/plain meta-sniff destroyed body: ${JSON.stringify(plainNoCtDecoded.text)}`,
	);
	console.log("PASS: text/plain mentioning <meta charset> survives intact");

	// --- BUG 1 near-miss: PDF magic bytes survive non-HTML decode ---
	// Body is a PDF; content-type is wrong (octet-stream) and body text also
	// mentions a meta charset (as docs sometimes do). After gating the sniff,
	// body stays utf-8 so %PDF- magic is intact for isPdfContent fallback.
	const pdfWithMention =
		"%PDF-1.4\n% docs sometimes say <meta charset=\"utf-16le\"> nearby\ntrailer";
	const pdfBytes = new TextEncoder().encode(pdfWithMention);
	const pdfResp = makeMockResponse(pdfBytes, {
		"content-type": "application/octet-stream",
	});
	const pdfDecoded = await readBodyCapped(pdfResp, 1024);
	assert.ok(
		pdfDecoded.text.startsWith("%PDF-"),
		`PDF magic destroyed by charset sniff: ${JSON.stringify(pdfDecoded.text.slice(0, 40))}`,
	);
	const pdfPlaceholder = contentFromAlternateBody(
		pdfDecoded.text,
		"application/octet-stream",
		"markdown",
		false,
		undefined,
		pdfBytes.byteLength,
	);
	assert.ok(
		pdfPlaceholder.includes("PDF document"),
		`magic-byte PDF not detected after decode: ${JSON.stringify(pdfPlaceholder)}`,
	);
	assert.ok(
		pdfPlaceholder.includes(`${pdfBytes.byteLength} bytes`),
		`PDF placeholder missing byte count: ${JSON.stringify(pdfPlaceholder)}`,
	);
	console.log("PASS: PDF magic bytes survive bogus non-HTML charset path");

	// --- BUG 2: XML / feeds are HTML-ish for routing ---
	assert.equal(isHtmlish("application/xml"), true);
	assert.equal(isHtmlish("text/xml"), true);
	assert.equal(isHtmlish("application/rss+xml"), true);
	assert.equal(isHtmlish("application/atom+xml"), true);
	assert.equal(isHtmlish("application/xhtml+xml"), true);
	assert.equal(isHtmlish("text/html"), true);
	assert.equal(isHtmlish(""), true);
	// still not HTML-ish:
	assert.equal(isHtmlish("text/plain"), false);
	assert.equal(isHtmlish("application/json"), false);
	assert.equal(isHtmlish("application/pdf"), false);
	// image/* must not ride the +xml branch into Readability
	assert.equal(isHtmlish("image/svg+xml"), false);
	assert.equal(isHtmlish("image/png"), false);
	console.log("PASS: application/xml and feed types route as HTML-ish");

	// --- text/plain still materializes as raw text (no turndown) ---
	const plainOut = contentFromAlternateBody(
		"# Hello\n\nWorld",
		"text/plain",
		"markdown",
		false,
	);
	assert.equal(plainOut, "# Hello\n\nWorld");
	console.log("PASS: text/plain passes through as raw text");

	// --- JSON still pretty-printed ---
	const jsonOut = contentFromAlternateBody(
		'{"b":1,"a":2}',
		"application/json",
		"markdown",
		false,
	);
	assert.equal(jsonOut, '{\n  "b": 1,\n  "a": 2\n}');
	assert.ok(!jsonOut.includes("<"), "JSON must not be HTML-converted");
	console.log("PASS: JSON is pretty-printed");

	// --- explicit application/pdf still placeholder ---
	const pdfExplicit = contentFromAlternateBody(
		"%PDF-1.7 x",
		"application/pdf",
		"markdown",
		false,
		undefined,
		12,
	);
	assert.ok(pdfExplicit.includes("PDF document"));
	assert.ok(pdfExplicit.includes("12 bytes"));
	console.log("PASS: application/pdf → placeholder");

	// --- N1: small non-HTML bodies are raw → auto path must not browser-escalate ---
	// readUrl gates browser on `!rawBody && (spaLikely || sparseDom)`. Assert the
	// pure predicate so a 28-byte JSON never reaches renderWithCloakBrowser.
	assert.equal(isRawBody("application/json", '{"ok":true}'), true);
	assert.equal(isRawBody("text/plain", "hello short plain body"), true);
	assert.equal(isRawBody("text/csv", "a,b,c\n1,2,3"), true);
	assert.equal(isRawBody("text/html", "<html><body>Hi</body></html>"), false);
	assert.equal(isRawBody("application/rss+xml", "<rss></rss>"), false);
	console.log("PASS: small JSON/plain/csv are raw (no browser branch)");

	// --- N6: HTML served as text/plain gets Readability / materialize treatment ---
	const mislabeledHtml =
		"<!doctype html><html><head><title>Real Title</title></head>" +
		"<body><article><p>Hello article body for readability.</p></article></body></html>";
	const mislabeledOut = contentFromAlternateBody(
		mislabeledHtml,
		"text/plain",
		"markdown",
		false,
	);
	assert.ok(
		!mislabeledOut.includes("<html") && !mislabeledOut.includes("<body"),
		`mislabeled HTML still tag soup: ${JSON.stringify(mislabeledOut.slice(0, 120))}`,
	);
	assert.ok(
		mislabeledOut.includes("Hello article body") ||
			mislabeledOut.includes("Real Title"),
		`mislabeled HTML lost content: ${JSON.stringify(mislabeledOut.slice(0, 120))}`,
	);
	// control: same body as text/html still works
	const labeledOut = contentFromAlternateBody(
		mislabeledHtml,
		"text/html",
		"markdown",
		false,
	);
	assert.ok(
		!labeledOut.includes("<html"),
		`text/html path still tag soup: ${JSON.stringify(labeledOut.slice(0, 120))}`,
	);
	console.log("PASS: HTML-as-text/plain gets Readability treatment");

	// --- titleFromUrl regression is covered indirectly: no export needed.
	// Basename-without-extension must not become a title; that's internal.

	console.log("\nAll mime tests passed.");
}

main().catch((e) => {
	console.error("FAIL:", e);
	process.exit(1);
});

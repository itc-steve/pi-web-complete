/**
 * Self-check: Wayback archive lookup (mocked fetch, no live network).
 *
 * Run:  npx tsx test/archive.test.ts
 */

import assert from "node:assert/strict";
import {
	archiveBanner,
	findWaybackSnapshot,
	isDeadStatus,
} from "../src/read/archive.js";

const HIT = {
	archived_snapshots: {
		closest: {
			available: true,
			url: "https://web.archive.org/web/20240315120000/https://example.com/",
			timestamp: "20240315120000",
		},
	},
};

function jsonResponse(body: unknown, ok = true): Response {
	return new Response(JSON.stringify(body), {
		status: ok ? 200 : 500,
		headers: { "content-type": "application/json" },
	});
}

async function main() {
	// --- A) isDeadStatus: 404/410 only ---
	assert.equal(isDeadStatus(404), true, "404 must be dead");
	assert.equal(isDeadStatus(410), true, "410 must be dead");
	for (const s of [200, 301, 403, 408, 429, 500]) {
		assert.equal(isDeadStatus(s), false, `status ${s} must not be dead`);
	}
	console.log("PASS: A) isDeadStatus true only for 404/410");

	// --- B) hit: closest available with url + timestamp; API url encoded ---
	let requested = "";
	const hitFetch = (async (input: unknown) => {
		requested = String(input);
		return jsonResponse(HIT);
	}) as typeof globalThis.fetch;
	const hit = await findWaybackSnapshot("https://example.com/", { fetch: hitFetch });
	assert.deepEqual(
		hit,
		{
			snapshotUrl: "https://web.archive.org/web/20240315120000/https://example.com/",
			timestamp: "20240315120000",
		},
		"hit must return closest snapshot url + timestamp",
	);
	assert.equal(
		requested,
		"https://archive.org/wayback/available?url=https%3A%2F%2Fexample.com%2F",
		"API URL must be archive.org wayback endpoint with encoded url param",
	);
	console.log("PASS: B) hit returns closest snapshot; URL encoded in API call");

	// --- C) miss shapes / non-ok / malformed body all → null ---
	const missBodies = [
		{ archived_snapshots: {} },
		{},
		{ archived_snapshots: { closest: { available: false } } },
		{ archived_snapshots: { closest: { available: true } } }, // no url/timestamp
		{ archived_snapshots: { closest: { available: true, url: "https://x", timestamp: "" } } },
	];
	for (const body of missBodies) {
		const r = await findWaybackSnapshot("https://example.com/", {
			fetch: (async () => jsonResponse(body)) as typeof globalThis.fetch,
		});
		assert.equal(r, null, `miss case must return null: ${JSON.stringify(body)}`);
	}
	const notOk = await findWaybackSnapshot("https://example.com/", {
		fetch: (async () => jsonResponse(HIT, false)) as typeof globalThis.fetch,
	});
	assert.equal(notOk, null, "non-ok response must return null");
	const badJson = await findWaybackSnapshot("https://example.com/", {
		fetch: (async () =>
			new Response("not json", { status: 200 })) as typeof globalThis.fetch,
	});
	assert.equal(badJson, null, "unparseable body must return null");
	console.log("PASS: C) miss / non-ok / malformed body all return null");

	// --- D) http→https rewrite on snapshot url ---
	const httpBody = {
		archived_snapshots: {
			closest: {
				available: true,
				url: "http://web.archive.org/web/20240315120000/https://example.com/",
				timestamp: "20240315120000",
			},
		},
	};
	const upgraded = await findWaybackSnapshot("https://example.com/", {
		fetch: (async () => jsonResponse(httpBody)) as typeof globalThis.fetch,
	});
	assert.equal(
		upgraded?.snapshotUrl,
		"https://web.archive.org/web/20240315120000/https://example.com/",
		"http snapshot url must be upgraded to https",
	);
	assert.equal(upgraded?.timestamp, "20240315120000");
	console.log("PASS: D) http snapshot url upgraded to https");

	// --- E) thrown fetch / aborted signal never throw to caller ---
	const thrown = await findWaybackSnapshot("https://example.com/", {
		fetch: (async () => {
			throw new Error("boom");
		}) as unknown as typeof globalThis.fetch,
	});
	assert.equal(thrown, null, "thrown fetch must yield null, not throw");
	const ctrl = new AbortController();
	ctrl.abort();
	const aborted = await findWaybackSnapshot("https://example.com/", {
		signal: ctrl.signal,
		fetch: (async (_input: unknown, init?: RequestInit) => {
			// emulate undici honoring an already-aborted signal
			(init?.signal as AbortSignal | undefined)?.throwIfAborted();
			return jsonResponse(HIT);
		}) as typeof globalThis.fetch,
	});
	assert.equal(aborted, null, "aborted signal must yield null, not throw");
	console.log("PASS: E) thrown / aborted fetch returns null without throwing");

	// --- F) archiveBanner: one line, human date + raw timestamp + source ---
	const banner = archiveBanner(
		"20240315120000",
		"https://web.archive.org/web/20240315120000/https://example.com/",
	);
	assert.equal(
		banner,
		"Archived snapshot 2024-03-15 (age labeled from timestamp 20240315120000). Source: https://web.archive.org/web/20240315120000/https://example.com/",
		"banner shape must match spec",
	);
	assert.equal(banner.includes("\n"), false, "banner must be a single line");
	console.log("PASS: F) archiveBanner single-line shape");

	console.log("\nAll archive tests passed.");
}

main().catch((e) => {
	console.error("FAIL:", e);
	process.exit(1);
});

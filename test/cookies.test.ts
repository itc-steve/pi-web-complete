/**
 * Self-check: in-memory session cookie jar (no browser, no network).
 *
 * Run:  npx tsx test/cookies.test.ts
 */

import assert from "node:assert/strict";
import {
	cookieHeaderFor,
	clearCookies,
	rememberCookies,
} from "../src/read/cookies.js";

async function main() {
	// --- A) remember + read back for the same host; other host untouched ---
	clearCookies();
	rememberCookies("https://example.com/page", [
		{ name: "a", value: "1" },
		{ name: "b", value: "2" },
	]);
	assert.equal(
		cookieHeaderFor("https://example.com/other"),
		"a=1; b=2",
		"same host must get the remembered cookies",
	);
	assert.equal(cookieHeaderFor("https://other.com/page"), undefined, "unrelated host must get no cookies");
	assert.equal(cookieHeaderFor("https://example.com/"), "a=1; b=2", "path must not matter");
	console.log("PASS: A) same-host read-back; unrelated host gets nothing");

	// --- B) parent-domain cookies apply to subdomains; leading dot ok ---
	clearCookies();
	rememberCookies("https://a.example.com/", [
		{ name: "session", value: "abc", domain: ".example.com" },
	]);
	assert.equal(
		cookieHeaderFor("https://b.example.com/x"),
		"session=abc",
		"leading-dot domain must match sibling subdomain",
	);
	assert.equal(
		cookieHeaderFor("https://example.com/"),
		"session=abc",
		"leading-dot domain must match the bare registrable host",
	);
	assert.equal(
		cookieHeaderFor("https://notexample.com/"),
		undefined,
		"domain suffix match must not swallow longer unrelated hosts",
	);
	console.log("PASS: B) parent-domain cookies apply; no false suffix match");

	// --- C) exact-host cookie does not leak to sibling subdomains ---
	clearCookies();
	rememberCookies("https://a.example.com/", [{ name: "sub", value: "1" }]);
	assert.equal(
		cookieHeaderFor("https://b.example.com/"),
		undefined,
		"cookie without domain must not leak to sibling subdomain",
	);
	assert.equal(cookieHeaderFor("https://a.example.com/"), "sub=1");
	console.log("PASS: C) no-domain cookie stays on its host");

	// --- D) empty name/value skipped ---
	clearCookies();
	rememberCookies("https://example.com/", [
		{ name: "", value: "x" },
		{ name: "y", value: "" },
		{ name: "z", value: "ok" },
	]);
	assert.equal(
		cookieHeaderFor("https://example.com/"),
		"z=ok",
		"empty name or value must be skipped",
	);
	console.log("PASS: D) empty name/value skipped");

	// --- E) later remember for same host replaces by name, keeps others ---
	rememberCookies("https://example.com/", [
		{ name: "z", value: "new" },
		{ name: "w", value: "4" },
	]);
	assert.equal(
		cookieHeaderFor("https://example.com/"),
		"z=new; w=4",
		"same-name re-remember must replace; other names kept",
	);
	console.log("PASS: E) later remember replaces same name");

	// --- F) clearCookies empties the jar ---
	clearCookies();
	rememberCookies("https://example.com/", [{ name: "c", value: "1" }]);
	assert.equal(cookieHeaderFor("https://example.com/"), "c=1");
	clearCookies();
	assert.equal(
		cookieHeaderFor("https://example.com/"),
		undefined,
		"cleared jar must return undefined",
	);
	console.log("PASS: F) clearCookies");

	// --- G) malformed urls never throw ---
	assert.equal(cookieHeaderFor("not a url"), undefined, "bad url → undefined");
	rememberCookies("garbage", [{ name: "n", value: "v" }]);
	assert.equal(cookieHeaderFor("garbage"), undefined, "bad pageUrl must not store");
	console.log("PASS: G) malformed urls handled");

	console.log("\nAll cookie tests passed.");
}

main().catch((e) => {
	console.error("FAIL:", e);
	process.exit(1);
});

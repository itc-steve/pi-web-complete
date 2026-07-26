/**
 * Self-check: excerpt ranking (fence-safe chunking, IDF, stem fold, quoted phrases).
 *
 * Run:  npx tsx test/excerpts.test.ts
 */

import assert from "node:assert/strict";
import {
	chunkMarkdown,
	pageOutline,
	scoreChunk,
	selectExcerpts,
	stem,
} from "../src/read/excerpts.js";

function main() {
	// --- A) Fenced block with internal blank line stays one chunk ---
	const fenced = [
		"## Code",
		"",
		"Intro paragraph long enough to clear the minimum chunk size threshold for packing.",
		"",
		"```js",
		"function demo() {",
		"",
		"  return 1;",
		"}",
		"```",
		"",
		"Trailing note after the fence also padded so the section is substantial enough.",
	].join("\n");

	const fenceChunks = chunkMarkdown(fenced);
	const withFence = fenceChunks.find((c) => c.text.includes("```"));
	assert.ok(withFence, "expected a chunk containing a code fence");
	const fenceOpens = (withFence!.text.match(/```/g) ?? []).length;
	assert.equal(
		fenceOpens % 2,
		0,
		`fence markers should be balanced, got: ${JSON.stringify(withFence!.text)}`,
	);
	assert.ok(
		withFence!.text.includes("function demo") &&
			withFence!.text.includes("return 1"),
		"fence body with internal blank line must stay intact",
	);
	// The blank line inside the fence must not have split it into separate chunks
	const fenceOnlyChunks = fenceChunks.filter((c) => c.text.includes("```"));
	for (const c of fenceOnlyChunks) {
		const n = (c.text.match(/```/g) ?? []).length;
		assert.equal(n % 2, 0, `unbalanced fence in chunk: ${c.text.slice(0, 80)}`);
	}
	console.log("PASS: A) fenced block with internal blank line stays intact");

	// --- B) Rare term outranks ubiquitous one (IDF) ---
	// "common" appears (once) in many chunks; "zygote" in one. Equal per-chunk TF,
	// so without IDF document-order/index would prefer S1; IDF must pick S8.
	const sections = [
		"## S1\n\ncommon appears here with enough padding words for the minimum chunk size.",
		"## S2\n\ncommon shows up in this section as well with more padding text here.",
		"## S3\n\ncommon again in section three with filler words for length here.",
		"## S4\n\ncommon once more in section four plus some padding for min length.",
		"## S5\n\ncommon in section five and still more padding text for the threshold.",
		"## S6\n\ncommon in section six with additional words to clear min chunk chars.",
		"## S7\n\ncommon in section seven so document frequency of common is high enough.",
		"## S8\n\nzygote is the rare specialized term that answers the real question.",
	];
	const idfDoc = sections.join("\n\n");
	const idfResult = selectExcerpts(idfDoc, "common zygote", { maxChunks: 1 });
	assert.ok(
		idfResult.text.toLowerCase().includes("zygote"),
		`IDF should prefer the rare-term chunk; got:\n${idfResult.text}`,
	);

	// Direct weight check: scoreChunk stays independently testable with explicit weights
	const commonChunk = {
		headingPath: "S1",
		text: "common common common common common common",
		start: 0,
		index: 0,
	};
	const rareChunk = {
		headingPath: "S8",
		text: "zygote is rare",
		start: 0,
		index: 1,
	};
	const q = "common zygote";
	assert.ok(
		scoreChunk(commonChunk, q) > scoreChunk(rareChunk, q),
		"without IDF, high TF of common should beat single rare hit",
	);
	const idf = new Map<string, number>([
		["common", 0.2],
		["zygote", 3],
	]);
	assert.ok(
		scoreChunk(rareChunk, q, idf) > scoreChunk(commonChunk, q, idf),
		"with strong IDF on zygote, rare chunk must outrank ubiquitous TF",
	);
	console.log("PASS: B) rare term outranks ubiquitous one via IDF");

	// --- C) Suffix folding: "caching" matches body "cache" ---
	// Symmetric sibilant+e fold: both sides land on "cach".
	assert.equal(stem("caching"), "cach");
	assert.equal(stem("cache"), "cach");
	const cacheChunk = {
		headingPath: "Perf",
		text: "Use a cache layer for repeated reads.",
		start: 0,
		index: 0,
	};
	const foldScore = scoreChunk(cacheChunk, "caching");
	assert.ok(
		foldScore > 0,
		`query "caching" should match body "cache", score=${foldScore}`,
	);
	// Exact match still outranks folded match
	const exactChunk = {
		headingPath: "Perf",
		text: "Use caching for repeated reads.",
		start: 0,
		index: 0,
	};
	assert.ok(
		scoreChunk(exactChunk, "caching") > foldScore,
		"exact token hit must outrank folded/stem hit",
	);
	console.log("PASS: C) suffix folding matches caching↔cache; exact outranks fold");

	// --- C2) -e nouns: plural must stem to the same form as singular ---
	assert.equal(stem("files"), stem("file"));
	assert.equal(stem("types"), stem("type"));
	assert.equal(stem("caches"), stem("cache"));
	assert.equal(stem("values"), stem("value"));
	// Sibilant -es path still works
	assert.equal(stem("boxes"), stem("box"));
	assert.equal(stem("classes"), stem("class"));
	console.log("PASS: C2) -e nouns and sibilant plurals stem symmetrically");

	// --- C3) Sibilant+silent-e plurals fold symmetrically (no carve-outs) ---
	assert.equal(stem("sizes"), stem("size"));
	assert.equal(stem("optimizes"), stem("optimize"));
	assert.equal(stem("serializes"), stem("serialize"));
	assert.equal(stem("headaches"), stem("headache"));
	console.log("PASS: C3) size/optimize/serialize/headache plurals stem symmetrically");

	// --- D) Quoted phrases required; non-match excluded; empty filter falls back ---
	const phraseDoc = [
		"## Auth",
		"",
		"This section covers auth tokens and sessions with enough padding for min size.",
		"",
		"## Limits",
		"",
		"The rate limit middleware rejects excess traffic after a burst window expires.",
	].join("\n");

	const phraseHit = selectExcerpts(phraseDoc, `"rate limit" auth`);
	assert.ok(
		phraseHit.text.toLowerCase().includes("rate limit"),
		"chunk containing the quoted phrase must be selected",
	);
	// With maxChunks 1 and a required phrase only in Limits, Auth alone must not win
	const onlyPhrase = selectExcerpts(phraseDoc, `"rate limit"`, { maxChunks: 1 });
	assert.ok(
		onlyPhrase.text.toLowerCase().includes("rate limit"),
		"quoted phrase filters to the matching chunk",
	);
	assert.ok(
		!onlyPhrase.text.includes("auth tokens"),
		"non-matching chunk excluded by quoted phrase filter",
	);

	// Phrase matches nothing, but free term "auth" still ranks — must fall back, not return empty.
	const fallback = selectExcerpts(phraseDoc, `"zzznomatchphrase" auth`);
	assert.ok(
		fallback.matched > 0,
		"zero phrase matches should fall back to unfiltered ranking, not empty",
	);
	assert.ok(
		fallback.text.includes("fell back") || fallback.text.includes("Quoted-phrase"),
		`fallback must be mentioned in meta; got:\n${fallback.text.slice(0, 400)}`,
	);
	console.log("PASS: D) quoted phrases filter; fallback when none match");

	// --- E) `#` comments inside bash fences must not split chunks or become headings ---
	const bashFence = [
		"## Setup",
		"",
		"Install steps with enough padding text so the section clears the min chunk size.",
		"",
		"```bash",
		"# install deps",
		"npm install",
		"```",
		"",
		"Done with setup and more padding so packing has something to work with here.",
	].join("\n");
	const bashChunks = chunkMarkdown(bashFence);
	const bashWithFence = bashChunks.filter((c) => c.text.includes("```"));
	assert.equal(
		bashWithFence.length,
		1,
		`bash fence with # comment must produce ONE fence-bearing chunk, got ${bashWithFence.length}`,
	);
	const bashChunk = bashWithFence[0]!;
	const bashMarkers = (bashChunk.text.match(/```/g) ?? []).length;
	assert.equal(
		bashMarkers % 2,
		0,
		`fence markers must be balanced, got: ${JSON.stringify(bashChunk.text)}`,
	);
	assert.ok(
		bashChunk.text.includes("# install deps"),
		"fence must still contain the # comment line",
	);
	for (const c of bashChunks) {
		assert.ok(
			!c.headingPath.toLowerCase().includes("comment") &&
				!c.headingPath.toLowerCase().includes("install deps"),
			`"comment" must not appear in headingPath; got ${JSON.stringify(c.headingPath)}`,
		);
	}
	console.log("PASS: E) bash # comment inside fence stays one balanced chunk");

	// --- F) Indented `   # foo` inside a fence is not a heading ---
	const indentedFence = [
		"## Notes",
		"",
		"Prose before the fence padded enough to clear the minimum chunk size threshold.",
		"",
		"```bash",
		"   # foo",
		"echo hi",
		"```",
		"",
		"Prose after the fence also padded so the section is substantial enough overall.",
	].join("\n");
	const indChunks = chunkMarkdown(indentedFence);
	const indWithFence = indChunks.filter((c) => c.text.includes("```"));
	assert.equal(
		indWithFence.length,
		1,
		`indented # inside fence must produce ONE fence-bearing chunk, got ${indWithFence.length}`,
	);
	const indChunk = indWithFence[0]!;
	assert.equal(
		(indChunk.text.match(/```/g) ?? []).length % 2,
		0,
		`fence markers must be balanced, got: ${JSON.stringify(indChunk.text)}`,
	);
	assert.ok(indChunk.text.includes("# foo"), "fence must contain the indented # line");
	for (const c of indChunks) {
		assert.ok(
			!/\bfoo\b/i.test(c.headingPath),
			`"foo" must not appear in headingPath; got ${JSON.stringify(c.headingPath)}`,
		);
	}
	console.log("PASS: F) indented # inside fence is not a heading");

	// --- G) pageOutline must ignore fence # comments and indented-code # lines ---
	const readmeWithBashBlock = [
		"# Project",
		"",
		"A short lead paragraph.",
		"",
		"```bash",
		"# requires node 20+",
		"npm install",
		"# optional: global",
		"```",
		"",
		"```python",
		"# import the client",
		"pass",
		"```",
		"",
		"    # indented code block heading lookalike",
		"",
		"## Real Section",
		"",
		"Body under a real heading.",
	].join("\n");
	const outline = pageOutline(readmeWithBashBlock);
	assert.ok(
		!/requires node/i.test(outline),
		`pageOutline must not list bash # comments as headings; got:\n${outline}`,
	);
	assert.ok(
		!/optional:\s*global/i.test(outline),
		`pageOutline must not list bash # comments as headings; got:\n${outline}`,
	);
	assert.ok(
		!/import the client/i.test(outline),
		`pageOutline must not list python # comments as headings; got:\n${outline}`,
	);
	assert.ok(
		!/indented code block/i.test(outline),
		`pageOutline must not list 4-space-indented # as a heading; got:\n${outline}`,
	);
	assert.ok(
		outline.includes("Project") && outline.includes("Real Section"),
		`pageOutline must still list real headings; got:\n${outline}`,
	);
	console.log("PASS: G) pageOutline ignores fence/indented #, keeps real headings");

	console.log("\nAll excerpt ranking tests passed.");
}

try {
	main();
} catch (e) {
	console.error("FAIL:", e);
	process.exit(1);
}

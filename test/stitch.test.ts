/**
 * Self-check: next-page ("stitch") discovery (pure HTML, no network).
 *
 * Run:  npx tsx test/stitch.test.ts
 */

import assert from "node:assert/strict";
import {
	MAX_STITCH_PAGES,
	findRelNext,
	stitchPartMarker,
} from "../src/read/stitch.js";
import { setPrivateHostAllowlist } from "../src/utils.js";

// Deterministic SSRF behavior regardless of ambient web.json.
setPrivateHostAllowlist([]);

const BASE = "https://ex.com/page/1";

// link tag wins
assert.equal(
	findRelNext(
		`<html><head><link rel="next" href="https://ex.com/page/2"></head>` +
			`<body><a rel="next" href="https://ex.com/page/9"></a></body></html>`,
		BASE,
	),
	"https://ex.com/page/2",
);

// anchor fallback
assert.equal(
	findRelNext(`<a rel="next" href="https://ex.com/page/2">Next</a>`, BASE),
	"https://ex.com/page/2",
);

// relative href resolved against baseUrl
assert.equal(
	findRelNext(`<a rel="next" href="/page/2">Next</a>`, BASE),
	"https://ex.com/page/2",
);
assert.equal(
	findRelNext(`<link rel="next" href="page/2">`, "https://ex.com/index.html"),
	"https://ex.com/page/2",
);

// rel: case-insensitive, other tokens ok, attr order flexible
assert.equal(
	findRelNext(`<a REL="Next" href="https://ex.com/page/2">x</a>`, BASE),
	"https://ex.com/page/2",
);
assert.equal(
	findRelNext(`<a rel="canonical next" href="https://ex.com/page/2">x</a>`, BASE),
	"https://ex.com/page/2",
);
assert.equal(
	findRelNext(`<a href="https://ex.com/page/2" rel="next">x</a>`, BASE),
	"https://ex.com/page/2",
);
assert.equal(findRelNext(`<a rel="prev" href="https://ex.com/page/0">x</a>`, BASE), null);
assert.equal(findRelNext(`<a rel="nextprev" href="https://ex.com/page/2">x</a>`, BASE), null);

// single-quoted + unquoted attrs
assert.equal(
	findRelNext(`<a rel='next' href='https://ex.com/page/2'>x</a>`, BASE),
	"https://ex.com/page/2",
);
assert.equal(
	findRelNext(`<a rel=next href=https://ex.com/page/2>x</a>`, BASE),
	"https://ex.com/page/2",
);

// same origin only
assert.equal(
	findRelNext(`<a rel="next" href="https://evil.example/page/2">x</a>`, BASE),
	null,
);

// fragment-only / same document ignored
assert.equal(findRelNext(`<a rel="next" href="#">x</a>`, BASE), null);
assert.equal(findRelNext(`<a rel="next" href="#section">x</a>`, BASE), null);
assert.equal(
	findRelNext(`<a rel="next" href="https://ex.com/page/1#other">x</a>`, BASE),
	null,
);
// different query is a different document — kept
assert.equal(
	findRelNext(`<a rel="next" href="https://ex.com/page/1?cursor=2">x</a>`, BASE),
	"https://ex.com/page/1?cursor=2",
);

// first match in document order: invalid first, valid second
assert.equal(
	findRelNext(
		`<a rel="next" href="https://evil.example/x">x</a>` +
			`<a rel="next" href="https://ex.com/page/2">x</a>`,
		BASE,
	),
	"https://ex.com/page/2",
);

// SSRF target dropped
assert.equal(
	findRelNext(`<link rel="next" href="http://127.0.0.1/page/2">`, BASE),
	null,
);
// same-origin private host: origin check passes, validateUrl must drop it
assert.equal(
	findRelNext(`<a rel="next" href="http://10.1.2.3/page/2">x</a>`, "http://10.1.2.3/page/1"),
	null,
);
// allowlisted private host: same-origin next is kept
setPrivateHostAllowlist(["10.1.2.3"]);
assert.equal(
	findRelNext(`<a rel="next" href="http://10.1.2.3/page/2">x</a>`, "http://10.1.2.3/page/1"),
	"http://10.1.2.3/page/2",
);
setPrivateHostAllowlist([]);
assert.equal(
	findRelNext(`<a rel="next" href="http://[::1]/page/2">x</a>`, BASE),
	null,
);
assert.equal(
	findRelNext(`<a rel="next" href="http://ex.com:81/page/2">x</a>`, "http://ex.com:81/page/1"),
	null,
);

// link scan limited to first 64k; anchor beyond it still found
{
	const filler = "<!--" + "x".repeat(70000) + "-->";
	const html = `${filler}<a rel="next" href="https://ex.com/page/2">x</a>`;
	assert.equal(findRelNext(html, BASE), "https://ex.com/page/2");
	const linkBeyond = `${filler}<link rel="next" href="https://ex.com/page/2">`;
	assert.equal(findRelNext(linkBeyond, BASE), null);
}

// missing / malformed
assert.equal(findRelNext(`<a rel="next">no href</a>`, BASE), null);
assert.equal(findRelNext("", BASE), null);
assert.equal(findRelNext(`<a rel="next" href="https://ex.com/page/2">`, "not a url"), null);

// marker + cap
assert.equal(MAX_STITCH_PAGES, 3);
assert.equal(
	stitchPartMarker(2, "https://ex.com/page/2"),
	"\n\n--- part 2: https://ex.com/page/2 ---\n\n",
);

console.log("stitch ok");

/** Host-sticky climb floor + residual challenge refusal. */

import assert from "node:assert/strict";
import {
	blockedNotice,
	challengeFromHeaders,
	clearHostFloors,
	detectBlock,
	getHostFloor,
	liftHostFloor,
	shouldRefuseResidual,
} from "../src/read/block.js";

clearHostFloors();
assert.equal(getHostFloor("https://a.example/x"), "fast");

liftHostFloor("https://a.example/one", "fingerprint");
assert.equal(getHostFloor("https://a.example/two"), "fingerprint");
assert.equal(getHostFloor("https://b.example/"), "fast");

liftHostFloor("https://a.example/three", "fast");
assert.equal(getHostFloor("https://a.example/"), "fingerprint", "floor never lowers");

liftHostFloor("https://a.example/", "browser");
assert.equal(getHostFloor("https://a.example/z"), "browser");

clearHostFloors();
assert.equal(getHostFloor("https://a.example/"), "fast");

assert.equal(detectBlock(403, "<html></html>", "").confidence, "high");
assert.equal(detectBlock(429, "", "").reason, "HTTP 429");
assert.equal(detectBlock(200, "<p>Just a moment… cloudflare</p>", "cloudflare").confidence, "weak");
assert.equal(
	detectBlock(200, "<article>" + "Cloudflare is a CDN. ".repeat(40) + "</article>", "Cloudflare is a CDN. ".repeat(40))
		.confidence,
	"weak",
);
assert.equal(detectBlock(200, "<p>hello</p>", "hello").confidence, "none");
assert.equal(detectBlock(200, "<p>ok</p>", "ok", true).confidence, "high");

assert.equal(shouldRefuseResidual({ confidence: "high", reason: "HTTP 403" }, 8000), true);
assert.equal(shouldRefuseResidual({ confidence: "weak", reason: "body marker" }, 50), true);
assert.equal(shouldRefuseResidual({ confidence: "weak", reason: "body marker" }, 5000), false);
assert.equal(shouldRefuseResidual({ confidence: "none" }, 10), false);

const headers = { get: (n: string) => (n.toLowerCase() === "cf-mitigated" ? "challenge" : null) };
assert.equal(challengeFromHeaders(headers), true);
assert.equal(challengeFromHeaders({ get: () => null }), false);
assert.equal(challengeFromHeaders(undefined), false);

const notice = blockedNotice("https://a.example/", 403, "HTTP 403");
assert.match(notice, /Challenge HTML omitted/);
assert.match(notice, /web_cowork/);

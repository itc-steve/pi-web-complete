/**
 * Deslugify — tests the shipped function (src/read/slug.ts).
 *
 * Run:  npx tsx test/deslugify.test.ts
 */

import assert from "node:assert/strict";
import { deslugify } from "../src/read/slug.js";

// Original 8 assertions from self-check
assert.strictEqual(deslugify("rate-limits"), "rate limits");
assert.strictEqual(deslugify("section-3"), "section");
assert.strictEqual(deslugify("API_Gateway_Config"), "API Gateway Config");
assert.strictEqual(deslugify("a"), "");
assert.strictEqual(deslugify("123"), "");
assert.strictEqual(deslugify("hello%20world"), "hello world");
assert.strictEqual(deslugify("easyPeasy"), "easy Peasy");
assert.strictEqual(deslugify(""), "");

// No throw on lone/malformed percent (URIError from decodeURIComponent)
assert.doesNotThrow(() => deslugify("100%-discount"), "lone % no throw");
assert.doesNotThrow(() => deslugify("a%zz"), "malformed % no throw");

// Quotes stripped from fragment-derived query
assert.strictEqual(deslugify('say-"hello"'), "say hello", "double quotes stripped");
assert.strictEqual(deslugify("it's-a-test"), "it test", "single quotes stripped (a is 1-char, filtered)");
assert.strictEqual(deslugify('"quoted-title"'), "quoted title", "surrounding quotes stripped");

console.log("All deslugify tests passed.");

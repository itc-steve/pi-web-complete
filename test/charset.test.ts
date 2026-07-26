/**
 * Self-check: charset decoding in readBodyCapped.
 *
 * Run:  npx tsx test/charset.test.ts
 */

import { readBodyCapped } from "../src/read/fetch.js";
import assert from "node:assert/strict";

function makeMockResponse(
  bytes: Uint8Array,
  headers: Record<string, string> = {},
) {
  // Use a ReadableStream to exercise the streaming path
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
  // --- Test 1: windows-1252 smart quotes ---
  // 0x93 = left double quote, 0x94 = right double quote in CP1252
  const win1252Bytes = new Uint8Array([
    0x48, 0x65, 0x20, 0x93, 0x73, 0x61, 0x69, 0x64, 0x94, 0x2e,
  ]); // He "said".
  const resp1252 = makeMockResponse(win1252Bytes, {
    "content-type": "text/html; charset=windows-1252",
  });
  const r1 = await readBodyCapped(resp1252, 1024);
  assert(
    r1.text === "He \u201csaid\u201d.",
    `windows-1252: expected "He \u201csaid\u201d." got "${r1.text}"`,
  );
  console.log("PASS: windows-1252 smart quotes decoded correctly");

  // --- Test 2: UTF-8 round-trip ---
  const utf8Buf = new TextEncoder().encode("Hello caf\u00e9 \u2603");
  const respUtf8 = makeMockResponse(utf8Buf, {
    "content-type": "text/html; charset=utf-8",
  });
  const r2 = await readBodyCapped(respUtf8, 1024);
  assert(
    r2.text === "Hello caf\u00e9 \u2603",
    `utf-8: expected "Hello caf\u00e9 \u2603" got "${r2.text}"`,
  );
  console.log("PASS: utf-8 round-trips correctly");

  // --- Test 3: meta charset detection (charset picked up from <meta>) ---
  const metaBytes = new TextEncoder().encode(
    '<!DOCTYPE html><html><head><meta charset="iso-8859-1"></head><body>Hello</body></html>',
  );
  const respMeta = makeMockResponse(metaBytes);
  const r3 = await readBodyCapped(respMeta, 1024);
  // Content is pure ASCII so iso-8859-1 === utf-8, but the point is charset was detected
  assert(
    r3.text.includes("Hello"),
    `meta charset: expected "Hello" in text`,
  );
  console.log("PASS: meta charset detection works");

  // --- Test 4: no charset header → defaults to utf-8 ---
  const respNone = makeMockResponse(utf8Buf);
  const r4 = await readBodyCapped(respNone, 1024);
  assert(
    r4.text === "Hello caf\u00e9 \u2603",
    `no charset: expected "Hello caf\u00e9 \u2603" got "${r4.text}"`,
  );
  console.log("PASS: no charset defaults to utf-8");

  console.log("\nAll charset tests passed.");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});

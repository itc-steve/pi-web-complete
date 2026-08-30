/** Cowork DevTools helper checks. Run: npx tsx test/cowork-devtools.test.ts */

import assert from "node:assert/strict";

import type { Page } from "playwright-core";

import {
	formatCdpJson,
	isBlockedCdpMethod,
	pushBounded,
	redactHeaders,
	resetDevtools,
	sendCdpCommand,
	takeCdpEvents,
} from "../src/cowork/devtools.js";

assert.equal(isBlockedCdpMethod("Fetch.disable"), true);
assert.equal(isBlockedCdpMethod("fetch.disable"), true);
assert.equal(isBlockedCdpMethod("Network.setRequestInterception"), true);
assert.equal(isBlockedCdpMethod("Browser.close"), true);
assert.equal(isBlockedCdpMethod("Target.createBrowserContext"), true);
assert.equal(isBlockedCdpMethod("Target.sendMessageToTarget"), true);
assert.equal(isBlockedCdpMethod("Target.closeTarget"), true);
assert.equal(isBlockedCdpMethod("Target.attachToTarget"), true);
assert.equal(isBlockedCdpMethod("Target.setAutoAttach"), true);
assert.equal(isBlockedCdpMethod("Page.crash"), true);
assert.equal(isBlockedCdpMethod("Browser.crashGpuProcess"), true);
assert.equal(isBlockedCdpMethod("Runtime.evaluate"), false);
assert.equal(isBlockedCdpMethod("Network.getResponseBody"), false);
assert.equal(isBlockedCdpMethod("Network.getAllCookies"), false);

assert.deepEqual(
	redactHeaders({ Authorization: "Bearer secret", Cookie: "sid=secret", Accept: "text/html" }),
	{ Authorization: "[redacted]", Cookie: "[redacted]", Accept: "text/html" },
);

const ring: number[] = [];
pushBounded(ring, 1, 2);
pushBounded(ring, 2, 2);
pushBounded(ring, 3, 2);
assert.deepEqual(ring, [2, 3]);

const formatted = formatCdpJson({ value: "x".repeat(1_000) }, 120);
assert.ok(formatted.length <= 120);
assert.match(formatted, /truncated/);

let eventHandler: ((event: { method: string; params?: object }) => void) | undefined;
const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
const cdp = {
	on: (event: string, handler: typeof eventHandler) => {
		if (event === "event") eventHandler = handler;
	},
	once: () => {},
	send: async (method: string, params?: Record<string, unknown>) => {
		sent.push({ method, params });
		return { ok: true };
	},
	detach: async () => {},
};
const context = { newCDPSession: async () => cdp };
const page = { context: () => context } as unknown as Page;
assert.deepEqual(
	await sendCdpCommand(page, "page", "Runtime.evaluate", { expression: "2 + 2" }),
	{ ok: true },
);
assert.deepEqual(sent, [{ method: "Runtime.evaluate", params: { expression: "2 + 2" } }]);
await assert.rejects(
	() => sendCdpCommand(page, "browser", "Target.createBrowserContext"),
	/can disable URL guards/,
);
await assert.rejects(
	() => sendCdpCommand(page, "page", "Fetch.disable"),
	/can disable URL guards/,
);
await assert.rejects(
	() => sendCdpCommand(page, "page", "Target.closeTarget"),
	/can disable URL guards/,
);
eventHandler?.({ method: "Runtime.consoleAPICalled", params: { type: "log" } });
assert.deepEqual(await takeCdpEvents(page, "page"), [
	{ method: "Runtime.consoleAPICalled", params: { type: "log" } },
]);
await resetDevtools();

console.log("Cowork DevTools checks passed");

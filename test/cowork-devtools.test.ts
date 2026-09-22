/** Cowork DevTools helper checks. Run: npx tsx test/cowork-devtools.test.ts */

import assert from "node:assert/strict";

import type { Page } from "playwright-core";

import {
	emulateDevice,
	coworkDevice,
	captureCoworkScreenshot,
	formatCdpJson,
	isBlockedCdpMethod,
	mobileDeviceMetrics,
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
assert.equal(isBlockedCdpMethod("Emulation.setDeviceMetricsOverride"), false);
assert.equal(isBlockedCdpMethod("Emulation.setUserAgentOverride"), false);
assert.equal(isBlockedCdpMethod("Emulation.clearDeviceMetricsOverride"), false);

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

const metrics = mobileDeviceMetrics();
assert.equal(metrics.mobile, true);
assert.equal(typeof metrics.width, "number");
assert.ok((metrics.width as number) > 0 && (metrics.width as number) < 600);

const emulateSent: Array<{ method: string; params?: Record<string, unknown> }> = [];
const emulateCdp = {
	on: () => {},
	once: () => {},
	send: async (method: string, params?: Record<string, unknown>) => {
		emulateSent.push({ method, params });
		if (method === "Page.captureScreenshot") return { data: Buffer.from("png").toString("base64") };
		if (method === "Page.getLayoutMetrics") return { cssContentSize: { x: 0, y: 0, width: 412, height: 1800 } };
		return {};
	},
	detach: async () => {},
};
const emulatePage = {
	context: () => ({ newCDPSession: async () => emulateCdp }),
} as unknown as Page;

await emulateDevice(emulatePage, "mobile");
const mobileMetricsCall = emulateSent.find((entry) => entry.method === "Emulation.setDeviceMetricsOverride");
assert.equal(mobileMetricsCall?.params?.mobile, true, "mobile:true is the actual Chrome device-mode flag");
assert.equal(
	emulateSent.find((entry) => entry.method === "Emulation.setTouchEmulationEnabled")?.params?.enabled,
	true,
);
assert.equal(
	emulateSent.find((entry) => entry.method === "Emulation.setEmitTouchEventsForMouse")?.params?.enabled,
	true,
);
const mobileUa = emulateSent.find((entry) => entry.method === "Emulation.setUserAgentOverride");
assert.match(String(mobileUa?.params?.userAgent), /Mobile/);
assert.equal((mobileUa?.params?.userAgentMetadata as { mobile?: boolean })?.mobile, true);

assert.equal(coworkDevice(emulatePage), "mobile");
assert.equal(coworkDevice({} as Page), "desktop", "new tabs must not inherit a false mobile label");
assert.equal((await captureCoworkScreenshot(emulatePage)).toString(), "png");
await captureCoworkScreenshot(emulatePage, true);
assert.deepEqual(emulateSent.filter((entry) => entry.method === "Page.captureScreenshot").at(-1), {
	method: "Page.captureScreenshot",
	params: { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 412, height: 1800, scale: 1 } },
});
emulateSent.length = 0;
await emulateDevice(emulatePage, "desktop");
assert.equal(coworkDevice(emulatePage), "desktop");
assert.ok(emulateSent.some((entry) => entry.method === "Emulation.clearDeviceMetricsOverride"));
assert.equal(
	emulateSent.find((entry) => entry.method === "Emulation.setUserAgentOverride")?.params?.userAgent,
	"",
);
await resetDevtools();

console.log("Cowork DevTools checks passed");

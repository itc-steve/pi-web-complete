// Real CloakBrowser regression: npx tsx test/cowork-browser.check.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPersistentContext } from "cloakbrowser";
import { devices } from "playwright-core";
import { emulateDevice, resetDevtools, captureCoworkScreenshot } from "../src/cowork/devtools.js";
import { resolveCoworkHeadless } from "../src/cowork/session.js";

const dir = mkdtempSync(join(tmpdir(), "cowork-mobile-"));
const pixel = devices["Pixel 7"];
const context = await launchPersistentContext({
	userDataDir: dir,
	headless: resolveCoworkHeadless(undefined, "linux", {}),
});
try {
	const page = context.pages()[0]!;
	const url = 'data:text/html,' + encodeURIComponent('<meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}main{width:100vw;background:lightblue;height:1800px}@media(max-width:600px){main{background:lightgreen}}</style><main>Mobile viewport check</main>');
	await page.goto(url);
	await emulateDevice(page, "mobile");
	await page.reload();
	for (const fullPage of [false, true]) {
		const png = await captureCoworkScreenshot(page, fullPage);
		writeFileSync(join(tmpdir(), `cowork-mobile${fullPage ? "-full" : ""}.png`), png);
		assert.ok(Math.abs(png.readUInt32BE(16) - pixel.viewport.width * pixel.deviceScaleFactor) <= 1);
		if (fullPage) assert.ok(png.readUInt32BE(20) > pixel.viewport.height * pixel.deviceScaleFactor);
		const actual = await page.evaluate(() => ({
			width: innerWidth,
			css: document.querySelector("main")!.getBoundingClientRect().width,
			mobile: matchMedia("(max-width:600px)").matches,
			touch: matchMedia("(pointer:coarse)").matches,
		}));
		assert.deepEqual(actual, { width: pixel.viewport.width, css: pixel.viewport.width, mobile: true, touch: true });
		console.log({ fullPage, ...actual });
	}
	await page.goto(url);
	assert.equal(await page.evaluate(() => innerWidth), pixel.viewport.width);
	await emulateDevice(page, "desktop");
	await page.reload();
	await captureCoworkScreenshot(page);
	assert.equal(await page.evaluate(() => matchMedia("(max-width:600px)").matches), false);
	console.log("CloakBrowser CSS viewport, screenshots, navigation and desktop restore passed");
} finally {
	await resetDevtools();
	await context.close();
	rmSync(dir, { recursive: true, force: true });
}

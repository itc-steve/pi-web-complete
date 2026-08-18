#!/usr/bin/env node
/**
 * End-to-end check for the Herdr browser view, without Pi.
 *
 *   npm run verify:herdr -- [url] [--seconds N] [--check]
 *
 * Launches CloakBrowser headless with a CDP port, opens a Herdr pane running the
 * view, and leaves it up so you can click and type in it.
 *
 *   --check       verify graphics + browser launch only, never open a pane
 *   --seconds N   tear down automatically after N seconds (0 = wait for q/Ctrl+C)
 *
 * Needs bun or tsx: node --experimental-strip-types cannot resolve the `.js`
 * import specifiers in src/ to their .ts files.
 */

import { isHerdrPane, requireGraphicsSupport } from "../src/cowork/herdr/socket.js";
import { resolveHerdrConfig } from "../src/cowork/herdr/config.js";
import {
	closeHerdrBrowserPane,
	freePort,
	openHerdrBrowserPane,
	resolveViewRunner,
	waitForCdp,
} from "../src/cowork/herdr/pane.js";

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const value = (name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
const url = argv.find((a) => /^https?:\/\//.test(a)) ?? "https://example.com";
const checkOnly = flag("--check");
const seconds = Number(value("--seconds") ?? 0);
const logPath = "/tmp/pi-herdr-view.log";

function die(message: string): never {
	console.error(`\n✗ ${message}\n`);
	process.exit(1);
}

if (!isHerdrPane()) die("Run this inside a Herdr pane (HERDR_ENV=1 + HERDR_PANE_ID).");
const paneId = process.env.HERDR_PANE_ID!;

console.log(`pane:   ${paneId}`);
console.log(`runner: ${(() => {
	try {
		const runner = resolveViewRunner();
		return [runner.executable, ...runner.args].join(" ");
	} catch (err) {
		return `(none: ${(err as Error).message.split("\n")[0]})`;
	}
})()}`);

console.log("\n1/4 pane graphics support…");
const cell = await requireGraphicsSupport(paneId).catch((err: Error) => die(err.message));
console.log(`    ok — cell ${cell.cellWidthPx}x${cell.cellHeightPx}px`);

console.log("2/4 headless CloakBrowser + CDP port…");
const port = await freePort();
const cloak = await import("cloakbrowser");
const context = await cloak.launchPersistentContext({
	userDataDir: "/tmp/pi-herdr-verify-profile",
	headless: true,
	args: [`--remote-debugging-port=${port}`],
});

let stopped = false;
const teardown = async (code: number, paneToClose?: string) => {
	if (stopped) return;
	stopped = true;
	if (paneToClose) await closeHerdrBrowserPane(paneToClose).catch(() => {});
	await context.close().catch(() => {});
	process.exit(code);
};

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
const endpoint = await waitForCdp(port).catch(async (err: Error) => {
	await teardown(1);
	return die(err.message);
});
console.log(`    ok — ${endpoint}`);

if (checkOnly) {
	console.log("\n✓ graphics + browser both work. Skipping the pane (--check).\n");
	await teardown(0);
}

console.log("3/4 opening the Herdr browser pane…");
const cfg = resolveHerdrConfig({ enabled: true, showDiagnostics: true, focusOnOpen: true });
const pane = await openHerdrBrowserPane({
	cfg,
	cdpEndpoint: endpoint,
	initialUrl: url,
	logPath,
}).catch(async (err: Error) => {
	await teardown(1);
	return die(`${err.message}\n\nview log: ${logPath}`);
});
console.log(`    ok — pane ${pane.paneId}`);

console.log(`
4/4 pane is live. Try it in the browser pane:
  - click a link, scroll with the wheel
  - ctrl+l, type a URL, Enter
  - [+] new tab, [x] close tab
  - ctrl+q closes the view

view log: ${logPath}`);

process.on("SIGINT", () => void teardown(0, pane.paneId));
process.on("SIGTERM", () => void teardown(0, pane.paneId));

if (seconds > 0) {
	console.log(`\nTearing down in ${seconds}s…\n`);
	setTimeout(() => void teardown(0, pane.paneId), seconds * 1000);
} else {
	console.log("\nPress q (or Ctrl+C) here to tear down.\n");
	// Only take over the TTY when there is one; piped runs just wait for a signal.
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", (b: Buffer) => {
			const s = b.toString();
			if (s === "q" || s === "\x03") void teardown(0, pane.paneId);
		});
	}
}

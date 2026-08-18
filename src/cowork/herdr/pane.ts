/**
 * Pi-side management of the Herdr browser pane.
 *
 * Pi owns Chromium (via CloakBrowser) and keeps the Playwright handle so the
 * existing web_cowork actions keep working unchanged. The pane only renders and
 * forwards input, so closing the pane never kills the browser.
 */

import { execFile, execFileSync } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type { ResolvedHerdrConfig } from "./config.js";
import { isHerdrPane } from "./socket.js";

const execFileAsync = promisify(execFile);

const HERDR_BIN = process.env.HERDR_BIN_PATH?.trim() || "herdr";

function viewEntrypoint(): string {
	// dist/ and src/ both resolve relative to this module.
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "view-main.ts");
}

/** Ask the OS for a free loopback port. */
export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") {
				const { port } = address;
				server.close(() => resolve(port));
			} else {
				server.close(() => reject(new Error("could not resolve a free port")));
			}
		});
	});
}

export function validateCdpVersion(body: unknown, port: number): boolean {
	if (!body || typeof body !== "object") return false;
	const raw = (body as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
	if (typeof raw !== "string") return false;
	try {
		const url = new URL(raw);
		return url.protocol === "ws:" && url.hostname === "127.0.0.1" && url.port === String(port);
	} catch {
		return false;
	}
}

/** Wait until the expected loopback Chrome CDP endpoint answers. */
export async function waitForCdp(port: number, timeoutMs = 15_000): Promise<string> {
	const endpoint = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + timeoutMs;
	let lastError = "no response";
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${endpoint}/json/version`, {
				signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, deadline - Date.now()))),
			});
			if (res.ok && validateCdpVersion(await res.json(), port)) return endpoint;
			lastError = res.ok ? "invalid Chrome identity" : `HTTP ${res.status}`;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`CDP endpoint ${endpoint} never became ready (${lastError})`);
}

export interface OpenPaneResult {
	paneId: string;
	cdpEndpoint: string;
}

interface HerdrPaneEnvelope {
	result?: { pane?: { pane_id?: string } };
	error?: { code?: string; message?: string };
}

function commandExists(bin: string): boolean {
	try {
		// execFileSync without shell: no argument interpolation.
		execFileSync("/usr/bin/env", ["sh", "-c", `command -v "$1"`, "sh", bin], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Which runtime runs the TypeScript view.
 *
 * The view imports with NodeNext `.js` specifiers that resolve to `.ts` files,
 * which `node --experimental-strip-types` does NOT rewrite (ERR_MODULE_NOT_FOUND).
 * So a resolver-aware runtime is required: bun or tsx.
 */
export interface ViewRunner {
	executable: string;
	args: string[];
}

export function resolveViewRunner(): ViewRunner {
	const override = process.env.PI_HERDR_VIEW_RUNNER?.trim();
	if (override) return { executable: override, args: [] };
	if (commandExists("bun")) return { executable: "bun", args: [] };
	return {
		executable: process.execPath,
		args: [fileURLToPath(import.meta.resolve("tsx/cli"))],
	};
}

export function shellQuote(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

function viewCommand(entry: string): string {
	const runner = resolveViewRunner();
	return [runner.executable, ...runner.args, entry].map(shellQuote).join(" ");
}

/**
 * Split the current pane and start the view inside it.
 * Returns the new pane id. Throws with actionable text when not under Herdr.
 */
export async function openHerdrBrowserPane(opts: {
	cfg: ResolvedHerdrConfig;
	cdpEndpoint: string;
	initialUrl?: string;
	logPath?: string;
}): Promise<OpenPaneResult> {
	if (!isHerdrPane()) {
		throw new Error(
			"Not running inside a Herdr pane (HERDR_ENV / HERDR_PANE_ID unset). " +
				"Set cowork.herdr.enabled=false, or start Pi inside Herdr.",
		);
	}

	const readyPath = join(tmpdir(), `pi-herdr-ready-${randomUUID()}`);
	const env: Record<string, string> = {
		PI_HERDR_VIEW_CDP: opts.cdpEndpoint,
		PI_HERDR_VIEW_READY: readyPath,
		PI_HERDR_VIEW_SCALE: String(opts.cfg.captureScale),
		PI_HERDR_VIEW_NTH: String(opts.cfg.screencastEveryNthFrame),
		PI_HERDR_VIEW_ZOOM: String(opts.cfg.browserZoom),
		PI_HERDR_VIEW_DIAG: opts.cfg.showDiagnostics ? "1" : "0",
	};
	if (opts.initialUrl) env.PI_HERDR_VIEW_URL = opts.initialUrl;
	if (opts.logPath) env.PI_HERDR_VIEW_LOG = opts.logPath;

	const args = ["pane", "split", "--current", "--direction", opts.cfg.direction];
	if (opts.cfg.focusOnOpen) args.push("--focus");
	for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);

	const { stdout } = await execFileAsync(HERDR_BIN, args, { timeout: 10_000 });
	let envelope: HerdrPaneEnvelope;
	try {
		envelope = JSON.parse(stdout.trim()) as HerdrPaneEnvelope;
	} catch {
		throw new Error(`herdr pane split returned unparseable output: ${stdout.slice(0, 200)}`);
	}
	if (envelope.error) {
		throw new Error(envelope.error.message ?? "herdr pane split failed");
	}
	const paneId = envelope.result?.pane?.pane_id;
	if (!paneId) throw new Error("herdr pane split returned no pane id");

	await execFileAsync(
		HERDR_BIN,
		["pane", "rename", paneId, "browser"],
		{ timeout: 5_000 },
	).catch(() => {});

	try {
		await execFileAsync(
			HERDR_BIN,
			["pane", "run", paneId, viewCommand(viewEntrypoint())],
			{ timeout: 10_000 },
		);
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			if (await access(readyPath).then(() => true, () => false)) {
				await rm(readyPath, { force: true });
				return { paneId, cdpEndpoint: opts.cdpEndpoint };
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("Herdr browser view did not become ready");
	} catch (err) {
		await closeHerdrBrowserPane(paneId);
		throw err;
	} finally {
		await rm(readyPath, { force: true });
	}
}

export async function closeHerdrBrowserPane(paneId: string): Promise<void> {
	await execFileAsync(HERDR_BIN, ["pane", "close", paneId], { timeout: 5_000 }).catch(() => {});
}

export async function paneExists(paneId: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(HERDR_BIN, ["pane", "get", paneId], { timeout: 5_000 });
		return !JSON.parse(stdout.trim()).error;
	} catch {
		return false;
	}
}

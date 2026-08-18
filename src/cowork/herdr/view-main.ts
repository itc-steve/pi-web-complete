#!/usr/bin/env node
/**
 * Entrypoint for the in-pane browser view. Kept separate from view.ts so the
 * logic stays importable by tests without spawning a terminal.
 *
 * Failures print a readable message and hold the pane open long enough to read
 * it (a pane that closes instantly hides its own error).
 */

import { runView } from "./view.js";

runView().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	process.stdout.write(`\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l`);
	console.error(`\npi-web-complete herdr view failed:\n\n${message}\n`);
	console.error("This pane stays open for 30s so the error is readable.\n");
	setTimeout(() => process.exit(1), 30_000);
});

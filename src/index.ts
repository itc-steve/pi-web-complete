/**
 * pi-web-complete — web_search (random multi-backend) + local web_read (CloakBrowser)
 * + web_cowork (shared-control visible session).
 *
 * Config: ~/.pi/agent/web.json + .pi/web.json (project wins; legacy search.json still read)
 * Secrets:  ~/.pi/agent/web.env  + .pi/web.env  via apiKeyEnv (process.env wins; legacy apiKey ok)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { refreshConfig } from "./config.js";
import { clearCooldowns } from "./utils.js";
import { registerWebSearch } from "./search/web-search.js";
import { registerWebRead } from "./read/web-read.js";
import { closeAllBrowsers } from "./read/browser.js";
import { registerWebCowork } from "./cowork/web-cowork.js";
import { closeCoworkSession } from "./cowork/session.js";
import { resetSessionStatus } from "./status.js";

let cleanupWired = false;

function wireCleanupHooks(): void {
	if (cleanupWired) return;
	cleanupWired = true;
	const cleanup = () => {
		void closeAllBrowsers();
		void closeCoworkSession();
	};
	process.once("SIGTERM", cleanup);
	process.once("SIGINT", cleanup);
	process.once("beforeExit", cleanup);
}

export default function (pi: ExtensionAPI): void {
	registerWebSearch(pi);
	registerWebRead(pi);
	registerWebCowork(pi);
	wireCleanupHooks();

	pi.on("session_start", (_event, ctx) => {
		clearCooldowns();
		refreshConfig(ctx.cwd, true);
		// Footer stays empty until search / cowork / read is actually used.
		resetSessionStatus(ctx.ui);
	});
}

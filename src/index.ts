/**
 * pi-web-complete — web_search (random multi-backend) + local web_read (CloakBrowser)
 * + web_cowork (shared-control headed or headless session).
 *
 * Config: ~/.pi/agent/web.json + .pi/web.json (project wins; legacy search.json still read)
 * Secrets:  ~/.pi/agent/web.env  + .pi/web.env  via apiKeyEnv (process.env wins; legacy apiKey ok)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { refreshConfig } from "./config.js";
import { clearHostFloors } from "./read/block.js";
import { clearCooldowns, installCloakLogFilter } from "./utils.js";
import { registerWebSearch } from "./search/web-search.js";
import { registerWebRead } from "./read/web-read.js";
import { closeAllBrowsers } from "./read/browser.js";
import { registerWebCowork } from "./cowork/web-cowork.js";
import { registerContext7 } from "./context7/context7.js";
import { config } from "./config.js";
import { resolveContext7Key } from "./credentials.js";
import { closeCoworkSession, isCoworkSessionOpen } from "./cowork/session.js";
import { resetSessionStatus } from "./status.js";
import { WEB_TOOL_BY_TARGET, isToolActive, parseWebCommand, setToolEnabled } from "./toggle.js";

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
	// cloakbrowser update notices via console.* would corrupt Pi's TUI rendering.
	installCloakLogFilter();
	registerWebSearch(pi);
	registerWebRead(pi);
	registerWebCowork(pi);
	// Only expose context7 when a key is configured — no dead tool in the prompt.
	refreshConfig(process.cwd(), true);
	if (resolveContext7Key(config)) registerContext7(pi);
	wireCleanupHooks();

	// Per-session default from web.json: both tools start on unless disabled in config.
	pi.on("session_start", (_event, ctx) => {
		clearCooldowns();
		clearHostFloors();
		refreshConfig(ctx.cwd, true);
		setToolEnabled(pi, "search", config.search?.enabled !== false ? "on" : "off");
		setToolEnabled(pi, "cowork", config.cowork?.enabled !== false ? "on" : "off");
		// Footer stays empty until a service is actually used this session.
		resetSessionStatus(ctx.ui);
	});

	// Runtime toggles: /web [search|cowork] [on|off] — bare target flips the state.
	pi.registerCommand("web", {
		description:
			"Toggle web_search / web_cowork for this session: /web [search|cowork] [on|off]",
		getArgumentCompletions: (prefix) => {
			const items = ["search", "cowork", "on", "off"].map((value) => ({
				value,
				label: value,
			}));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const cmd = parseWebCommand(args);
			if (cmd.target === "status") {
				ctx.ui.notify(
					`web tools — search: ${isToolActive(pi, "search") ? "on" : "off"} · ` +
						`cowork: ${isToolActive(pi, "cowork") ? "on" : "off"} · ` +
						`browser: ${isCoworkSessionOpen() ? "open" : "closed"}`,
					"info",
				);
				return;
			}
			const next = setToolEnabled(pi, cmd.target, cmd.state);
			let message = `${WEB_TOOL_BY_TARGET[cmd.target]} ${next === "on" ? "enabled" : "disabled"} for this session`;
			if (cmd.target === "cowork" && next === "off" && isCoworkSessionOpen()) {
				message += " (shared browser session stays open)";
			}
			ctx.ui.notify(message, "info");
		},
	});
}

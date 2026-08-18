/** Herdr browser-view config resolution + defaults. */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HerdrCoworkConfig } from "../../types.js";

export interface ResolvedHerdrConfig {
	enabled: boolean;
	direction: "right" | "down";
	focusOnOpen: boolean;
	browserZoom: number;
	showDiagnostics: boolean;
	captureScale: number;
	screencastEveryNthFrame: 1 | 2;
	/** Fall back to a normal desktop window when the pane view can't start. */
	fallbackToWindow: boolean;
	cdpPort: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function resolveHerdrConfig(raw: HerdrCoworkConfig | undefined): ResolvedHerdrConfig {
	const cfg = raw ?? {};
	const nth = num(cfg.screencastEveryNthFrame, 1) >= 2 ? 2 : 1;
	return {
		enabled: cfg.enabled === true,
		direction: cfg.direction === "down" ? "down" : "right",
		focusOnOpen: cfg.focusOnOpen !== false,
		browserZoom: clamp(num(cfg.browserZoom, 0.75), 0.5, 2.5),
		showDiagnostics: cfg.showDiagnostics === true,
		captureScale: clamp(num(cfg.captureScale, 1), 0.1, 1),
		screencastEveryNthFrame: nth as 1 | 2,
		fallbackToWindow: cfg.fallbackToWindow !== false,
		cdpPort: clamp(Math.floor(num(cfg.cdpPort, 0)), 0, 65_535),
	};
}

export function expandHome(path: string): string {
	if (path.startsWith("~/") || path === "~") {
		return resolve(homedir(), path.slice(2) || ".");
	}
	return path;
}

/** Where the view writes its own log; handy when a pane dies instantly. */
export function viewLogPath(): string {
	return join(homedir(), ".cloakbrowser", "herdr-view.log");
}

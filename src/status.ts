/** Session-scoped footer status — only show what was actually used. */

import type { BackendName } from "./types.js";
import { config } from "./config.js";

/** Minimal UI surface needed for footer updates. */
export interface StatusUI {
	setStatus(key: string, status: string): void;
}

/** Backends that returned results this Pi session. */
const usedSearchBackends = new Set<BackendName>();

function statusEnabled(): boolean {
	return config.showStatus !== false;
}

/** Clear all extension footer keys at session start. */
export function resetSessionStatus(ui: StatusUI): void {
	usedSearchBackends.clear();
	if (!statusEnabled()) return;
	ui.setStatus("search", "");
	ui.setStatus("cowork", "");
	ui.setStatus("read", "");
}

/** Record a successful search backend and refresh the search footer. */
export function noteSearchBackendUsed(ui: StatusUI, backend: BackendName): void {
	usedSearchBackends.add(backend);
	refreshSearchStatus(ui);
}

export function refreshSearchStatus(ui: StatusUI): void {
	if (!statusEnabled()) return;
	if (usedSearchBackends.size === 0) {
		ui.setStatus("search", "");
		return;
	}
	const list = [...usedSearchBackends].join(", ");
	ui.setStatus("search", `search: ${list}`);
}

/** Transient progress while a search is in flight; settles via noteSearchBackendUsed. */
export function setSearchProgress(ui: StatusUI, message: string): void {
	if (!statusEnabled()) return;
	ui.setStatus("search", message);
}

/** Show cowork only while a session is open; clear when closed. */
export function setCoworkStatus(ui: StatusUI, open: boolean, detail?: string): void {
	if (!statusEnabled()) return;
	if (!open) {
		ui.setStatus("cowork", "");
		return;
	}
	ui.setStatus("cowork", detail?.trim() || "cowork: open");
}

/** Transient read progress; clear when the read finishes. */
export function setReadStatus(ui: StatusUI, message: string | null): void {
	if (!statusEnabled()) return;
	ui.setStatus("read", message ?? "");
}

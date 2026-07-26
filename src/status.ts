/** Session-scoped footer status — only show what was actually used. */

import type { BackendName } from "./types.js";
import { config } from "./config.js";

/** Minimal UI surface needed for footer updates. */
export interface StatusUI {
	setStatus(key: string, status: string): void;
}

/**
 * Services that successfully returned data this Pi session.
 * Search backends (brave, serper, …) and context7 share one clean list.
 */
const usedServices = new Set<string>();

function statusEnabled(): boolean {
	return config.showStatus !== false;
}

/** Clear all extension footer keys at session start. */
export function resetSessionStatus(ui: StatusUI): void {
	usedServices.clear();
	if (!statusEnabled()) return;
	ui.setStatus("services", "");
	// Clear legacy keys from older sessions / hot reload.
	ui.setStatus("search", "");
	ui.setStatus("context7", "");
	ui.setStatus("cowork", "");
	ui.setStatus("read", "");
}

/** Re-render the settled services list (sorted, names only). */
export function refreshServicesStatus(ui: StatusUI): void {
	if (!statusEnabled()) return;
	if (usedServices.size === 0) {
		ui.setStatus("services", "");
		return;
	}
	ui.setStatus("services", [...usedServices].sort().join(", "));
}

/** Record a successful service and refresh the shared services footer. */
export function noteServiceUsed(ui: StatusUI, service: string): void {
	usedServices.add(service);
	refreshServicesStatus(ui);
}

/** Record a successful search backend. */
export function noteSearchBackendUsed(ui: StatusUI, backend: BackendName): void {
	noteServiceUsed(ui, backend);
}

/** Re-render settled list after a failed search attempt. */
export function refreshSearchStatus(ui: StatusUI): void {
	refreshServicesStatus(ui);
}

/** Transient progress while a search/docs fetch is in flight. */
export function setServiceProgress(ui: StatusUI, message: string): void {
	if (!statusEnabled()) return;
	ui.setStatus("services", message);
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

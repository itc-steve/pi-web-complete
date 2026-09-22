/** One below-editor chip. Never leave empty setStatus keys — those become blank footer lines. */

import type { BackendName } from "./types.js";
import { config } from "./config.js";

/** Minimal UI surface needed for footer updates. */
export interface StatusUI {
	setStatus?(key: string, status: string | undefined): void;
	setWidget?(
		key: string,
		content: string[] | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
}

const KEY = "web";
const LEGACY_STATUS_KEYS = ["services", "search", "context7", "cowork", "read", KEY];

/**
 * Services that successfully returned data this Pi session.
 * Search backends (brave, serper, …) and context7 share one chip.
 */
const usedServices = new Set<string>();
let overlay: string | undefined;
let cowork: string | undefined;

function statusEnabled(): boolean {
	return config.showStatus !== false;
}

function chipText(): string | undefined {
	if (overlay) return overlay;
	const parts = [...usedServices].sort();
	if (cowork) parts.push(cowork);
	return parts.length ? parts.join(", ") : undefined;
}

function dropStatusKeys(ui: StatusUI): void {
	if (!ui.setStatus) return;
	for (const key of LEGACY_STATUS_KEYS) ui.setStatus(key, undefined);
}

function paint(ui: StatusUI): void {
	if (!statusEnabled()) return;
	dropStatusKeys(ui);
	if (!ui.setWidget) return;
	const text = chipText();
	if (!text) {
		ui.setWidget(KEY, undefined);
		return;
	}
	ui.setWidget(KEY, [text], { placement: "belowEditor" });
}

/** Clear all extension footer keys at session start. */
export function resetSessionStatus(ui: StatusUI): void {
	usedServices.clear();
	overlay = undefined;
	cowork = undefined;
	dropStatusKeys(ui);
	ui.setWidget?.(KEY, undefined);
}

/** Re-render the settled services list (sorted, names only). */
export function refreshServicesStatus(ui: StatusUI): void {
	overlay = undefined;
	paint(ui);
}

/** Record a successful service and refresh the shared chip. */
export function noteServiceUsed(ui: StatusUI, service: string): void {
	usedServices.add(service);
	overlay = undefined;
	paint(ui);
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
	overlay = message;
	paint(ui);
}

/** Show cowork only while a session is open; clear when closed. */
export function setCoworkStatus(ui: StatusUI, open: boolean, detail?: string): void {
	cowork = open ? detail?.trim() || "cowork" : undefined;
	paint(ui);
}

/** Transient read progress; clear when the read finishes. */
export function setReadStatus(ui: StatusUI, message: string | null): void {
	overlay = message ?? undefined;
	paint(ui);
}

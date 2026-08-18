/**
 * Toolbar rendering + hit testing for the Herdr browser pane.
 *
 * Row 0: tab strip (tab titles, [x] close, [+] new).
 * Row 1: controls (back/forward/reload/stop, zoom, URL).
 * Pure string building so hit regions and paint stay in sync and testable.
 */

export interface TabEntry {
	targetId: string;
	title: string;
	active: boolean;
}

export type ToolbarAction =
	| { kind: "select-tab"; targetId: string }
	| { kind: "close-tab"; targetId: string }
	| { kind: "new-tab" }
	| { kind: "back" }
	| { kind: "forward" }
	| { kind: "reload" }
	| { kind: "stop" }
	| { kind: "zoom-out" }
	| { kind: "zoom-in" }
	| { kind: "focus-url" };

interface Region {
	row: number;
	start: number;
	end: number;
	action: ToolbarAction;
}

export interface ToolbarState {
	tabs: TabEntry[];
	url: string;
	zoom: number;
	loading: boolean;
	/** URL edit mode: the buffer being typed. */
	urlEditing?: string;
}

export interface RenderedToolbar {
	lines: string[];
	regions: Region[];
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const ACTIVE = "\x1b[7m";

function pad(text: string, width: number): string {
	if (text.length >= width) return text.slice(0, width);
	return text + " ".repeat(width - text.length);
}

export function sanitizeTerminalText(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "�");
}

function truncate(text: string, max: number): string {
	if (max <= 0) return "";
	if (text.length <= max) return text;
	return max <= 1 ? text.slice(0, max) : `${text.slice(0, max - 1)}…`;
}

/**
 * Build both toolbar rows and the clickable regions.
 * `cols` is the pane width in cells; columns in regions are 0-based.
 */
export function renderToolbar(state: ToolbarState, cols: number): RenderedToolbar {
	const regions: Region[] = [];

	// --- row 0: tab strip ---
	// [+] must always stay clickable, so its 4 columns are reserved up front and
	// tabs may only use what is left. Each tab costs label + 2 spaces + "[x]".
	const NEW_TAB = " [+]";
	const TAB_CHROME = 5; // leading space, trailing space, "[x]"
	const MIN_LABEL = 3;

	let row0 = "";
	let col = 0;
	const tabBudget = Math.max(0, cols - NEW_TAB.length);
	const share = Math.floor(tabBudget / Math.max(1, state.tabs.length));

	for (const tab of state.tabs) {
		const remaining = tabBudget - col;
		const labelWidth = Math.min(share - TAB_CHROME, remaining - TAB_CHROME);
		if (labelWidth < MIN_LABEL) break; // no room for another readable tab
		const label = truncate(sanitizeTerminalText(tab.title || "new tab"), labelWidth);
		const cellText = ` ${pad(label, labelWidth)} `;

		regions.push({
			row: 0,
			start: col,
			end: col + cellText.length - 1,
			action: { kind: "select-tab", targetId: tab.targetId },
		});
		row0 += tab.active ? `${ACTIVE}${cellText}${RESET}` : `${DIM}${cellText}${RESET}`;
		col += cellText.length;

		const close = "[x]";
		regions.push({
			row: 0,
			start: col,
			end: col + close.length - 1,
			action: { kind: "close-tab", targetId: tab.targetId },
		});
		row0 += close;
		col += close.length;
	}

	// Pad so [+] sits at a stable position and always inside the pane.
	if (col < tabBudget) {
		row0 += " ".repeat(tabBudget - col);
		col = tabBudget;
	}
	regions.push({
		row: 0,
		start: col,
		end: Math.min(col + NEW_TAB.length - 1, cols - 1),
		action: { kind: "new-tab" },
	});
	row0 += NEW_TAB;

	// --- row 1: controls ---
	const buttons: Array<{ text: string; action: ToolbarAction }> = [
		{ text: "[<]", action: { kind: "back" } },
		{ text: "[>]", action: { kind: "forward" } },
		state.loading
			? { text: "[x]", action: { kind: "stop" } }
			: { text: "[r]", action: { kind: "reload" } },
		{ text: "[-]", action: { kind: "zoom-out" } },
		{ text: "[+]", action: { kind: "zoom-in" } },
	];

	let row1 = "";
	let c1 = 0;
	for (const btn of buttons) {
		regions.push({
			row: 1,
			start: c1,
			end: c1 + btn.text.length - 1,
			action: btn.action,
		});
		row1 += btn.text;
		c1 += btn.text.length;
		row1 += " ";
		c1 += 1;
	}

	const zoomLabel = `${Math.round(state.zoom * 100)}% `;
	row1 += `${DIM}${zoomLabel}${RESET}`;
	c1 += zoomLabel.length;

	const editing = state.urlEditing !== undefined;
	const urlWidth = Math.max(0, cols - c1);
	const urlText = editing
		? truncate(sanitizeTerminalText(state.urlEditing ?? ""), Math.max(0, urlWidth - 1))
		: truncate(sanitizeTerminalText(state.url), urlWidth);
	regions.push({
		row: 1,
		start: c1,
		end: cols - 1,
		action: { kind: "focus-url" },
	});
	row1 += editing ? `${ACTIVE}${pad(`${urlText}█`, urlWidth)}${RESET}` : pad(urlText, urlWidth);

	return { lines: [row0, row1], regions };
}

/** Which toolbar action a click hits, if any. 0-based row/col. */
export function hitTest(
	regions: Region[],
	row: number,
	col: number,
): ToolbarAction | null {
	// Later regions are drawn on top of earlier ones.
	for (let i = regions.length - 1; i >= 0; i--) {
		const r = regions[i]!;
		if (r.row === row && col >= r.start && col <= r.end) return r.action;
	}
	return null;
}

/**
 * Runtime toggles for the web_search / web_cowork tools.
 * Pure helpers over an active-tool surface; pi wiring lives in index.ts.
 */

export type WebToggleTarget = "search" | "cowork";

export const WEB_TOOL_BY_TARGET: Record<WebToggleTarget, string> = {
	search: "web_search",
	cowork: "web_cowork",
};

/** Minimal active-tool surface (pi.getActiveTools / pi.setActiveTools). */
export interface ToolActivator {
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
}

export type ToggleState = "on" | "off";

/** Parsed `/web ...` command: status, or a target with explicit state or toggle. */
export interface WebCommand {
	target: "status" | WebToggleTarget;
	state: ToggleState | "toggle";
}

/** `/web [search|cowork] [on|off]` — bare target toggles; anything else is status. */
export function parseWebCommand(args: string): WebCommand {
	const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const head = parts[0];
	if (head === "search" || head === "cowork") {
		const state = parts[1];
		return {
			target: head,
			state: state === "on" || state === "off" ? state : "toggle",
		};
	}
	return { target: "status", state: "toggle" };
}

export function isToolActive(api: ToolActivator, target: WebToggleTarget): boolean {
	return api.getActiveTools().includes(WEB_TOOL_BY_TARGET[target]);
}

/** Enable/disable/toggle one tool without disturbing any other active tool. */
export function setToolEnabled(
	api: ToolActivator,
	target: WebToggleTarget,
	state: ToggleState | "toggle",
): ToggleState {
	const name = WEB_TOOL_BY_TARGET[target];
	const next = state === "toggle" ? !isToolActive(api, target) : state === "on";
	const active = new Set(api.getActiveTools());
	if (next) active.add(name);
	else active.delete(name);
	api.setActiveTools([...active]);
	return next ? "on" : "off";
}

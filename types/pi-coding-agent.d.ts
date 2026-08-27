/**
 * Ambient type declarations for @earendil-works/pi-coding-agent (optional peer dep).
 * Subset used by pi-web-complete — not a full SDK mirror.
 */

declare module "@earendil-works/pi-coding-agent" {
	export interface UISelectOption {
		label: string;
		description?: string;
	}

	export interface UIInputOptions {
		signal?: AbortSignal;
		timeout?: number;
	}

	export interface UI {
		notify(message: string, type?: "info" | "warn" | "error" | "success"): void;
		setStatus(key: string, status: string): void;
		select<T extends string>(label: string, options: T[]): Promise<T | undefined>;
		select<T extends UISelectOption>(label: string, options: T[]): Promise<T | undefined>;
		input(label: string, placeholder?: string, options?: UIInputOptions): Promise<string | undefined>;
	}

	export interface ContextUsage {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	}

	export interface ExtensionContext {
		cwd: string;
		hasUI: boolean;
		ui: UI;
		getContextUsage?: () => ContextUsage | undefined;
	}

	export interface ToolParameter {
		name: string;
		label: string;
		description: string;
		promptSnippet: string;
		promptGuidelines?: string[];
		parameters: unknown;
		executionMode?: "parallel" | "sequential";
		execute: (
			toolCallId: string,
			params: any,
			signal: AbortSignal,
			onUpdate: (update: { content: Array<{ type: string; text: string }> }) => void,
			ctx: ExtensionContext,
		) => Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;
	}

	export interface Command {
		description: string;
		handler: (args: string[], ctx: ExtensionContext) => Promise<void>;
	}

	export interface ToolResultEvent {
		type: "tool_result";
		toolCallId: string;
		toolName: string;
		input: Record<string, unknown>;
		content: Array<{ type: string; text?: string }>;
		isError: boolean;
		details?: unknown;
	}

	export interface ToolResultEventResult {
		content?: Array<{ type: string; text?: string }>;
		details?: unknown;
		isError?: boolean;
	}

	export interface ToolCallEvent {
		type: "tool_call";
		toolName: string;
		input: Record<string, unknown>;
	}

	export interface ToolCallEventResult {
		block?: boolean;
		reason?: string;
	}

	export interface SessionStartEvent {
		type: "session_start";
		reason?: string;
	}

	export interface SessionCompactEvent {
		type: "session_compact";
	}

	export interface ExtensionAPI {
		registerTool(config: ToolParameter): void;
		registerCommand(name: string, config: Command): void;
		getActiveTools?(): string[];
		on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionContext) => void): void;
		on(event: "session_compact", handler: (event: SessionCompactEvent, ctx: ExtensionContext) => void): void;
		on(
			event: "tool_call",
			handler: (
				event: ToolCallEvent,
				ctx: ExtensionContext,
			) => ToolCallEventResult | void | Promise<ToolCallEventResult | void>,
		): void;
		on(
			event: "tool_result",
			handler: (
				event: ToolResultEvent,
				ctx: ExtensionContext,
			) => ToolResultEventResult | void | Promise<ToolResultEventResult | void>,
		): void;
	}
}

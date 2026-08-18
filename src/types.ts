/** Shared types for pi-web-complete. */

export type BackendName = "brave" | "serper" | "tavily" | "exa" | "linkup";

export const BACKEND_NAMES: readonly BackendName[] = [
	"brave",
	"serper",
	"tavily",
	"exa",
	"linkup",
] as const;

export interface BackendConfig {
	enabled?: boolean;
	/**
	 * Env var *name* holding the API key (like pi-fgt tokenEnv).
	 * Resolved from process.env, then ~/.pi/agent/web.env / .pi/web.env.
	 * Never put the secret value here — only the name, e.g. "BRAVE_API_KEY".
	 */
	apiKeyEnv?: string;
	/**
	 * @deprecated Prefer apiKeyEnv + web.env. Literal key still accepted for backcompat.
	 */
	apiKey?: string;
	/** Per-backend timeout override in milliseconds. Default: 30000 */
	timeout?: number;
	/** Per-backend max results override. Default: 10 */
	maxResults?: number;
	/** Linkup-specific: search depth — "standard" (fast) or "deep". Default: standard */
	depth?: "standard" | "deep";
}

export type ReadMode = "auto" | "fast" | "fingerprint" | "readable" | "browser";
export type ReadFormat = "markdown" | "text" | "html";
/** Chat return shape: ranked excerpts (default) or full main-content body. */
export type ReadReturnMode = "excerpts" | "full";

export interface ReadConfig {
	defaultMode?: ReadMode;
	defaultFormat?: ReadFormat;
	/** Chat default when not saving. Default: excerpts. */
	defaultReturn?: ReadReturnMode;
	onlyMainContent?: boolean;
	removeImages?: boolean;
	maxChars?: number;
	/** Char budget for excerpt chat returns. Default: 6000. */
	excerptMaxChars?: number;
	/** Max download size in bytes (floored at 2MB; default 5MB). */
	maxBytes?: number;
	timeoutSeconds?: number;
	/**
	 * CloakBrowser visibility. Default true (no window).
	 * Set false to watch the browser while it renders the page.
	 */
	headless?: boolean;
}

export interface Context7Config {
	/** Register the context7 tool. Default: true when a key resolves. */
	enabled?: boolean;
	/** Env var *name* holding the Context7 API key, e.g. "CONTEXT7_API_KEY". */
	apiKeyEnv?: string;
	/** @deprecated Prefer apiKeyEnv + web.env. */
	apiKey?: string;
	/** Request timeout in milliseconds. Default: 30000 */
	timeout?: number;
	/** Skip LLM reranking by default (faster, less relevant). Default: false */
	fast?: boolean;
}

/**
 * Render the cowork browser inside a Herdr pane instead of a desktop window.
 *
 * Requires Herdr >= 0.7.4 with `[experimental] kitty_graphics = true`, a
 * Kitty-graphics terminal (Ghostty, kitty, WezTerm), and a Herdr client that
 * attached *after* the flag was enabled (an older client reports a 0px cell
 * size and frames are dropped).
 */
export interface HerdrCoworkConfig {
	/** Master switch. Default false — cowork opens a normal window. */
	enabled?: boolean;
	/** Split direction when placement="split". Default "right". */
	direction?: "right" | "down";
	/** Focus the browser pane when it opens. Default true. */
	focusOnOpen?: boolean;
	/** Initial page zoom, 0.5–2.5. Default 0.75. */
	browserZoom?: number;
	/** Reserve a bottom row with stream/viewport metrics. Default false. */
	showDiagnostics?: boolean;
	/** Shrink transferred frames, 0.1–1. Default 1. Lower = less CPU. */
	captureScale?: number;
	/** 1 or 2; 2 halves the producer frame rate. Default 1. */
	screencastEveryNthFrame?: 1 | 2;
	/**
	 * When the pane view cannot start (no Herdr, graphics disabled, old client),
	 * fall back to a normal desktop window instead of failing. Default true.
	 */
	fallbackToWindow?: boolean;
	/** Fixed CDP port. Default 0 = pick a free port. */
	cdpPort?: number;
}

export interface CoworkConfig {
	/**
	 * Persistent Chromium profile for web_cowork.
	 * Default: ~/.cloakbrowser/cowork-profile
	 */
	userDataDir?: string;
	/**
	 * Directory for browser downloads. Default: ~/Downloads
	 */
	downloadDir?: string;
	/** Render the browser inside a Herdr pane (opt-in). */
	herdr?: HerdrCoworkConfig;
}

export interface SearchConfig {
	/** Tool default when `backend` param omitted. `"auto"` = random shuffle. */
	defaultBackend?: BackendName | "auto";
	compact?: boolean;
	/**
	 * Footer status updates. Default true.
	 * When true, only shows backends / cowork actually used this session
	 * (not the full enabled list, never "cowork: closed").
	 */
	showStatus?: boolean;
	numResults?: number;
	read?: ReadConfig;
	/** Up-to-date library docs via context7.com. */
	context7?: Context7Config;
	/** Shared-control visible CloakBrowser session (web_cowork). */
	cowork?: CoworkConfig;
	backends?: {
		brave?: BackendConfig;
		serper?: BackendConfig;
		tavily?: BackendConfig;
		exa?: BackendConfig;
		linkup?: BackendConfig;
	};
}

export interface SearchResult {
	title: string;
	url: string;
	snippet?: string;
	content?: string;
}

export interface BackendRunner {
	label: string;
	search: (
		query: string,
		numResults: number,
		deps: {
			key?: string;
			signal?: AbortSignal;
			backendConfig?: BackendConfig;
		},
	) => Promise<{ results: SearchResult[] }>;
}

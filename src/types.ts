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
	/** Run without an external desktop window. Default false. */
	headless?: boolean;
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
	/** Exact private hostnames permitted by web_read and web_cowork. Default: none. */
	allowPrivateHosts?: string[];
	read?: ReadConfig;
	/** Up-to-date library docs via context7.com. */
	context7?: Context7Config;
	/** Shared-control headed or headless CloakBrowser session (web_cowork). */
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

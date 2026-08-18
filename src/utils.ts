/** Shared utilities for pi-web-complete. */

import { join } from "node:path";

export const HTTP_TIMEOUT_MS = 30_000;
export const COOLDOWN_MS = 2_000;

export const MISSING_KEY_HELP =
	"Set apiKeyEnv in ~/.pi/agent/web.json (or .pi/web.json) and put the key in " +
	"~/.pi/agent/web.env as NAME=value (or export it in the shell). Never put the key value in web.json.";

export function getAgentDir(): string {
	return join(process.env.HOME || process.env.USERPROFILE || "~", ".pi", "agent");
}

const backendCooldowns = new Map<string, number>();

export function waitForCooldown(backend: string, signal?: AbortSignal): Promise<void> {
	const until = backendCooldowns.get(backend);
	if (!until) return Promise.resolve();
	const delay = until - Date.now();
	if (delay <= 0) return Promise.resolve();
	if (signal?.aborted) {
		return Promise.reject(
			signal.reason instanceof Error
				? signal.reason
				: new DOMException("Aborted", "AbortError"),
		);
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delay);
		const onAbort = () => {
			clearTimeout(timer);
			reject(
				signal?.reason instanceof Error
					? signal.reason
					: new DOMException("Aborted", "AbortError"),
			);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function markCooldown(backend: string): void {
	backendCooldowns.set(backend, Date.now() + COOLDOWN_MS);
}

export function clearCooldowns(): void {
	backendCooldowns.clear();
}

/** Combine an optional caller signal with a timeout. */
export function timeoutSignal(signal?: AbortSignal, timeoutMs?: number): AbortSignal {
	const effectiveTimeout = timeoutMs ?? HTTP_TIMEOUT_MS;
	if (!signal) return AbortSignal.timeout(effectiveTimeout);
	return AbortSignal.any([signal, AbortSignal.timeout(effectiveTimeout)]);
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException("Aborted", "AbortError");
}

/** Race a promise against an AbortSignal without cancelling the underlying work. */
export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	throwIfAborted(signal);
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new DOMException("Aborted", "AbortError"),
			);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

function isPrivateIpv4(parts: number[]): boolean {
	if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
		return false;
	}
	if (parts[0] === 127) return true;
	if (parts[0] === 10) return true;
	if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
	if (parts[0] === 192 && parts[1] === 168) return true;
	if (parts[0] === 169 && parts[1] === 254) return true;
	if (parts.every((p) => p === 0)) return true;
	return false;
}

export function isPrivateHost(host: string): boolean {
	const lower = host.toLowerCase().replace(/^\[|\]$/g, "");

	if (
		lower === "localhost" ||
		lower === "localhost.localdomain" ||
		lower.endsWith(".localhost") ||
		lower.endsWith(".local")
	) {
		return true;
	}
	if (lower === "127.0.0.1" || lower === "::1" || lower === "0.0.0.0" || lower === "::") {
		return true;
	}

	// Cloud / cluster metadata and common internal DNS suffixes (hostname-only; no DNS resolve).
	if (
		lower === "metadata.google.internal" ||
		lower === "metadata.google.com" ||
		lower === "metadata" ||
		lower === "kubernetes.default" ||
		lower === "kubernetes.default.svc" ||
		lower.endsWith(".internal") ||
		lower.endsWith(".intranet") ||
		lower.endsWith(".corp") ||
		lower.endsWith(".lan") ||
		lower.endsWith(".localdomain")
	) {
		return true;
	}

	let ip = lower;
	if (ip.startsWith("::ffff:")) {
		ip = ip.slice(7);
	}

	if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
		return isPrivateIpv4(ip.split(".").map(Number));
	}

	// IPv6 ULA fc00::/7 and link-local fe80::/10
	if (ip.includes(":")) {
		if (ip === "::1") return true;
		if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
		if (/^fe[89ab]/i.test(ip)) return true;
	}

	return false;
}

/**
 * Returns an error message if the URL is unsafe, or null if OK.
 * allowFile: permit file:// (cowork only — user drives their own browser).
 */
export function validateUrl(url: string, allowFile = false): string | null {
	try {
		const parsed = new URL(url);

		if (allowFile && parsed.protocol === "file:") return null;

		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return `SSRF blocked: only http/https allowed, got ${parsed.protocol}`;
		}

		if (isPrivateHost(parsed.hostname)) {
			return `SSRF blocked: private host ${parsed.hostname}`;
		}

		if (parsed.username || parsed.password) {
			return `SSRF blocked: credentials in URL not allowed`;
		}

		const port = parsed.port ? parseInt(parsed.port, 10) : 0;
		if (port > 0 && port < 1024 && port !== 80 && port !== 443) {
			return `SSRF blocked: privileged port ${port} not allowed`;
		}

		return null;
	} catch {
		return `Invalid URL: ${url}`;
	}
}

/**
 * Drop cloakbrowser's console chatter so it can't corrupt Pi's TUI.
 *
 * cloakbrowser logs update notices with plain console.log/warn from ensureBinary()
 * ("[cloakbrowser] Newer Chromium available...", "Update available: ... npm install",
 * download progress, and a promo banner on stderr). Pi's TUI owns stdout in raw mode
 * with differential rendering — it tracks previousLines/hardwareCursorRow and only
 * repaints changed rows — so an unaccounted write scrolls the screen, every cursor
 * offset goes stale, and the next repaint paints the editor around the stray text.
 * That is what "the update notice ended up in the input box" actually is.
 *
 * The update check is fire-and-forget, so the background-download lines arrive long
 * after launch() resolves. Filtering permanently (rather than muting around the call)
 * is the only thing that catches those. Non-cloakbrowser output still passes through.
 * ponytail: prefix match on the tag cloakbrowser already stamps; DEBUG=1 restores it.
 */
export function installCloakLogFilter(): void {
	const g = globalThis as { __piWebCloakFilter?: boolean };
	if (g.__piWebCloakFilter || process.env.DEBUG) return;
	g.__piWebCloakFilter = true;

	// ponytail: matches the tag cloakbrowser stamps on its own lines. A couple of
	// promo-banner lines carry no tag and still leak on first download — acceptable,
	// tighten only if that banner actually shows up mid-session.
	const isCloak = (args: unknown[]) =>
		typeof args[0] === "string" && /cloakbrowser/i.test(args[0]);

	for (const level of ["log", "warn", "error"] as const) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			if (isCloak(args)) return;
			original(...args);
		};
	}
}

export function sanitizeError(status: number, text: string): string {
	const safe = text
		.replace(/(bearer|token)\s+[\w.\/-]{8,}/gi, "$1 [redacted]")
		.replace(
			/(api[-_]?key|bearer|token|authorization|secret|password)["']?\s*[:=]\s*["']?[\w.\/-]{8,}/gi,
			"[redacted]",
		)
		.replace(
			/"(?:api[-_]?key|apiKey|token|secret|password|bearer)"\s*:\s*"[^"']{8,}"/gi,
			'"[redacted]"',
		)
		.replace(/(x-api-key|authorization)\s*:\s*[\w.\/-]{8,}/gi, "$1: [redacted]")
		.slice(0, 300);
	return `API error (${status}): ${safe}`;
}

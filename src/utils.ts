/** Shared utilities for pi-web-complete. */

import { BlockList, isIP } from "node:net";
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

const PRIVATE_NET = new BlockList();
PRIVATE_NET.addSubnet("0.0.0.0", 8, "ipv4");
PRIVATE_NET.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_NET.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_NET.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE_NET.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_NET.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_NET.addAddress("::1", "ipv6");
PRIVATE_NET.addAddress("::", "ipv6");
PRIVATE_NET.addSubnet("fc00::", 7, "ipv6");
PRIVATE_NET.addSubnet("fe80::", 10, "ipv6");

/** Last 32 bits of NAT64 / IPv4-compatible / dotted mapped form. Mapped hex is handled by BlockList. */
function ipv4FromV6(ip: string): string | null {
	const lower = ip.toLowerCase();
	if (lower.startsWith("::ffff:") && isIP(lower.slice(7)) === 4) return lower.slice(7);
	const embedded =
		lower.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/) ||
		(lower !== "::1" && lower !== "::"
			? lower.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
			: null);
	if (!embedded) return null;
	const hi = Number.parseInt(embedded[1]!, 16);
	const lo = Number.parseInt(embedded[2]!, 16);
	return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function isPrivateIpLiteral(ip: string): boolean {
	const kind = isIP(ip);
	if (kind === 4) return PRIVATE_NET.check(ip, "ipv4");
	if (kind === 6) {
		if (PRIVATE_NET.check(ip, "ipv6")) return true;
		const v4 = ipv4FromV6(ip);
		return v4 ? PRIVATE_NET.check(v4, "ipv4") : false;
	}
	return false;
}

let privateHostAllowlist = new Set<string>();

function normalizeHostname(host: string): string | null {
	let normalized = host.trim().toLowerCase().replace(/\.$/, "");
	if (!normalized || /[\s/@]/.test(normalized)) return null;
	if (normalized.startsWith("[") || normalized.endsWith("]")) {
		if (!(normalized.startsWith("[") && normalized.endsWith("]"))) return null;
		normalized = normalized.slice(1, -1);
		if (isIP(normalized) !== 6) return null;
	}
	return normalized;
}

/** Replace exact private hostnames explicitly trusted by the user's config. */
export function setPrivateHostAllowlist(hosts: unknown): void {
	privateHostAllowlist = new Set(
		(Array.isArray(hosts) ? hosts : [])
			.filter((host): host is string => typeof host === "string")
			.map(normalizeHostname)
			.filter((host): host is string => host !== null),
	);
}

export function isPrivateHost(host: string): boolean {
	const lower = normalizeHostname(host);
	if (!lower) return true;

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

	return isPrivateIpLiteral(lower);
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

		if (
			isPrivateHost(parsed.hostname) &&
			!privateHostAllowlist.has(normalizeHostname(parsed.hostname) ?? "")
		) {
			return `SSRF blocked: private host ${parsed.hostname}; add it to allowPrivateHosts in web.json to permit it`;
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

interface ManualRedirectResponse {
	status: number;
	headers: { get(name: string): string | null };
	body?: { cancel?: () => Promise<void> } | null;
}

const HOP_SENSITIVE = /^(authorization|cookie|proxy-authorization)$/i;

function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

/** Drop hop-sensitive headers when the next URL is a different origin (Fetch spec). */
export function hopHeaders(
	headers: Record<string, string>,
	crossOrigin: boolean,
): Record<string, string> {
	if (!crossOrigin) return headers;
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => !HOP_SENSITIVE.test(name)),
	);
}

/** Follow GET redirects only after validating each target, before network access. */
export async function fetchWithSafeRedirects<T extends ManualRedirectResponse>(
	url: string,
	fetchOnce: (url: string, hop: { crossOrigin: boolean }) => Promise<T>,
	maxRedirects = 5,
): Promise<{ response: T; finalUrl: string }> {
	let current = url;
	let previous = url;
	for (let redirects = 0; ; redirects++) {
		const ssrf = validateUrl(current);
		if (ssrf) throw new Error(ssrf);

		const crossOrigin = originOf(previous) !== originOf(current);
		const response = await fetchOnce(current, { crossOrigin });
		const location = [301, 302, 303, 307, 308].includes(response.status)
			? response.headers.get("location")
			: null;
		if (!location) return { response, finalUrl: current };
		await response.body?.cancel?.().catch(() => {});
		if (redirects >= maxRedirects) throw new Error(`Too many redirects (>${maxRedirects})`);
		try {
			previous = current;
			current = new URL(location, current).href;
		} catch {
			throw new Error(`Invalid redirect URL: ${location}`);
		}
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

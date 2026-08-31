/** Block detection + per-host climb floor (WebReaper ADR-0083, trimmed). */

export type LoadTier = "fast" | "fingerprint" | "browser";
export type BlockConfidence = "none" | "weak" | "high";

export interface BlockVerdict {
	confidence: BlockConfidence;
	reason?: string;
}

const TIER_RANK: Record<LoadTier, number> = {
	fast: 0,
	fingerprint: 1,
	browser: 2,
};

const BLOCK_STATUS = new Set([401, 403, 429, 503]);

const BLOCK_PATTERNS = [
	/captcha/iu,
	/cloudflare/iu,
	/access denied/iu,
	/temporarily blocked/iu,
	/unusual traffic/iu,
	/please verify you are a human/iu,
];

const hostFloor = new Map<string, LoadTier>();

export function clearHostFloors(): void {
	hostFloor.clear();
}

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

export function getHostFloor(url: string): LoadTier {
	const host = hostOf(url);
	return (host && hostFloor.get(host)) || "fast";
}

/** Lift only. Never lowers a host's floor. */
export function liftHostFloor(url: string, tier: LoadTier): void {
	const host = hostOf(url);
	if (!host) return;
	const cur = hostFloor.get(host) ?? "fast";
	if (TIER_RANK[tier] > TIER_RANK[cur]) hostFloor.set(host, tier);
}

export function challengeFromHeaders(
	headers?: { get?: (name: string) => string | null } | null,
): boolean {
	if (!headers || typeof headers.get !== "function") return false;
	const v = headers.get("cf-mitigated")?.toLowerCase();
	return v === "challenge" || v === "captcha";
}

export function detectBlock(
	status: number,
	html: string,
	text: string,
	challengeHeader = false,
): BlockVerdict {
	if (BLOCK_STATUS.has(status)) return { confidence: "high", reason: `HTTP ${status}` };
	if (challengeHeader) return { confidence: "high", reason: "challenge header" };
	if (BLOCK_PATTERNS.some((p) => p.test(html) || p.test(text))) {
		return { confidence: "weak", reason: "body marker" };
	}
	return { confidence: "none" };
}

/** High-confidence residual is always dropped. Weak only if the extract is thin. */
export function shouldRefuseResidual(verdict: BlockVerdict, extractedChars: number): boolean {
	if (verdict.confidence === "high") return true;
	if (verdict.confidence === "weak" && extractedChars < 400) return true;
	return false;
}

export function blockedNotice(url: string, status: number, reason: string): string {
	return (
		`Blocked: ${url} still looks like a challenge page after HTTP, TLS fingerprint, and CloakBrowser ` +
		`(${reason}; HTTP ${status}). Challenge HTML omitted. Use web_cowork if a human must pass the check.`
	);
}

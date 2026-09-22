/** Wayback Machine archive lookup — availability query only, never fetches the snapshot body. */

const WAYBACK_API = "https://archive.org/wayback/available";

/** Dead-end statuses that should never be retried or stitched: gone for good. */
export function isDeadStatus(status: number): boolean {
	return status === 404 || status === 410;
}

type WaybackResponse = {
	archived_snapshots?: {
		closest?: {
			available?: boolean;
			url?: string;
			timestamp?: string;
		};
	};
};

/**
 * Look up the closest Wayback snapshot for `url`.
 * Returns `null` on miss, non-ok response, malformed body, or any error — never throws to caller.
 */
export async function findWaybackSnapshot(
	url: string,
	opts?: { signal?: AbortSignal; fetch?: typeof globalThis.fetch },
): Promise<{ snapshotUrl: string; timestamp: string } | null> {
	try {
		const doFetch = opts?.fetch ?? globalThis.fetch;
		const res = await doFetch(`${WAYBACK_API}?url=${encodeURIComponent(url)}`, {
			signal: opts?.signal,
		});
		if (!res.ok) return null;
		const data = (await res.json()) as WaybackResponse;
		const closest = data?.archived_snapshots?.closest;
		if (closest?.available !== true) return null;
		const rawUrl = closest.url;
		const timestamp = closest.timestamp;
		if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;
		if (typeof timestamp !== "string" || timestamp.length === 0) return null;
		// Prefer https on the snapshot URL
		const snapshotUrl = rawUrl.startsWith("http://")
			? rawUrl.replace(/^http:\/\//, "https://")
			: rawUrl;
		return { snapshotUrl, timestamp };
	} catch {
		return null;
	}
}

/** One-line banner for archive-sourced content. */
export function archiveBanner(timestamp: string, snapshotUrl: string): string {
	const t = timestamp.replace(/\D/g, "");
	const date =
		t.length >= 8 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : timestamp;
	return `Archived snapshot ${date} (age labeled from timestamp ${timestamp}). Source: ${snapshotUrl}`;
}

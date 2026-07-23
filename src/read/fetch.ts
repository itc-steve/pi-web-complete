/** Fast HTTP fetch via undici + SSRF guard. */

import { fetch } from "undici";
import { validateUrl, timeoutSignal } from "../utils.js";

export interface FetchResult {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	html: string;
	bytes: number;
	truncated?: boolean;
}

/** Real browser UA — community sites often serve different shells to bot UAs. */
export const DEFAULT_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** Floor so models passing tiny maxBytes (e.g. 200_000) don't fail on normal pages. */
export const MIN_MAX_BYTES = 2 * 1024 * 1024;

export function resolveMaxBytes(requested?: number): number {
	if (requested === undefined || requested <= 0) return DEFAULT_MAX_BYTES;
	return Math.max(requested, MIN_MAX_BYTES);
}

/**
 * Read a fetch Response body up to maxBytes, then cancel the stream.
 * Falls back to arrayBuffer slice when body is unavailable.
 */
export async function readBodyCapped(
	response: {
		body?: { getReader: () => ReadableStreamDefaultReader<Uint8Array> } | null;
		arrayBuffer: () => Promise<ArrayBuffer>;
	},
	maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
	const body = response.body;
	if (!body || typeof body.getReader !== "function") {
		const ab = await response.arrayBuffer();
		const truncated = ab.byteLength > maxBytes;
		const slice = truncated ? ab.slice(0, maxBytes) : ab;
		return {
			text: Buffer.from(slice).toString("utf-8"),
			bytes: Math.min(ab.byteLength, maxBytes + (truncated ? 1 : 0)),
			truncated,
		};
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.byteLength) continue;

			if (total >= maxBytes) {
				truncated = true;
				break;
			}

			const room = maxBytes - total;
			if (value.byteLength <= room) {
				chunks.push(value);
				total += value.byteLength;
			} else {
				chunks.push(value.subarray(0, room));
				total += room;
				truncated = true;
				break;
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// ignore
		}
	}

	return {
		text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8"),
		bytes: total,
		truncated,
	};
}

export async function fetchUrl(
	url: string,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		maxBytes?: number;
		headers?: Record<string, string>;
	} = {},
): Promise<FetchResult> {
	const ssrf = validateUrl(url);
	if (ssrf) throw new Error(ssrf);

	const maxBytes = resolveMaxBytes(options.maxBytes);
	const signal = timeoutSignal(options.signal, options.timeoutMs);

	const response = await fetch(url, {
		method: "GET",
		headers: {
			"user-agent": DEFAULT_UA,
			accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"accept-language": "en-US,en;q=0.9",
			...options.headers,
		},
		redirect: "follow",
		signal,
	});

	const finalUrl = response.url || url;
	const finalSsrf = validateUrl(finalUrl);
	if (finalSsrf) throw new Error(finalSsrf);

	const contentType = response.headers.get("content-type") ?? "text/html";
	const { text, bytes, truncated } = await readBodyCapped(response, maxBytes);

	return {
		url,
		finalUrl,
		status: response.status,
		contentType,
		html: text,
		bytes,
		truncated,
	};
}

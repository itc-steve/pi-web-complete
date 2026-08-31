/** Fast HTTP fetch via undici + SSRF guard. */

import { fetch } from "undici";
import { fetchWithSafeRedirects, hopHeaders, timeoutSignal } from "../utils.js";
import { challengeFromHeaders } from "./block.js";
import { fetchWithMetaRefresh } from "./hints.js";

export interface FetchResult {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	html: string;
	bytes: number;
	truncated?: boolean;
	challengeHeader?: boolean;
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

/** Try to resolve charset; return "utf-8" on any failure. */
function resolveCharset(contentType: string, bytes: Uint8Array): string {
  // (a) Content-Type header — honour for all MIME types
  const ct = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType);
  if (ct?.[1]) return ct[1];

  // (b) <meta charset> is an HTML mechanism — never sniff text/plain, JSON, etc.
  // A markdown/docs body that merely *mentions* <meta charset="utf-16le"> must
  // stay utf-8; otherwise the whole body is destroyed.
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mime && !mime.includes("html") && !mime.includes("xml")) return "utf-8";

  // (c) <meta> in first 2048 bytes — decode as latin1 (lossless for single-byte)
  const preview = new TextDecoder("iso-8859-1").decode(
    bytes.slice(0, 2048),
  );
  const meta = /<meta[^>]+(?:charset\s*=\s*["']?([\w-]+)|content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+))/i.exec(preview);
  if (meta?.[1] || meta?.[2]) return meta[1] ?? meta[2] ?? "utf-8";

  // (d) Default
  return "utf-8";
}

/**
 * Read a fetch Response body up to maxBytes, then cancel the stream.
 * Falls back to arrayBuffer slice when body is unavailable.
 */
export async function readBodyCapped(
  response: {
    body?: { getReader: () => ReadableStreamDefaultReader<Uint8Array> } | null;
    arrayBuffer: () => Promise<ArrayBuffer>;
    headers?: { get: (n: string) => string | null };
  },
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = response.body;
  const contentType = response.headers?.get("content-type") ?? "";

  if (!body || typeof body.getReader !== "function") {
    const ab = await response.arrayBuffer();
    const truncated = ab.byteLength > maxBytes;
    const slice = truncated ? ab.slice(0, maxBytes) : ab;
    const buf = Buffer.from(slice);
    const raw = new Uint8Array(buf);
    const charset = resolveCharset(contentType, raw);
    const text = decodeBuffer(buf, charset);
    return {
      text,
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

  const raw = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const charset = resolveCharset(contentType, new Uint8Array(raw));
  const text = decodeBuffer(raw, charset);

  return { text, bytes: total, truncated };
}

/** Decode a buffer using the given charset label. Falls back to utf-8. */
function decodeBuffer(buf: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    // Unknown label — RangeError
    return new TextDecoder("utf-8").decode(buf);
  }
}

async function fetchUrlOnce(
	url: string,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		maxBytes?: number;
		headers?: Record<string, string>;
	},
	/** Original request URL preserved across meta-refresh hops. */
	originalUrl: string,
): Promise<FetchResult> {
	const maxBytes = resolveMaxBytes(options.maxBytes);
	const signal = timeoutSignal(options.signal, options.timeoutMs);

	const { response, finalUrl } = await fetchWithSafeRedirects(url, (current, { crossOrigin }) =>
		fetch(current, {
			method: "GET",
			headers: hopHeaders(
				{
					"user-agent": DEFAULT_UA,
					accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"accept-language": "en-US,en;q=0.9",
					...options.headers,
				},
				crossOrigin,
			),
			redirect: "manual",
			signal,
		}),
	);

	const contentType = response.headers.get("content-type") ?? "text/html";
	const { text, bytes, truncated } = await readBodyCapped(response, maxBytes);

	return {
		url: originalUrl,
		finalUrl,
		status: response.status,
		contentType,
		html: text,
		bytes,
		truncated,
		challengeHeader: challengeFromHeaders(response.headers),
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
	return fetchWithMetaRefresh(url, (hop) => fetchUrlOnce(hop, options, url));
}

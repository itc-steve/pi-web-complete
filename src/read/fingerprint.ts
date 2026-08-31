/** TLS-fingerprint fetch via impit. */

import { Impit } from "impit";
import { fetchWithSafeRedirects, timeoutSignal } from "../utils.js";
import { challengeFromHeaders } from "./block.js";
import { readBodyCapped, resolveMaxBytes, type FetchResult } from "./fetch.js";
import { fetchWithMetaRefresh } from "./hints.js";

async function fingerprintFetchOnce(
	url: string,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		maxBytes?: number;
	},
	originalUrl: string,
): Promise<FetchResult> {
	const maxBytes = resolveMaxBytes(options.maxBytes);
	const signal = timeoutSignal(options.signal, options.timeoutMs);

	const impit = new Impit({
		browser: "chrome142",
		followRedirects: false,
	});

	const { response, finalUrl } = await fetchWithSafeRedirects(url, (current) =>
		impit.fetch(current, {
			method: "GET",
			redirect: "manual",
			signal,
		}),
	);

	const contentType = response.headers.get("content-type") ?? "text/html";
	const { text, bytes, truncated } = await readBodyCapped(response as any, maxBytes);

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

export async function fingerprintFetch(
	url: string,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		maxBytes?: number;
	} = {},
): Promise<FetchResult> {
	return fetchWithMetaRefresh(url, (hop) => fingerprintFetchOnce(hop, options, url));
}

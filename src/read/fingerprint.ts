/** TLS-fingerprint fetch via impit. */

import { Impit } from "impit";
import { validateUrl, timeoutSignal } from "../utils.js";
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
	const ssrf = validateUrl(url);
	if (ssrf) throw new Error(ssrf);

	const maxBytes = resolveMaxBytes(options.maxBytes);
	const signal = timeoutSignal(options.signal, options.timeoutMs);

	const impit = new Impit({
		browser: "chrome142",
		followRedirects: true,
		maxRedirects: 5,
	});

	const response = await impit.fetch(url, {
		method: "GET",
		signal,
	});

	const finalUrl = response.url || url;
	const finalSsrf = validateUrl(finalUrl);
	if (finalSsrf) throw new Error(finalSsrf);

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

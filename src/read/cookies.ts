/**
 * In-memory session cookie jar. No disk, no browser.
 *
 * rememberCookies(pageUrl, cookies) keys entries by hostname of pageUrl.
 * cookieHeaderFor(url) returns "n=v; n2=v2" for that host, plus
 * parent-domain cookies (cookie.domain set and a suffix of the host;
 * leading dot ok). Later remember for the same host replaces by name.
 */

export type Cookie = { name: string; value: string; domain?: string; path?: string };

const jar = new Map<string, Cookie[]>();

function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

function domainMatches(host: string, domain: string): boolean {
	const d = domain.toLowerCase().replace(/^\./, "");
	return d.length > 0 && (host === d || host.endsWith("." + d));
}

export function rememberCookies(pageUrl: string, cookies: Cookie[]): void {
	const host = hostnameOf(pageUrl);
	if (!host) return;
	let arr = jar.get(host) ?? [];
	for (const c of cookies) {
		if (!c.name || !c.value) continue;
		arr = arr.filter((e) => e.name !== c.name);
		arr.push(c);
	}
	jar.set(host, arr);
}

export function cookieHeaderFor(url: string): string | undefined {
	const host = hostnameOf(url);
	if (!host) return undefined;
	const out: string[] = [];
	for (const [storedHost, arr] of jar) {
		if (storedHost === host) {
			out.push(...arr.map((c) => `${c.name}=${c.value}`));
		} else {
			for (const c of arr) {
				if (c.domain && domainMatches(host, c.domain)) {
					out.push(`${c.name}=${c.value}`);
				}
			}
		}
	}
	return out.length ? out.join("; ") : undefined;
}

export function clearCookies(): void {
	jar.clear();
}

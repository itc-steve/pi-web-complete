/** URL slug utilities — pure functions, no external deps. */

/**
 * De-slugify a URL fragment into a readable query string.
 * Splits on `-`, `_`, `%20`, and camelCase boundaries.
 * Drops pure-numeric tokens and tokens < 2 chars.
 */
export function deslugify(fragment: string): string {
	let decoded: string;
	try { decoded = decodeURIComponent(fragment); } catch { decoded = fragment; }
	const tokens = decoded
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.split(/[-_%\s'"]+/)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2 && !/^\d+$/.test(t));
	return tokens.join(" ");
}

/** Slugify a title (or fallback to URL pathname) into a filename. */
export function slugifyFilename(title: string | undefined, url: string): string {
	const base =
		(title && title.trim()) ||
		(() => {
			try {
				const u = new URL(url);
				return u.pathname.split("/").filter(Boolean).pop() || "page";
			} catch {
				return "page";
			}
		})();
	const slug = base
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return (slug || "page") + ".md";
}

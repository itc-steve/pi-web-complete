/** Query-ranked markdown excerpts for web_read chat returns. */

export interface MarkdownChunk {
	/** Heading path like "Intro > Setup". Empty for lead body. */
	headingPath: string;
	text: string;
	/** Offset into the source markdown. */
	start: number;
	/** Chunk index in document order. */
	index: number;
}

export interface SelectExcerptsOptions {
	maxChars?: number;
	maxChunks?: number;
}

export interface SelectExcerptsResult {
	text: string;
	matched: number;
	totalChunks: number;
	pageChars: number;
}

const STOPWORDS = new Set([
	"a",
	"an",
	"the",
	"and",
	"or",
	"but",
	"in",
	"on",
	"at",
	"to",
	"for",
	"of",
	"as",
	"by",
	"with",
	"from",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"it",
	"its",
	"this",
	"that",
	"these",
	"those",
	"i",
	"you",
	"he",
	"she",
	"we",
	"they",
	"what",
	"which",
	"who",
	"whom",
	"how",
	"when",
	"where",
	"why",
	"can",
	"could",
	"should",
	"would",
	"will",
	"may",
	"might",
	"must",
	"do",
	"does",
	"did",
	"have",
	"has",
	"had",
	"not",
	"no",
	"nor",
	"so",
	"if",
	"than",
	"then",
	"too",
	"very",
	"just",
	"about",
	"into",
	"over",
	"after",
	"before",
	"between",
	"under",
	"again",
	"further",
	"once",
	"here",
	"there",
	"all",
	"each",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"only",
	"own",
	"same",
	"s",
	"t",
	"don",
	"now",
	"also",
	"use",
	"using",
	"used",
	"via",
	"per",
]);

const TARGET_CHUNK_CHARS = 700;
const MAX_CHUNK_CHARS = 900;
const MIN_CHUNK_CHARS = 80;
/** Folded (stem) hits score at this fraction of an exact hit. */
const FOLD_WEIGHT = 0.6;

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
/** Opening fence: 3+ ` or ~, optional info string; backtick info may not contain `. */
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
/** Closing fence: 3+ of same char, optional trailing space only. */
const FENCE_CLOSE_RE = /^( {0,3})(`{3,}|~{3,})[ \t]*$/;

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_+.-]+/u)
		.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Conservative suffix fold for matching. Applied on both query and body tokens.
 * Strip plural first, then normalize sibilant+silent-e on BOTH sides so the fold
 * is symmetric by construction (size↔sizes, optimize↔optimizes, cache↔caches).
 */
export function stem(token: string): string {
	const t = token.toLowerCase();
	const desib = (w: string) =>
		/(?:s|z|x|ch|sh)e$/.test(w) && w.length >= 4 ? w.slice(0, -1) : w;
	if (t.endsWith("ies") && t.length >= 6) return t.slice(0, -3) + "y";
	if (t.endsWith("ing") && t.length >= 6) return t.slice(0, -3);
	if (t.endsWith("ed") && t.length >= 5) return t.slice(0, -2);
	if (t.endsWith("es") && t.length >= 4) return desib(t.slice(0, -1));
	if (t.endsWith("s") && !t.endsWith("ss") && t.length >= 4) return desib(t.slice(0, -1));
	return desib(t);
}

/** Double-quoted substrings from the query (lowercased, trimmed). */
export function extractQuotedPhrases(query: string): string[] {
	const out: string[] = [];
	const re = /"([^"]+)"/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(query)) !== null) {
		const p = m[1].trim().toLowerCase();
		if (p) out.push(p);
	}
	return out;
}

/** Fence-aware line events shared by chunkMarkdown and pageOutline. */
type MdLineEvent =
	| { kind: "heading"; level: number; title: string; line: string; lineStart: number }
	| { kind: "body"; line: string; lineStart: number };

/**
 * Walk markdown lines with one fence state machine. ATX headings only fire
 * outside fences, and only with the CommonMark ≤3-space indent limit
 * (`line.replace(/^ {0,3}/, "")` — never trim()).
 */
function* scanMarkdownLines(md: string): Generator<MdLineEvent> {
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	let offset = 0;
	let fence: { char: string; len: number } | null = null;

	for (const line of lines) {
		const lineStart = offset;
		offset += line.length + 1; // +1 for \n

		if (fence) {
			const close = FENCE_CLOSE_RE.exec(line);
			if (
				close &&
				close[2][0] === fence.char &&
				close[2].length >= fence.len
			) {
				fence = null;
			}
			yield { kind: "body", line, lineStart };
			continue;
		}

		const open = FENCE_OPEN_RE.exec(line);
		if (open) {
			const marker = open[2];
			const char = marker[0];
			const info = open[3] ?? "";
			// CommonMark: backtick fences reject info strings containing backticks.
			if (!(char === "`" && info.includes("`"))) {
				fence = { char, len: marker.length };
				yield { kind: "body", line, lineStart };
				continue;
			}
		}

		const m = HEADING_RE.exec(line.replace(/^ {0,3}/, ""));
		if (m) {
			yield {
				kind: "heading",
				level: m[1].length,
				title: m[2].trim(),
				line,
				lineStart,
			};
			continue;
		}
		yield { kind: "body", line, lineStart };
	}
}

/**
 * Split markdown on ATX headings, then pack paragraphs into ~500–900 char windows.
 */
export function chunkMarkdown(md: string): MarkdownChunk[] {
	const sections: { headingPath: string; body: string; start: number }[] = [];
	const pathStack: { level: number; title: string }[] = [];
	let bodyLines: string[] = [];
	let sectionStart = 0;
	let lastEnd = 0;

	const flushSection = (nextStart: number) => {
		const body = bodyLines.join("\n").trim();
		if (body.length >= MIN_CHUNK_CHARS || pathStack.length > 0) {
			sections.push({
				headingPath: pathStack.map((p) => p.title).join(" > "),
				body,
				start: sectionStart,
			});
		}
		bodyLines = [];
		sectionStart = nextStart;
	};

	for (const ev of scanMarkdownLines(md)) {
		lastEnd = ev.lineStart + ev.line.length + 1;
		if (ev.kind === "heading") {
			flushSection(ev.lineStart);
			while (pathStack.length && pathStack[pathStack.length - 1].level >= ev.level) {
				pathStack.pop();
			}
			pathStack.push({ level: ev.level, title: ev.title });
			continue;
		}
		bodyLines.push(ev.line);
	}
	flushSection(lastEnd);

	const chunks: MarkdownChunk[] = [];
	let index = 0;
	for (const section of sections) {
		const packed = packParagraphs(section.body, section.headingPath, section.start);
		for (const c of packed) {
			chunks.push({ ...c, index: index++ });
		}
	}
	return chunks;
}

/** Split body into packable units; fenced code blocks stay intact across blank lines. */
function splitBodyUnits(body: string): string[] {
	const lines = body.split("\n");
	const units: string[] = [];
	let buf: string[] = [];
	let fence: { char: string; len: number } | null = null;

	const flushPara = () => {
		const text = buf.join("\n").trim();
		if (text) units.push(text);
		buf = [];
	};

	for (const line of lines) {
		if (fence) {
			buf.push(line);
			const close = FENCE_CLOSE_RE.exec(line);
			if (
				close &&
				close[2][0] === fence.char &&
				close[2].length >= fence.len
			) {
				// Keep fence raw (do not trim) so markers stay balanced.
				units.push(buf.join("\n"));
				buf = [];
				fence = null;
			}
			continue;
		}

		const open = FENCE_OPEN_RE.exec(line);
		if (open) {
			const marker = open[2];
			const char = marker[0];
			const info = open[3] ?? "";
			// CommonMark: backtick fences reject info strings containing backticks.
			if (!(char === "`" && info.includes("`"))) {
				flushPara();
				fence = { char, len: marker.length };
				buf = [line];
				continue;
			}
		}

		if (line.trim() === "") {
			flushPara();
			continue;
		}
		buf.push(line);
	}

	if (fence) {
		// Unclosed fence: still emit as one unit so markers stay together.
		units.push(buf.join("\n"));
	} else {
		flushPara();
	}
	return units;
}

function packParagraphs(
	body: string,
	headingPath: string,
	sectionStart: number,
): Omit<MarkdownChunk, "index">[] {
	const paras = splitBodyUnits(body);
	if (paras.length === 0) {
		if (!headingPath) return [];
		return [{ headingPath, text: "", start: sectionStart }];
	}

	const out: Omit<MarkdownChunk, "index">[] = [];
	let buf: string[] = [];
	let bufLen = 0;
	let bufStart = sectionStart;
	let cursor = sectionStart;

	const flush = () => {
		const text = buf.join("\n\n").trim();
		if (text.length >= MIN_CHUNK_CHARS || (headingPath && text.length > 0)) {
			out.push({ headingPath, text, start: bufStart });
		}
		buf = [];
		bufLen = 0;
	};

	for (const para of paras) {
		const paraStart = body.indexOf(para, cursor - sectionStart);
		const absStart = paraStart >= 0 ? sectionStart + paraStart : cursor;
		if (buf.length === 0) bufStart = absStart;

		// Fence units are atomic (splitBodyUnits). Oversize fences may exceed MAX_CHUNK_CHARS.
		if (bufLen > 0 && bufLen + para.length + 2 > MAX_CHUNK_CHARS) {
			flush();
			bufStart = absStart;
		}

		buf.push(para);
		bufLen += para.length + (buf.length > 1 ? 2 : 0);
		cursor = absStart + para.length;

		if (bufLen >= TARGET_CHUNK_CHARS) {
			flush();
		}
	}
	flush();
	return out;
}

function chunkHaystack(chunk: MarkdownChunk): string {
	return `${chunk.headingPath}\n${chunk.text}`.toLowerCase();
}

/** Whether a chunk contains a query term (exact token, stem, or substring). */
function chunkMatchesTerm(chunk: MarkdownChunk, term: string): boolean {
	const headingTokens = tokenize(chunk.headingPath);
	const bodyTokens = tokenize(chunk.text);
	if (headingTokens.includes(term) || bodyTokens.includes(term)) return true;
	const s = stem(term);
	if (
		headingTokens.some((t) => stem(t) === s) ||
		bodyTokens.some((t) => stem(t) === s)
	) {
		return true;
	}
	const hay = chunkHaystack(chunk);
	if (hay.includes(term)) return true;
	if (s.length >= 3 && hay.includes(s)) return true;
	return false;
}

/**
 * Score a chunk against a query.
 * @param termWeights optional per-term IDF (or other) weights; missing terms default to 1.
 */
export function scoreChunk(
	chunk: MarkdownChunk,
	query: string,
	termWeights?: ReadonlyMap<string, number>,
): number {
	const terms = tokenize(query);
	if (terms.length === 0) return 0;

	const weightOf = (term: string): number => termWeights?.get(term) ?? 1;

	const headingLower = chunk.headingPath.toLowerCase();
	const bodyLower = chunk.text.toLowerCase();
	const headingTokens = tokenize(chunk.headingPath);
	const bodyTokens = tokenize(chunk.text);
	const headingSet = new Set(headingTokens);
	const bodySet = new Set(bodyTokens);
	const headingStemSet = new Set(headingTokens.map(stem));
	const bodyStemSet = new Set(bodyTokens.map(stem));

	let score = 0;
	let covered = 0;

	for (const term of terms) {
		const idf = weightOf(term);
		const termStem = stem(term);
		let hit = false;

		// Heading
		if (headingSet.has(term) || headingLower.includes(term)) {
			score += 4 * idf;
			hit = true;
		} else if (
			headingStemSet.has(termStem) ||
			(termStem.length >= 3 && headingLower.includes(termStem))
		) {
			score += 4 * FOLD_WEIGHT * idf;
			hit = true;
		}

		// Body
		if (bodySet.has(term)) {
			const freq = bodyTokens.filter((t) => t === term).length;
			score += (1 + Math.min(freq, 5) * 0.5) * idf;
			hit = true;
		} else if (bodyStemSet.has(termStem)) {
			const freq = bodyTokens.filter((t) => stem(t) === termStem).length;
			score += (1 + Math.min(freq, 5) * 0.5) * FOLD_WEIGHT * idf;
			hit = true;
		} else if (bodyLower.includes(term)) {
			score += 0.75 * idf;
			hit = true;
		} else if (termStem.length >= 3 && bodyLower.includes(termStem)) {
			// e.g. query "caching" / body "cache" — stem "cach" is a prefix substring
			score += 0.75 * FOLD_WEIGHT * idf;
			hit = true;
		}

		if (hit) covered++;
	}

	// Phrase / consecutive-term boost
	const q = query.toLowerCase().trim();
	if (q.length >= 4) {
		if (headingLower.includes(q)) score += 8;
		else if (bodyLower.includes(q)) score += 4;
	}

	if (terms.length >= 2) {
		for (let i = 0; i < terms.length - 1; i++) {
			const bigram = `${terms[i]} ${terms[i + 1]}`;
			if (headingLower.includes(bigram)) score += 3;
			else if (bodyLower.includes(bigram)) score += 1.5;
		}
	}

	// Prefer chunks that cover more of the query
	if (terms.length > 0) {
		score *= 0.5 + (covered / terms.length) * 0.5;
	}

	return score;
}

/** Build IDF weights: idf = log(1 + N / (1 + df)) over the chunk set. */
function computeIdfWeights(
	chunks: MarkdownChunk[],
	terms: string[],
): Map<string, number> {
	const N = chunks.length;
	const weights = new Map<string, number>();
	for (const term of terms) {
		let df = 0;
		for (const c of chunks) {
			if (chunkMatchesTerm(c, term)) df++;
		}
		weights.set(term, Math.log(1 + N / (1 + df)));
	}
	return weights;
}

/**
 * Rank chunks against query; return top matches in document order under a char budget.
 */
export function selectExcerpts(
	md: string,
	query: string,
	options: SelectExcerptsOptions = {},
): SelectExcerptsResult {
	const maxChars = options.maxChars ?? 6_000;
	const maxChunks = options.maxChunks ?? 8;
	const chunks = chunkMarkdown(md);
	const pageChars = md.length;

	if (chunks.length === 0) {
		const slice = md.slice(0, maxChars);
		return {
			text: slice + (md.length > maxChars ? "\n\n…[truncated]" : ""),
			matched: slice ? 1 : 0,
			totalChunks: 0,
			pageChars,
		};
	}

	// D) Quoted phrases are required filters (case-insensitive substring).
	const phrases = extractQuotedPhrases(query);
	let pool = chunks;
	let phraseFallback = false;
	if (phrases.length > 0) {
		const filtered = chunks.filter((c) => {
			const hay = chunkHaystack(c);
			return phrases.every((p) => hay.includes(p));
		});
		if (filtered.length > 0) {
			pool = filtered;
		} else {
			// Fall back rather than return nothing.
			phraseFallback = true;
			pool = chunks;
		}
	}

	const terms = tokenize(query);
	const idfWeights = computeIdfWeights(chunks, terms);

	const scored = pool
		.map((c) => ({ chunk: c, score: scoreChunk(c, query, idfWeights) }))
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index);

	const picked: MarkdownChunk[] = [];
	let used = 0;
	for (const { chunk } of scored) {
		if (picked.length >= maxChunks) break;
		const blockLen = formatChunkBlock(chunk).length + (picked.length ? 5 : 0);
		if (picked.length > 0 && used + blockLen > maxChars) continue;
		picked.push(chunk);
		used += blockLen;
		if (used >= maxChars) break;
	}

	// If nothing matched, return highest-overlap soft fallback: first chunks under budget
	if (picked.length === 0) {
		const fallback = pageOutline(md, Math.min(800, maxChars));
		const phraseNote = phraseFallback
			? " Quoted-phrase filter matched 0 chunks; fell back to unfiltered ranking."
			: "";
		return {
			text:
				`No strong matches for query ${JSON.stringify(query)}. ` +
				`Showing page outline instead. Pass a narrower query or use return=full.` +
				phraseNote +
				`\n\n` +
				fallback,
			matched: 0,
			totalChunks: chunks.length,
			pageChars,
		};
	}

	picked.sort((a, b) => a.index - b.index);
	const body = picked.map(formatChunkBlock).join("\n\n---\n\n");
	let meta =
		`Matched ${picked.length} of ${chunks.length} chunks ` +
		`(total page ~${pageChars} chars). Use return=full for the complete page.`;
	if (phraseFallback) {
		meta +=
			` Quoted-phrase filter matched 0 chunks; fell back to unfiltered ranking.`;
	}

	let text = `${meta}\n\n${body}`;
	if (text.length > maxChars) {
		text = text.slice(0, maxChars) + "\n\n…[truncated]";
	}

	return {
		text,
		matched: picked.length,
		totalChunks: chunks.length,
		pageChars,
	};
}

function formatChunkBlock(chunk: MarkdownChunk): string {
	const heading = chunk.headingPath
		? `## ${chunk.headingPath.split(" > ").pop()}\n` +
			(chunk.headingPath.includes(" > ")
				? `_Section: ${chunk.headingPath}_\n\n`
				: "\n")
		: "";
	return `${heading}${chunk.text}`.trim();
}

/**
 * When no query is provided: heading TOC + short lead.
 */
export function pageOutline(md: string, leadChars = 800): string {
	const headings: string[] = [];
	const leadParts: string[] = [];
	let leadLen = 0;
	let pastLead = false;

	// Same fence + ≤3-space ATX rules as chunkMarkdown (via scanMarkdownLines).
	for (const ev of scanMarkdownLines(md)) {
		if (ev.kind === "heading") {
			const indent = "  ".repeat(Math.max(0, ev.level - 1));
			headings.push(`${indent}- ${ev.title}`);
			pastLead = true;
			continue;
		}
		if (!pastLead && leadLen < leadChars) {
			const t = ev.line.trim();
			if (t) {
				leadParts.push(t);
				leadLen += t.length + 1;
			}
		}
	}

	const parts: string[] = [
		"No query provided — returning page outline. " +
			"Pass query for ranked excerpts, or return=full for the complete page.",
		"",
	];

	if (headings.length > 0) {
		parts.push("## Outline", ...headings.slice(0, 40), "");
	}

	const lead = leadParts.join(" ").slice(0, leadChars).trim();
	if (lead) {
		parts.push("## Lead", lead + (md.length > leadChars ? "…" : ""));
	} else if (headings.length === 0) {
		parts.push(md.slice(0, leadChars) + (md.length > leadChars ? "…" : ""));
	}

	return parts.join("\n");
}

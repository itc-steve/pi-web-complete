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

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_+.-]+/u)
		.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Split markdown on ATX headings, then pack paragraphs into ~500–900 char windows.
 */
export function chunkMarkdown(md: string): MarkdownChunk[] {
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	const sections: { headingPath: string; body: string; start: number }[] = [];
	const pathStack: { level: number; title: string }[] = [];
	let bodyLines: string[] = [];
	let sectionStart = 0;
	let offset = 0;

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

	for (const line of lines) {
		const lineStart = offset;
		offset += line.length + 1; // +1 for \n
		const m = HEADING_RE.exec(line.trim());
		if (m) {
			flushSection(lineStart);
			const level = m[1].length;
			const title = m[2].trim();
			while (pathStack.length && pathStack[pathStack.length - 1].level >= level) {
				pathStack.pop();
			}
			pathStack.push({ level, title });
			continue;
		}
		bodyLines.push(line);
	}
	flushSection(offset);

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

function packParagraphs(
	body: string,
	headingPath: string,
	sectionStart: number,
): Omit<MarkdownChunk, "index">[] {
	const paras = body
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean);
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

export function scoreChunk(chunk: MarkdownChunk, query: string): number {
	const terms = tokenize(query);
	if (terms.length === 0) return 0;

	const headingLower = chunk.headingPath.toLowerCase();
	const bodyLower = chunk.text.toLowerCase();
	const headingTokens = new Set(tokenize(chunk.headingPath));
	const bodyTokens = tokenize(chunk.text);
	const bodySet = new Set(bodyTokens);

	let score = 0;
	let covered = 0;

	for (const term of terms) {
		let hit = false;
		if (headingTokens.has(term) || headingLower.includes(term)) {
			score += 4;
			hit = true;
		}
		if (bodySet.has(term)) {
			const freq = bodyTokens.filter((t) => t === term).length;
			score += 1 + Math.min(freq, 5) * 0.5;
			hit = true;
		} else if (bodyLower.includes(term)) {
			score += 0.75;
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

	const scored = chunks
		.map((c) => ({ chunk: c, score: scoreChunk(c, query) }))
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
		return {
			text:
				`No strong matches for query ${JSON.stringify(query)}. ` +
				`Showing page outline instead. Pass a narrower query or use return=full.\n\n` +
				fallback,
			matched: 0,
			totalChunks: chunks.length,
			pageChars,
		};
	}

	picked.sort((a, b) => a.index - b.index);
	const body = picked.map(formatChunkBlock).join("\n\n---\n\n");
	const meta =
		`Matched ${picked.length} of ${chunks.length} chunks ` +
		`(total page ~${pageChars} chars). Use return=full for the complete page.`;

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
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	const headings: string[] = [];
	const leadParts: string[] = [];
	let leadLen = 0;
	let pastLead = false;

	for (const line of lines) {
		const m = HEADING_RE.exec(line.trim());
		if (m) {
			const level = m[1].length;
			const indent = "  ".repeat(Math.max(0, level - 1));
			headings.push(`${indent}- ${m[2].trim()}`);
			pastLead = true;
			continue;
		}
		if (!pastLead && leadLen < leadChars) {
			const t = line.trim();
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

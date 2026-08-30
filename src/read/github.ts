/**
 * GitHub issues/PRs via REST API — HTML pages are chrome soup and our list
 * sanitizer turns them into "[Long list]".
 */

import { fetch } from "undici";
import { fetchWithSafeRedirects, hopHeaders, timeoutSignal } from "../utils.js";
import { sanitizeForContext } from "./markdown.js";
import type { ReadFormat } from "../types.js";

export interface GitHubIssueRef {
	owner: string;
	repo: string;
	kind: "issues" | "pull";
	number: number;
}

const GITHUB_HTML_HOSTS = new Set(["github.com", "www.github.com"]);

/** Parse github.com/{owner}/{repo}/issues|pull/{n} (optional trailing slash / fragment). */
export function parseGitHubIssueUrl(url: string): GitHubIssueRef | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (!GITHUB_HTML_HOSTS.has(u.hostname.toLowerCase())) return null;
	// /owner/repo/issues/123 or /owner/repo/pull/123
	const m = u.pathname.match(
		/^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/|$)/i,
	);
	if (!m) return null;
	const owner = m[1];
	const repo = m[2];
	// skip reserved org-ish paths that aren't repos
	if (owner === "." || owner === ".." || repo.endsWith(".git")) return null;
	const kind = m[3].toLowerCase() === "pull" ? "pull" : "issues";
	const number = Number(m[4]);
	if (!Number.isFinite(number) || number <= 0) return null;
	return { owner, repo, kind, number };
}

function githubToken(): string | undefined {
	const t =
		process.env.GITHUB_TOKEN?.trim() ||
		process.env.GH_TOKEN?.trim() ||
		process.env.GITHUB_API_TOKEN?.trim();
	return t || undefined;
}

async function apiGet(
	apiUrl: string,
	options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ status: number; json: unknown; finalUrl: string }> {
	const headers: Record<string, string> = {
		accept: "application/vnd.github+json",
		"user-agent": "pi-web-complete",
		"x-github-api-version": "2022-11-28",
	};
	const token = githubToken();
	if (token) headers.authorization = `Bearer ${token}`;

	const signal = timeoutSignal(options.signal, options.timeoutMs ?? 30_000);
	const { response, finalUrl } = await fetchWithSafeRedirects(apiUrl, (current, { crossOrigin }) =>
		fetch(current, {
			method: "GET",
			headers: hopHeaders(headers, crossOrigin),
			redirect: "manual",
			signal,
		}),
	);

	const text = await response.text();
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = { message: text.slice(0, 500) };
	}
	return { status: response.status, json, finalUrl };
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : v == null ? "" : String(v);
}

function userLogin(v: unknown): string {
	const r = asRecord(v);
	return r ? str(r.login) : "";
}

function labelNames(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v
		.map((x) => {
			const r = asRecord(x);
			return r ? str(r.name) : "";
		})
		.filter(Boolean);
}

function truncate(content: string, maxChars?: number): string {
	const cleaned = sanitizeForContext(content);
	if (!maxChars || maxChars <= 0 || cleaned.length <= maxChars) return cleaned;
	return cleaned.slice(0, maxChars) + "\n\n…[truncated]";
}

function formatIssueMarkdown(
	ref: GitHubIssueRef,
	issue: Record<string, unknown>,
	comments: Record<string, unknown>[],
	pr?: Record<string, unknown> | null,
): string {
	const number = issue.number ?? ref.number;
	const title = str(issue.title) || "Untitled";
	const state = str(issue.state);
	const htmlUrl = str(issue.html_url) || `https://github.com/${ref.owner}/${ref.repo}/${ref.kind}/${ref.number}`;
	const author = userLogin(issue.user);
	const created = str(issue.created_at);
	const updated = str(issue.updated_at);
	const labels = labelNames(issue.labels);
	const body = str(issue.body).trim() || "_(no description)_";

	const lines: string[] = [
		`# ${ref.owner}/${ref.repo}#${number}: ${title}`,
		"",
		`- **Type:** ${ref.kind === "pull" ? "pull request" : "issue"}`,
		`- **State:** ${state}${issue.draft === true ? " (draft)" : ""}${issue.merged === true || pr?.merged === true ? " (merged)" : ""}`,
		`- **URL:** ${htmlUrl}`,
	];
	if (author) lines.push(`- **Author:** ${author}`);
	if (created) lines.push(`- **Created:** ${created}`);
	if (updated) lines.push(`- **Updated:** ${updated}`);
	if (labels.length) lines.push(`- **Labels:** ${labels.join(", ")}`);

	if (pr) {
		const base = asRecord(pr.base);
		const head = asRecord(pr.head);
		const baseRef = base ? str(base.ref) : "";
		const headRef = head ? str(head.ref) : "";
		if (baseRef || headRef) {
			lines.push(`- **Branches:** ${headRef || "?"} → ${baseRef || "?"}`);
		}
		if (pr.merged_at) lines.push(`- **Merged at:** ${str(pr.merged_at)}`);
	}

	lines.push("", "## Description", "", body);

	if (comments.length > 0) {
		lines.push("", `## Comments (${comments.length})`, "");
		for (const c of comments) {
			const who = userLogin(c.user) || "unknown";
			const when = str(c.created_at);
			const cbody = str(c.body).trim() || "_(empty)_";
			lines.push(`### ${who}${when ? ` · ${when}` : ""}`, "", cbody, "");
		}
	}

	return lines.join("\n").trim() + "\n";
}

function formatAs(
	markdown: string,
	format: ReadFormat,
): string {
	if (format === "markdown") return markdown;
	if (format === "text") {
		return markdown
			.replace(/^#{1,6}\s+/gm, "")
			.replace(/^\s*[-*]\s+\*\*[^*]+\*\*:\s*/gm, "")
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/`([^`]+)`/g, "$1");
	}
	// html — minimal wrap; agents rarely want html for issues
	const escaped = markdown
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	return `<pre>${escaped}</pre>`;
}

export interface GitHubReadResult {
	url: string;
	finalUrl: string;
	title?: string;
	author?: string;
	published?: string;
	site: string;
	language?: string;
	mode: string;
	format: ReadFormat;
	content: string;
	status: number;
	chars: number;
}

/**
 * Fetch issue/PR via api.github.com. Returns null if URL is not a GH issue/PR.
 * Throws on network/API failure after parse match.
 */
export async function tryReadGitHubIssue(
	url: string,
	options: {
		format?: ReadFormat;
		maxChars?: number;
		timeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<GitHubReadResult | null> {
	const ref = parseGitHubIssueUrl(url);
	if (!ref) return null;

	const format = options.format ?? "markdown";
	const base = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
	// Issues API covers both issues and PRs for body + issue comments
	const issueUrl = `${base}/issues/${ref.number}`;
	const commentsUrl = `${base}/issues/${ref.number}/comments?per_page=100`;

	const issueRes = await apiGet(issueUrl, options);
	if (issueRes.status === 404) {
		throw new Error(
			`GitHub ${ref.kind} not found: ${ref.owner}/${ref.repo}#${ref.number}`,
		);
	}
	if (issueRes.status === 403 || issueRes.status === 401) {
		const msg = asRecord(issueRes.json)?.message;
		throw new Error(
			`GitHub API ${issueRes.status}${msg ? `: ${msg}` : ""}. ` +
				`Set GITHUB_TOKEN or GH_TOKEN for private repos / higher rate limits.`,
		);
	}
	if (issueRes.status < 200 || issueRes.status >= 300) {
		const msg = asRecord(issueRes.json)?.message;
		throw new Error(
			`GitHub API error ${issueRes.status}${msg ? `: ${msg}` : ""}`,
		);
	}

	const issue = asRecord(issueRes.json);
	if (!issue) throw new Error("GitHub API returned non-object issue payload");

	let pr: Record<string, unknown> | null = null;
	if (ref.kind === "pull" || issue.pull_request) {
		try {
			const prRes = await apiGet(`${base}/pulls/${ref.number}`, options);
			if (prRes.status >= 200 && prRes.status < 300) {
				pr = asRecord(prRes.json);
			}
		} catch {
			// body from issues endpoint is enough
		}
	}

	let comments: Record<string, unknown>[] = [];
	try {
		const cRes = await apiGet(commentsUrl, options);
		if (cRes.status >= 200 && cRes.status < 300 && Array.isArray(cRes.json)) {
			comments = cRes.json
				.map(asRecord)
				.filter((x): x is Record<string, unknown> => x != null);
		}
	} catch {
		// comments optional
	}

	const md = formatIssueMarkdown(ref, issue, comments, pr);
	const content = truncate(formatAs(md, format), options.maxChars);
	const title = str(issue.title)
		? `${ref.owner}/${ref.repo}#${ref.number}: ${str(issue.title)}`
		: `${ref.owner}/${ref.repo}#${ref.number}`;

	return {
		url,
		finalUrl: str(issue.html_url) || url,
		title,
		author: userLogin(issue.user) || undefined,
		published: str(issue.created_at) || undefined,
		site: "GitHub",
		language: "en",
		mode: "github-api",
		format,
		content,
		status: issueRes.status,
		chars: content.length,
	};
}

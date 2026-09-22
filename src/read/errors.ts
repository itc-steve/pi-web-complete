export type ReadErrorCode =
	| "wall.challenge"
	| "guard.ssrf"
	| "deadline.hit"
	| "archive.stale"
	| "fetch.http";

export function formatReadError(opts: {
	code: ReadErrorCode;
	message: string;
	nextAction: string;
}): string {
	return `[error] ${opts.code}\n${opts.message}\nnext_action: ${opts.nextAction}`;
}

export function ssrfError(detail: string): string {
	return formatReadError({
		code: "guard.ssrf",
		message: detail,
		nextAction: "Do not retry this URL. Only http(s) public hosts (or allowPrivateHosts) are allowed.",
	});
}

export function challengeError(url: string, status: number, reason: string): string {
	return formatReadError({
		code: "wall.challenge",
		message: `Blocked: ${url} ${reason} (HTTP ${status}).`,
		nextAction: "Use web_cowork if a human must pass the check.",
	});
}

export function deadlineError(detail: string): string {
	return formatReadError({
		code: "deadline.hit",
		message: detail,
		nextAction: "Retry with a longer timeout or a smaller page.",
	});
}

export function archiveStaleError(url: string): string {
	return formatReadError({
		code: "archive.stale",
		message: `No usable archived snapshot for ${url}.`,
		nextAction: "Give up or try a different URL.",
	});
}

export function httpError(url: string, status: number): string {
	return formatReadError({
		code: "fetch.http",
		message: `Request failed for ${url} (HTTP ${status}).`,
		nextAction: "Try archive=auto or a different URL.",
	});
}

function detailOf(err: unknown): string {
	if (err instanceof Error) return err.message || err.name;
	return String(err);
}

function nameOf(err: unknown): string {
	if (typeof err === "object" && err !== null) {
		const name = (err as { name?: unknown }).name;
		if (typeof name === "string") return name;
	}
	return "";
}

export function isAbortError(err: unknown): boolean {
	return nameOf(err) === "AbortError" || nameOf(err) === "TimeoutError";
}

export function deadlineErrorFrom(err: unknown): string | null {
	return isAbortError(err) ? deadlineError(detailOf(err)) : null;
}

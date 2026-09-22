import assert from "node:assert/strict";
import {
	archiveStaleError,
	challengeError,
	deadlineError,
	deadlineErrorFrom,
	formatReadError,
	httpError,
	isAbortError,
	ssrfError,
} from "../src/read/errors.js";

const s = formatReadError({
	code: "wall.challenge",
	message: "Blocked: https://ex/ still looks like a challenge (HTTP 403).",
	nextAction: "Use web_cowork if a human must pass the check.",
});
assert.equal(
	s,
	"[error] wall.challenge\nBlocked: https://ex/ still looks like a challenge (HTTP 403).\nnext_action: Use web_cowork if a human must pass the check.",
);

function checkShape(out: string, code: string, nextAction: string) {
	const lines = out.split("\n");
	assert.equal(lines.length, 3);
	assert.match(out, /^\[error\] /);
	assert.equal(lines[0], `[error] ${code}`);
	assert.equal(lines[2], `next_action: ${nextAction}`);
}

checkShape(
	ssrfError("Blocked: 127.0.0.1:8080 is a private host"),
	"guard.ssrf",
	"Do not retry this URL. Only http(s) public hosts (or allowPrivateHosts) are allowed.",
);
assert.match(ssrfError("Blocked: 127.0.0.1:8080 is a private host"), /127\.0\.0\.1:8080/);

checkShape(
	challengeError("https://ex/", 403, "still looks like a challenge"),
	"wall.challenge",
	"Use web_cowork if a human must pass the check.",
);
assert.match(challengeError("https://ex/", 403, "still looks like a challenge"), /https:\/\/ex\//);
assert.match(challengeError("https://ex/", 403, "still looks like a challenge"), /HTTP 403/);

checkShape(
	deadlineError("timed out after 30000ms"),
	"deadline.hit",
	"Retry with a longer timeout or a smaller page.",
);

checkShape(
	archiveStaleError("https://ex/"),
	"archive.stale",
	"Give up or try a different URL.",
);
assert.match(archiveStaleError("https://ex/"), /https:\/\/ex\//);

checkShape(
	httpError("https://ex/", 502),
	"fetch.http",
	"Try archive=auto or a different URL.",
);
assert.match(httpError("https://ex/", 502), /HTTP 502/);

const abort = new DOMException("The operation was aborted", "AbortError");
assert.equal(isAbortError(abort), true);
const timeout = new Error("timed out");
timeout.name = "TimeoutError";
assert.equal(isAbortError(timeout), true);
assert.equal(isAbortError(new Error("boom")), false);
assert.equal(isAbortError({ name: "AbortError", message: "aborted" }), true);
assert.equal(isAbortError(null), false);
assert.equal(isAbortError("nope"), false);

const d = deadlineErrorFrom(abort);
assert.match(d ?? "", /^\[error\] deadline\.hit\nThe operation was aborted\nnext_action: Retry with a longer timeout or a smaller page\.$/);
assert.equal(deadlineErrorFrom(new Error("boom")), null);
assert.equal(deadlineErrorFrom(undefined), null);

console.log("read error helpers passed");

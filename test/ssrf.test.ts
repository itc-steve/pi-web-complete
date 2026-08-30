import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPrivateHostAllowlist, validateUrl } from "../src/utils.js";

assert.match(validateUrl("http://127.0.0.1:8080") ?? "", /private host/);
assert.match(validateUrl("http://[::ffff:127.0.0.1]/") ?? "", /private host/);
assert.match(validateUrl("http://[::ffff:7f00:1]/") ?? "", /private host/);
assert.match(validateUrl("https://[::ffff:169.254.169.254]/") ?? "", /private host/);
assert.match(validateUrl("http://[::ffff:c0a8:1]/") ?? "", /private host/);
assert.match(validateUrl("http://[64:ff9b::7f00:1]/") ?? "", /private host/);
assert.match(validateUrl("http://[::1]/") ?? "", /private host/);
assert.equal(validateUrl("http://[::ffff:8.8.8.8]/"), null);
assert.equal(validateUrl("https://example.com/"), null);

setPrivateHostAllowlist([" LOCALHOST ", "127.0.0.1"]);
assert.equal(validateUrl("http://localhost:8080"), null);
assert.equal(validateUrl("http://127.0.0.1:8080"), null);
assert.match(validateUrl("http://127.0.0.2:8080") ?? "", /private host/);
assert.match(validateUrl("http://metadata.google.internal") ?? "", /private host/);

setPrivateHostAllowlist(["[localhost]"]);
assert.match(validateUrl("http://localhost:8080") ?? "", /private host/);
setPrivateHostAllowlist([]);
assert.match(validateUrl("http://localhost.:8080") ?? "", /private host/);

const home = mkdtempSync(join(tmpdir(), "pi-web-ssrf-"));
const project = join(home, "project");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
mkdirSync(join(project, ".pi"), { recursive: true });
writeFileSync(join(home, ".pi", "agent", "web.json"), '{"allowPrivateHosts":["localhost"]}');
writeFileSync(join(project, ".pi", "web.json"), '{"allowPrivateHosts":["metadata.google.internal"]}');
const originalHome = process.env.HOME;
try {
	process.env.HOME = home;
	const { refreshConfig } = await import("../src/config.js");
	refreshConfig(project, true);
	assert.equal(validateUrl("http://localhost:8080"), null);
	assert.match(validateUrl("http://metadata.google.internal") ?? "", /private host/);

	mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "web.json"), "not json");
	writeFileSync(
		join(home, ".pi", "agent", "extensions", "search.json"),
		'{"allowPrivateHosts":["localhost"]}',
	);
	refreshConfig(project, true);
	assert.match(validateUrl("http://localhost:8080") ?? "", /private host/);
} finally {
	process.env.HOME = originalHome;
	setPrivateHostAllowlist([]);
	rmSync(home, { recursive: true, force: true });
}

console.log("SSRF private-host allowlist checks passed");

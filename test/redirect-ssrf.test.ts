import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { BrowserContext, Route } from "playwright-core";
import { installBrowserUrlGuard } from "../src/browser-guard.js";
import { fetchUrl } from "../src/read/fetch.js";
import { fetchWithSafeRedirects, hopHeaders, setPrivateHostAllowlist } from "../src/utils.js";

async function listen(
	host: string,
	handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, host, resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing server address");
	return { server, url: `http://${host}:${address.port}` };
}

let blockedRequests = 0;
const blocked = await listen("127.0.0.2", (_req, res) => {
	blockedRequests++;
	res.end("should not be reached");
});
const allowed = await listen("127.0.0.1", (_req, res) => {
	res.writeHead(302, { location: blocked.url });
	res.end();
});

const mappedLocation = (() => {
	const target = new URL(blocked.url);
	return `http://[::ffff:127.0.0.2]:${target.port}/`;
})();
const mappedRedirect = await listen("127.0.0.1", (_req, res) => {
	res.writeHead(302, { location: mappedLocation });
	res.end();
});

try {
	setPrivateHostAllowlist(["127.0.0.1"]);
	await assert.rejects(fetchUrl(allowed.url), /private host 127\.0\.0\.2/);
	assert.equal(blockedRequests, 0, "blocked redirect target must not receive a request");
	await assert.rejects(fetchUrl(mappedRedirect.url), /private host/);
	assert.equal(blockedRequests, 0, "mapped-IPv6 redirect must not be fetched");
} finally {
	setPrivateHostAllowlist([]);
	allowed.server.close();
	blocked.server.close();
	mappedRedirect.server.close();
}

let routeHandler: ((route: Route) => Promise<void>) | undefined;
const target = {
	route: async (_url: string, handler: (route: Route) => Promise<void>) => {
		routeHandler = handler;
	},
} as unknown as BrowserContext;
await installBrowserUrlGuard(target);
let aborted = false;
await routeHandler!({
	request: () => ({ url: () => "http://127.0.0.2:8080" }),
	abort: async () => {
		aborted = true;
	},
	continue: async () => assert.fail("blocked browser request continued"),
} as unknown as Route);
assert.equal(aborted, true);

let mappedAborted = false;
await routeHandler!({
	request: () => ({ url: () => "http://[::ffff:127.0.0.1]/" }),
	abort: async () => {
		mappedAborted = true;
	},
	continue: async () => assert.fail("mapped IPv6 browser request continued"),
} as unknown as Route);
assert.equal(mappedAborted, true);

assert.deepEqual(
	hopHeaders({ authorization: "Bearer t", accept: "*/*" }, false),
	{ authorization: "Bearer t", accept: "*/*" },
);
assert.deepEqual(hopHeaders({ authorization: "Bearer t", Cookie: "a=b", accept: "*/*" }, true), {
	accept: "*/*",
});

const hops: Array<{ url: string; authorization?: string }> = [];
await fetchWithSafeRedirects("https://api.github.com/x", async (url, { crossOrigin }) => {
	const headers = hopHeaders({ authorization: "Bearer secret", accept: "*/*" }, crossOrigin);
	hops.push({ url, authorization: headers.authorization });
	if (url === "https://api.github.com/x") {
		return {
			status: 302,
			headers: { get: (name: string) => (name === "location" ? "https://evil.example/" : null) },
		};
	}
	return { status: 200, headers: { get: () => null } };
});
assert.equal(hops[0]?.authorization, "Bearer secret");
assert.equal(hops[1]?.authorization, undefined);
assert.equal(hops[1]?.url, "https://evil.example/");

console.log("Redirect SSRF checks passed");

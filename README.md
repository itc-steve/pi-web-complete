<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="pi-web-complete routes Pi agent requests through search, local reading, shared browser control, and current documentation">
</p>

# pi-web-complete

Give [Pi](https://github.com/badlogic/pi-mono) one extension for web discovery, clean local extraction, browser interaction and debugging, and version-current framework docs.

```bash
pi install npm:@itc-steve/pi-web-complete
```

## One extension, four jobs

| Tool | Use it for | What makes it useful |
| --- | --- | --- |
| **`web_search`** | Current facts and discovery | Brave, Serper, Tavily, Exa, and Linkup with shuffled fallback |
| **`web_read`** | Reading a URL | Local extraction with query-ranked excerpts by default; `web_fetch` alias included |
| **`web_cowork`** | Browser interaction and debugging | External-window or headless CloakBrowser with shared control, DevTools inspection, and raw CDP |
| **`context7`** | Library and framework APIs | Version-current documentation, registered only when configured |

`web_search` finds the page. `web_read` turns it into focused context. `web_cowork` handles pages that need a person or browser UI. `context7` keeps implementation work grounded in current docs.

## Quick start

### 1. Install

```bash
pi install npm:@itc-steve/pi-web-complete
```

From a local checkout:

```bash
pi install /path/to/pi-web-complete
```

### 2. Configure

Configuration and secrets live in separate files:

```bash
cp /path/to/pi-web-complete/web.json.example ~/.pi/agent/web.json
cp /path/to/pi-web-complete/web.env.example ~/.pi/agent/web.env
chmod 600 ~/.pi/agent/web.env
# edit web.json, then paste your keys into web.env
```

`~/.pi/agent/web.json`:

```json
{
  "defaultBackend": "auto",
  "allowPrivateHosts": [],
  "backends": {
    "brave":  { "enabled": true, "apiKeyEnv": "BRAVE_API_KEY" },
    "serper": { "enabled": true, "apiKeyEnv": "SERPER_API_KEY" },
    "tavily": { "enabled": true, "apiKeyEnv": "TAVILY_API_KEY" },
    "exa":    { "enabled": true, "apiKeyEnv": "EXA_API_KEY" },
    "linkup": { "enabled": true, "apiKeyEnv": "LINKUP_API_KEY", "depth": "standard" }
  },
  "context7": { "enabled": true, "apiKeyEnv": "CONTEXT7_API_KEY" }
}
```

`~/.pi/agent/web.env`:

```bash
BRAVE_API_KEY=replace-with-brave-key
SERPER_API_KEY=replace-with-serper-key
TAVILY_API_KEY=replace-with-tavily-key
EXA_API_KEY=replace-with-exa-key
LINKUP_API_KEY=replace-with-linkup-key
CONTEXT7_API_KEY=replace-with-context7-key
GITHUB_TOKEN=replace-with-github-token
```

Project overrides can live in `.pi/web.json` and `.pi/web.env`. Project JSON overrides global top-level settings while `backends` merge per backend; project secrets overlay global secrets. Keep key values in `.env`, never JSON.

### 3. Use

```text
web_search({ query: "Node.js fetch timeout patterns", compact: true })
web_read({ url: "https://example.com/guide", query: "authentication setup" })
web_cowork({ action: "open", url: "https://example.com/login" })
context7({ library: "next.js", query: "app router middleware auth" })
```

## Read pages without flooding context

<p align="center">
  <img src="./assets/readme/read-pipeline.svg" width="100%" alt="web_read escalates from fast HTTP through fingerprinting and Readability to CloakBrowser only as needed, then returns ranked excerpts">
</p>

`web_read` acquires the full page locally, then returns only the most relevant chunks for the query. Automatic mode escalates through fast HTTP, TLS-fingerprint fetch, alternate links, Readability, and CloakBrowser only when earlier paths are blocked or too sparse. It also follows short meta-refresh redirects up to five hops.

```text
web_read({ url, query: "HTTP caching Cache-Control" })
```

- Default: ranked excerpts with a roughly 6k-character budget.
- No query: compact page outline.
- `return: "full"`: complete main content, capped around 12k characters in chat.
- `savePath` or `saveDir`: full extract goes to disk; chat receives a short summary.
- `mode: "browser"`: force CloakBrowser rendering.
- GitHub issues and pull requests: clean bodies and comments through GitHub REST API; optional `GITHUB_TOKEN` or `GH_TOKEN` raises limits and enables private repositories.
- Metadata when available: author, publication date, site, and language.
- `maxBytes`: download cap with a 2 MB floor and 5 MB default; oversized bodies truncate instead of failing.

```text
web_read({ url, mode: "browser", saveDir: "~/vault/http-caching" })
```

URLs are restricted to HTTP(S). Requests to localhost, private IP ranges (including IPv4-mapped IPv6), and common internal or metadata hostnames are refused by default. This check is hostname-level and does not resolve DNS (`127.0.0.1.nip.io` is not treated as loopback). To test a trusted local app, explicitly allow its exact hostname (not a URL or wildcard) in global `~/.pi/agent/web.json`:

```json
{ "allowPrivateHosts": ["localhost", "127.0.0.1"] }
```

The allowlist applies to initial URLs and redirects in both `web_read` and `web_cowork`. Project config cannot relax it. Only allow hosts you trust because pages can access services on every port permitted by the URL guard.

## Search with fallback

Auto mode shuffles enabled backends that have resolvable keys. Empty results and provider failures move to the next backend; aborts stop immediately.

- Pin a provider with `backend: "brave"`, `"serper"`, `"tavily"`, `"exa"`, or `"linkup"`.
- Use `compact: true` for title-and-URL results while exploring.
- Limit `numResults` from 1 to 20.
- Set defaults in `web.json`.

Key resolution order for every `apiKeyEnv`:

1. `process.env[apiKeyEnv]`
2. `.pi/web.env`
3. `~/.pi/agent/web.env`
4. Legacy literal `apiKey` in JSON

Legacy JSON paths remain supported when the new paths are absent: `~/.pi/agent/extensions/search.json` and `.pi/search.json`.

## Work together in an external or headless browser

`web_cowork` keeps one persistent CloakBrowser session open. Default mode is an external desktop window shared by agent and user; set `headless` for automation. Headless is create-time only: a live session is reused even if a later `open` passes a different flag. Close first to switch. `wait` needs a visible window. Use `web_read` for one-shot extraction.

```text
web_cowork({ action: "open", url: "https://example.com/login" })
web_cowork({ action: "wait", message: "Log in, then continue" })
web_cowork({
  action: "batch",
  fills: [
    { ref: "@e3", text: "name@example.com" },
    { ref: "@e4", text: "hello" }
  ],
  clickRef: "@e5"
})
web_cowork({ action: "close" })
```

State-changing actions return fresh, bounded interactive refs. `snapshot` supports `interactive`, `content`, and `both` modes. Password and secret-looking values appear as `[redacted]`.

Persist sessions and choose a download directory with:

```json
{
  "cowork": {
    "userDataDir": "~/.cloakbrowser/cowork-profile",
    "downloadDir": "~/Downloads",
    "headless": false
  }
}
```

Downloads default to `~/Downloads` and apply to cowork sessions and browser-rendered reads.

Developer actions expose console and network capture, JavaScript evaluation, screenshots, accessibility trees, tab selection, and raw Chrome DevTools Protocol on page or browser targets. CDP uses Pi's existing Playwright connection; no loopback debugging port is opened. Blocked: Fetch interception, Target create/attach/close, and Browser/Page crash/close (case-insensitive). Raw CDP can still read cookies and run `Runtime.evaluate` against the persistent profile.

## Get current library docs

`context7` resolves a plain package name or accepts a Context7 library ID, then returns documentation ranked for the task. Get an API key at [context7.com/dashboard](https://context7.com/dashboard).

```text
context7({ library: "next.js", query: "app router middleware auth" })
context7({ library: "/vercel/next.js/v14.3.0", query: "server actions form validation" })
```

- Registered only when a Context7 key resolves.
- IDs can be version-pinned with `/v14.3.0` or `@v14.3.0`.
- Results are capped at 12k characters; narrow the query when truncated.
- `fast: true` skips LLM reranking for lower latency and lower relevance.
- Set `"enabled": false` to keep the key configured while hiding the tool.

## Tool reference

| Tool | Parameters |
| --- | --- |
| `web_search` | `query`, `numResults`, `backend`, `compact` |
| `web_read` / `web_fetch` | `url`, `query`, `return`, `mode`, `format`, `onlyMainContent`, `maxChars`, `maxBytes`, `headless`, `savePath`, `saveDir` |
| `web_cowork` | `action`, `url`, `mode`, `ref`, `role`, `name`, `selector`, `text`, `clear`, `fills`, `clickRef`, `key`, `deltaY`, `query`, `maxChars`, `message`, `timeoutMs`, `headless`, `pageIndex`, `expression`, `method`, `cdpParams`/`params`, `target`, `filter`, `fullPage` |
| `context7` | `library`, `query`, `fast` |

### Cowork actions

| Action | Purpose |
| --- | --- |
| `open`, `navigate` | Open or move the shared browser and return fresh refs |
| `wait` | Pause for user input, then return optional note and fresh refs |
| `snapshot` | Read interactive refs, content, or both |
| `click`, `type`, `press`, `scroll` | Act on the latest ref; role and name are fallbacks |
| `batch` | Fill 1–10 fields, then optionally click once |
| `console`, `network` | Drain captured developer events; optional substring filter |
| `evaluate`, `screenshot`, `a11y` | Inspect page runtime, pixels, or accessibility tree |
| `pages`, `select` | List tabs or choose active tab by zero-based index |
| `cdp` | Send raw CDP method and parameters to page or browser target |
| `status`, `close` | Inspect or end the session |

## Runtime behavior

- Node.js 20.18.1+ is required.
- `postinstall` runs `cloakbrowser install` and stores stealth Chromium under `~/.cloakbrowser/`.
- CloakBrowser checks for browser updates at launch. Tagged update logs are hidden because direct console output corrupts Pi's TUI; set `DEBUG=1` to show them or `CLOAKBROWSER_AUTO_UPDATE=false` to disable checks.
- Footer status remains empty until a service is used. Successful providers accumulate as a sorted service list; active reads and cowork sessions show brief progress.
- Set `"showStatus": false` to disable footer updates.
- Set `"read": { "headless": false }` or pass `headless: false` to show browser-rendered one-shot reads.

## License

[MIT](./LICENSE)

CloakBrowser's JavaScript wrapper is MIT-licensed. Its downloaded Chromium binary uses CloakBrowser's separate binary license; see its [LICENSE](https://github.com/CloakHQ/CloakBrowser/blob/main/LICENSE) and [BINARY-LICENSE.md](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md).

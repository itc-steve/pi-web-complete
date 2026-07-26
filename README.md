# pi-web-complete

Pi extension providing complete web access through three tools:

- **`web_search`** — search across brave, serper, tavily, exa, and linkup (random pick with fallback)
- **`web_read`** (aliases: `web_fetch`, `web_fetch_and_index`) — fetch a URL locally (undici → TLS-fingerprint fetch → CloakBrowser), returning **query-ranked excerpts by default** (or full page / vault save). Extraction is always local.
- **`web_cowork`** — open a **visible** CloakBrowser window for shared control (user + agent click/type/navigate)
- **`context7`** — up-to-date, version-current library/framework docs and code snippets from [Context7](https://context7.com) (registered only when a Context7 API key is configured)

## Requirements

- Node.js 20+ (uses `AbortSignal.any`, native `fetch`)
- The `postinstall` script runs `cloakbrowser install`, which prefetches the stealth Chromium binary into `~/.cloakbrowser/` (auto-updates on launch by default)

## Install

```bash
pi install npm:@itc-steve/pi-web-complete
```

From a local checkout:

```bash
pi install /path/to/pi-web-complete
```

## Config (two files side by side)

Same pattern as pi-fgt: JSON has no secrets; keys live in a sibling `.env` file.

| File | Purpose |
|------|---------|
| `~/.pi/agent/web.json` | Defaults, enabled backends, `apiKeyEnv` **names** (no secrets) |
| `~/.pi/agent/web.env` | Actual API keys as `KEY=value` |
| `.pi/web.json` | Optional project override (deep-merges per backend) |
| `.pi/web.env` | Optional project secrets (overlay global `web.env`) |

```bash
cp /path/to/pi-web-complete/web.json.example ~/.pi/agent/web.json
cp /path/to/pi-web-complete/web.env.example  ~/.pi/agent/web.env
chmod 600 ~/.pi/agent/web.env
# edit both — enable backends in JSON, paste keys in the .env
```

Legacy JSON paths still load if the new ones are missing: `~/.pi/agent/extensions/search.json` and `.pi/search.json`.

### `web.json`

```json
{
  "defaultBackend": "auto",
  "backends": {
    "brave":  { "enabled": true, "apiKeyEnv": "BRAVE_API_KEY" },
    "tavily": { "enabled": true, "apiKeyEnv": "TAVILY_API_KEY" }
  },
  "context7": { "enabled": true, "apiKeyEnv": "CONTEXT7_API_KEY" }
}
```

### `web.env` (secrets)

```bash
BRAVE_API_KEY=your-brave-key-here
TAVILY_API_KEY=your-tavily-key-here
CONTEXT7_API_KEY=your-context7-key-here
```

Key resolve order (per backend `apiKeyEnv`):

1. `process.env[apiKeyEnv]` (shell export wins if set)
2. `.pi/web.env` (project)
3. `~/.pi/agent/web.env` (global)
4. Legacy literal `apiKey` in JSON (deprecated — still works so old configs don't break)

Never put the key string in the JSON.

### Search dispatch

Auto mode shuffles **enabled backends that have an `apiKey`**: random primary, then the rest as fallback. Empty results and failures try the next provider; aborts stop immediately.

- Pin with tool param `backend: "brave"` (etc.), or set `defaultBackend` in config.

### Context7 (live library docs)

The `context7` tool is **registered only if a Context7 key resolves** — no key, no tool in the prompt. Get one at [context7.com/dashboard](https://context7.com/dashboard), then:

```json
"context7": {
  "enabled": true,
  "apiKeyEnv": "CONTEXT7_API_KEY",
  "timeout": 30000,
  "fast": false
}
```

When present, the agent is instructed to call `context7` **before writing code against any third-party library** rather than trusting training-data memory:

```text
context7({ library: "next.js", query: "app router middleware auth" })
context7({ library: "/vercel/next.js/v14.3.0", query: "server actions form validation" })
```

- `library` accepts a plain name (resolved via `/api/v2/libs/search`) or a Context7 ID `/owner/repo`, optionally version-pinned with `/v14.3.0` or `@v14.3.0`.
- `query` is the actual task — snippets are LLM-reranked against it.
- `fast: true` skips reranking for lower latency (config default via `context7.fast`).
- Set `"enabled": false` to keep the key but hide the tool.

### Read behavior

`web_read` `auto` mode escalates: fast HTTP → TLS-fingerprint fetch (if blocked) → `rel=alternate` fallback (if thin) → Readability (if sparse) → CloakBrowser (if still thin/SPA).

Also follows short client-side meta-refresh redirects (≤10s delay, max 5 hops) and surfaces page metadata when available: **author**, **published**, **site**, **language**.

**GitHub issues / PRs** (`github.com/{owner}/{repo}/issues|pull/{n}`) are fetched via the **GitHub REST API** (`mode: github-api`) instead of HTML — bodies and comments come through cleanly. Optional `GITHUB_TOKEN` / `GH_TOKEN` for private repos and higher rate limits. Force HTML/browser with `mode: "browser"`.

Toggle a visible browser window for one-shot `web_read` via config or tool param:

```json
"read": { "headless": false }
```

Or per call: `web_read({ url, headless: false })`.

### CloakBrowser downloads & profiles

For **web_cowork**, the window is always headed. Persist logins with:

```json
"cowork": {
  "userDataDir": "~/.cloakbrowser/cowork-profile",
  "downloadDir": "~/Downloads"
}
```

Downloads default to `~/Downloads` (Chrome prefs + Playwright `downloadsPath`). Override with `cowork.downloadDir` — this applies to both `web_cowork` sessions and `web_read` browser renders.

### CloakBrowser update notices

CloakBrowser checks for a newer stealth Chromium on launch and logs progress with plain `console.log` / `console.warn` (`[cloakbrowser] Newer Chromium available…`). Pi's TUI owns stdout with differential rendering, so those unaccounted writes shift the cursor and the notice appears to land **inside the input box**.

The extension installs a console filter at startup that drops `[cloakbrowser]`-tagged lines. Updates still run normally — only the terminal output is suppressed. Set `DEBUG=1` to see them again, or `CLOAKBROWSER_AUTO_UPDATE=false` to stop the checks entirely.

### Footer status

By default the footer is empty until something is used this session. Successful fetches accumulate into one clean **services** list (cleared each session):

- `brave, context7, serper` — search backends and Context7 that returned data this session (sorted, names only)
- While a fetch is in flight: brief progress (`🔍 Brave: searching…`, `context7: fetching…`), then back to the list
- While `web_cowork` is open: `🌐 cowork: …` (cleared on close; never shows `cowork: closed`)
- `web_read` shows progress briefly, then clears

Disable all footer updates with `"showStatus": false`.

## Tools

| Tool | Params |
| ---- | ------ |
| `web_search` | `query`, `numResults`, `backend`, `compact` |
| `web_read` | `url`, `query`, `return`, `mode`, `format`, `onlyMainContent`, `maxChars`, `maxBytes`, `headless`, `savePath`, `saveDir` |
| `web_cowork` | `action`, `url`, `mode`, `ref`, `role`, `name`, `selector`, `text`, `clear`, `key`, `deltaY`, `query`, `maxChars`, `message`, `timeoutMs` |
| `context7` | `library`, `query`, `fast` |

### web_read (excerpts by default)

By default, chat gets **ranked excerpts**, not the whole page:

```text
web_read({ url, query: "HTTP caching Cache-Control" })
```

- Pass `query` with what you need — local keyword/heading scoring picks relevant sections (~6k char budget by default).
- Omit `query` → page outline (headings + short lead) and a nudge to focus or request full.
- `return: "full"` → entire main-content markdown (capped at ~12k chars in chat unless `maxChars` overrides).
- CloakBrowser / HTTP still acquire the full page; ranking happens after markdown extraction.
- `maxBytes` caps the download size (floored at 2 MB, default 5 MB; oversized bodies truncate rather than fail).

**Multi-page / vault scrapes:** set `saveDir` (or `savePath`). Full content goes to disk; the model only gets a short summary — prevents context overflow.

```text
web_read({ url, mode: "browser", saveDir: "~/vault/http-caching" })
```

Safety: URLs are validated before fetching — only http/https, and requests to localhost, private IP ranges, and common internal/metadata hostnames are refused (hostname-level check; no DNS resolution).

### web_cowork (shared control)

Opens a persistent visible CloakBrowser session so you and the agent can both interact with the page.

| Action | Purpose |
| ------ | ------- |
| `open` | Launch (or reuse) headed session and goto `url` |
| `navigate` | Goto `url` in the existing session |
| `wait` | Pause for user interaction (UI prompt when available) |
| `snapshot` | **Default: interactive refs** (`@e1`…) for clicking; `mode=content` / `query` for reading |
| `click` / `type` / `press` / `scroll` | Prefer `ref: "@e3"` from the last snapshot (role+name / text / CSS as fallback) |
| `status` / `close` | Session state / tear down |

Typical flow:

```text
web_cowork({ action: "open", url: "https://example.com/login" })
web_cowork({ action: "wait", message: "Log in, then continue" })
web_cowork({ action: "snapshot" })
web_cowork({ action: "click", ref: "@e3" })
web_cowork({ action: "type", ref: "@e5", text: "hello", clear: true })
web_cowork({ action: "snapshot" })
web_cowork({ action: "close" })
```

Snapshot modes: `interactive` (default), `content` (markdown/excerpts), `both`. Refs are invalidated after click/navigate/wait/scroll — always snapshot again before the next action. Values of password/secret-looking fields are shown as `[redacted]` in snapshots.

Prefer `web_read` for one-shot extraction without user interaction.

## License

This package is MIT-licensed. See [LICENSE](./LICENSE).

**Third-party note:** [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) is a dependency. Its JavaScript wrapper is MIT, but the Chromium binary downloaded by `postinstall` / `cloakbrowser install` is covered by CloakBrowser’s separate binary license — not by this package’s MIT license. See CloakBrowser’s [LICENSE](https://github.com/CloakHQ/CloakBrowser/blob/main/LICENSE) and [BINARY-LICENSE.md](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md).

# Changelog

## 3.3.0 - 2026-09-22

### Added

- `web_read` extracts PDF text (pdf-parse). Scanned/OCR PDFs still placeholder.
- Dead links (404/410 or network failure) retry via Wayback (`archive=auto`, default). Snapshot age is labeled. `archive=never` skips.
- Stable read errors: `[error] <code>` plus `next_action` for `wall.challenge`, `guard.ssrf`, `deadline.hit`.
- CloakBrowser challenge cookies are reused on later HTTP fetches for that host (session jar, cleared on session start).
- `stitch=true` follows same-origin `rel=next` for up to three extra pages.

### Fixed

- Cowork screenshots retain mobile emulation instead of restoring Playwright's stale desktop viewport. Device labels are per-tab; open/emulate include observed CSS viewport dimensions.
- Cowork defaults to headless on Linux without display variables. Explicit headed requests fail early with guidance to use headless or provide a display server.

### Changed

- Footer chips are one line below the editor (not `setStatus` rows). Empty leftover keys are deleted so they cannot become blank footer lines. Reads, cowork, and used services share that single chip.

## 3.2.1 - 2026-09-17

### Added

- `web_cowork` `action=emulate` switches Chrome device mode (`device=mobile` / `device=desktop`). Mobile uses Pixel 7 metrics with `mobile:true`, touch, and a mobile UA/client hints — not a window resize. Optional `device` on `open`. Default remains desktop.

### Fixed

- Compact `web_search` results keep full URLs instead of truncating them at 50 characters.

## 3.2.0 - 2026-09-14

### Added

- `/web` command toggles `web_search` and `web_cowork` on or off for the current session (`/web [search|cowork] [on|off]`, bare target flips, `/web` reports status).
- `search.enabled` and `cowork.enabled` in `web.json` set the per-session default for both tools; both default to enabled.

## 3.1.0 - 2026-08-31

### Changed

- Auto `web_read` keeps a per-host climb floor for the session after a confirmed block (status or `cf-mitigated`), so later reads of that host skip HTTP.
- Residual challenge pages after the top tier are omitted; the tool returns a blocked notice instead of challenge HTML.
- Session start clears host floors so a new Pi session starts from the fast HTTP tier.

## 3.0.0 - 2026-08-30

### Added

- Cowork developer actions for console, network, JavaScript, screenshots, accessibility, tabs, and raw page/browser CDP.
- Configurable headless cowork sessions; external desktop window remains default. Headless applies only when creating a session.
- `allowPrivateHosts` in global `~/.pi/agent/web.json` for trusted loopback/LAN names. Project config cannot widen it.
- Hop-by-hop redirect checks in `web_read` fetch paths and a Playwright request guard for browser navigation.

### Changed

- IPv4-mapped, IPv4-compatible, and NAT64 IPv6 literals are classified as their embedded IPv4 address for SSRF checks.
- Cross-origin redirects drop `Authorization`, `Cookie`, and `Proxy-Authorization`.
- CDP denylist now covers Target attach/close, `Page.crash`, and `Browser.crashGpuProcess`, case-insensitively. Cookie dumps and `Runtime.evaluate` remain available on the persistent profile.

### Removed

- **Breaking:** Herdr pane rendering, `cowork.herdr` config, `verify:herdr`, and the unauthenticated loopback CDP endpoint.

## 2.0.0 - 2026-08-27

### Added

- `web_cowork` now returns bounded, viewport-first refs after browser actions.
- Added narrow `batch` form filling with one optional final click.
- `wait` now returns user notes and cancellation state.

### Changed

- Context7 output is capped at 12k characters.

### Removed

- **Breaking:** Retired the `web_fetch_and_index` alias; use `web_read` or `web_fetch`.

## 1.3.0

### Added

- Optional Herdr rendering for `web_cowork`. The agent controls Chromium with the existing cowork actions while the user watches or takes control in a Herdr pane.
- In-pane tabs, navigation controls, URL entry, page zoom, mouse input, keyboard input, and scrolling.
- `npm run verify:herdr` for graphics, browser, and interaction checks.
- Configuration for split direction, focus, browser zoom, diagnostics, capture scale, frame skipping, fallback behavior, and the CDP port.

### Changed

- `web_cowork` uses the same persistent browser profile in desktop and Herdr modes.
- If Herdr graphics are unavailable, cowork reports the cause and opens a desktop window by default.
- The README now presents Herdr integration near the top and links to the full setup guide.
- Requires Node.js 20.18.1+ (`undici` 7).
- Cowork navigation allows `file://` for user-driven local pages.

### Fixed

- Sanitized page titles and URLs before rendering them in the terminal.
- Added viewer readiness checks, pane cleanup, bounded network waits, and frame backpressure.
- Preserved terminal input order and fixed standalone Escape handling.

## 1.2.1

### Changed

- Published through npm trusted publishing with OIDC.

## 1.2.0

### Added

- Context7 documentation search.
- Query-ranked web extraction and improved search results.

## 1.1.1

### Fixed

- GitHub issues and pull requests now fetch through the REST API.

## 1.1.0

### Added

- `web.env` secret loading, read metadata, and alternate extraction paths.

## 1.0.0

### Added

- Initial `web_search`, `web_read`, and `web_cowork` release.

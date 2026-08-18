# Changelog

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

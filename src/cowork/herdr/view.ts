/**
 * Herdr browser view — runs INSIDE a Herdr pane as its own process.
 *
 * Frames:  CDP Page.screencast → pane.graphics.stream
 * Input:   raw stdin (SGR mouse + keys) → CDP Input.*
 * Chrome:  attaches over CDP to a browser Pi already launched.
 *
 * Launched by the Pi extension via `herdr pane split` (see pane.ts). Reads its
 * settings from env because a pane command is plain argv.
 *
 * Env:
 *   PI_HERDR_VIEW_CDP        browser CDP http endpoint (required)
 *   PI_HERDR_VIEW_TOOLBAR    "0" to hide the toolbar
 *   PI_HERDR_VIEW_DIAG       "1" to show the diagnostics row
 *   PI_HERDR_VIEW_SCALE      capture scale 0.1..1
 *   PI_HERDR_VIEW_NTH        screencast everyNthFrame (1|2)
 *   PI_HERDR_VIEW_ZOOM       initial page zoom
 *   PI_HERDR_VIEW_URL        initial URL for a fresh tab
 */

import { appendFileSync, writeFileSync } from "node:fs";

import { browserWsUrl, CdpClient } from "./cdp.js";
import {
	computeLayout,
	cellToPagePixel,
	deviceMetricsForLayout,
	type ViewLayout,
} from "./geometry.js";
import {
	cdpModifiers,
	DISABLE_MOUSE,
	ENABLE_MOUSE,
	ENTER_ALT_SCREEN,
	keyToCdp,
	LEAVE_ALT_SCREEN,
	parseAll,
	type KeyEvent,
	type MouseEvent,
	type TermEvent,
} from "./input.js";
import {
	GraphicsStream,
	herdrRequest,
	requireGraphicsSupport,
	type CellSize,
} from "./socket.js";
import { hitTest, renderToolbar, type TabEntry, type ToolbarAction } from "./toolbar.js";

const PASSIVE_FPS = 15;
const ACTIVE_FPS = 30;
const ZOOM_STEP = 0.05;
const ACTIVE_WINDOW_MS = 750;

const logPath = process.env.PI_HERDR_VIEW_LOG;
function log(msg: string): void {
	if (!logPath) return;
	try {
		appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// logging must never break the view
	}
}

function envNum(name: string, fallback: number): number {
	const raw = process.env[name];
	const n = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(n) ? n : fallback;
}

interface PaneGeometry {
	cols: number;
	rows: number;
}

/**
 * Writable size of this pane, in cells.
 *
 * Uses the PTY size, NOT pane.layout: Herdr's layout rect includes pane
 * decoration, so it is a few cells larger than the area a process can actually
 * write (measured 86x36 layout vs 83x34 PTY). Painting at the layout width
 * wraps the last toolbar cells off-screen, which made [+] unclickable.
 * pane.layout is only a fallback for when there is no TTY.
 */
async function paneGeometry(paneId: string): Promise<PaneGeometry> {
	const ttyCols = process.stdout.columns;
	const ttyRows = process.stdout.rows;
	if (typeof ttyCols === "number" && ttyCols > 0 && typeof ttyRows === "number" && ttyRows > 0) {
		return { cols: ttyCols, rows: ttyRows };
	}

	const result = (await herdrRequest("pane.layout", { pane_id: paneId })) as {
		layout?: {
			panes?: Array<{ pane_id: string; rect: { width: number; height: number } }>;
		};
	};
	const mine = result.layout?.panes?.find((p) => p.pane_id === paneId);
	if (!mine) throw new Error(`pane ${paneId} not present in its own layout`);
	// Decoration allowance so the toolbar never wraps when we must guess.
	return { cols: Math.max(1, mine.rect.width - 3), rows: Math.max(1, mine.rect.height - 2) };
}

class BrowserView {
	private readonly cdp = new CdpClient();
	private stream: GraphicsStream | undefined;
	private cell: CellSize = { cellWidthPx: 0, cellHeightPx: 0 };
	private layout!: ViewLayout;
	private pane: PaneGeometry = { cols: 80, rows: 24 };

	private sessionId: string | undefined;
	private targetId: string | undefined;
	private tabs: TabEntry[] = [];
	private url = "";
	private loading = false;
	private zoom = envNum("PI_HERDR_VIEW_ZOOM", 1);
	private urlEditing: string | undefined;

	private lastActivity = 0;
	private frameQueue = Promise.resolve();
	private lastFrameAt = 0;
	private framesSent = 0;
	private stdinRest = "";
	private escapeTimer: ReturnType<typeof setTimeout> | undefined;
	private inputQueue = Promise.resolve();
	private mouseDown = false;
	private lastMove = { x: 0, y: 0 };
	private shuttingDown = false;
	private toolbarRegions: ReturnType<typeof renderToolbar>["regions"] = [];

	constructor(
		private readonly paneId: string,
		private readonly cdpHttp: string,
		private readonly showToolbar: boolean,
		private readonly showDiagnostics: boolean,
		private readonly captureScale: number,
		private readonly everyNthFrame: number,
	) {}

	private get toolbarRows(): number {
		return this.showToolbar ? 2 : 0;
	}

	private get statusRows(): number {
		return this.showDiagnostics ? 1 : 0;
	}

	async start(): Promise<void> {
		this.cell = await requireGraphicsSupport(this.paneId);
		this.pane = await paneGeometry(this.paneId);
		this.recomputeLayout();
		log(`geometry cols=${this.pane.cols} rows=${this.pane.rows} (tty=${process.stdout.columns}x${process.stdout.rows})`);

		const wsUrl = await browserWsUrl(this.cdpHttp);
		await this.cdp.connect(wsUrl);
		this.cdp.onClose(() => {
			log("cdp closed");
			void this.shutdown(0);
		});

		this.stream = new GraphicsStream(this.paneId);
		await this.stream.open();

		await this.cdp.send("Target.setDiscoverTargets", { discover: true });
		this.cdp.onAny("Target.targetCreated", () => void this.refreshTabs());
		this.cdp.onAny("Target.targetDestroyed", () => void this.onTargetGone());
		this.cdp.onAny("Target.targetInfoChanged", () => void this.refreshTabs());

		await this.attachToActiveTab();
		this.wireStdin();
		this.wireResize();
		this.paint();
		log(`view started pane=${this.paneId} cell=${JSON.stringify(this.cell)}`);
		const readyPath = process.env.PI_HERDR_VIEW_READY;
		if (readyPath) writeFileSync(readyPath, "ready\n", { mode: 0o600 });
	}

	private recomputeLayout(): void {
		this.layout = computeLayout({
			paneCols: this.pane.cols,
			paneRows: this.pane.rows,
			cellWidthPx: this.cell.cellWidthPx,
			cellHeightPx: this.cell.cellHeightPx,
			toolbarRows: this.toolbarRows,
			statusRows: this.statusRows,
			captureScale: this.captureScale,
		});
	}

	// ---------- targets / tabs ----------

	private async pageTargets(): Promise<
		Array<{ targetId: string; title: string; url: string; type: string }>
	> {
		const result = (await this.cdp.send("Target.getTargets")) as {
			targetInfos?: Array<{ targetId: string; title: string; url: string; type: string }>;
		};
		return (result.targetInfos ?? []).filter((t) => t.type === "page");
	}

	private async refreshTabs(): Promise<void> {
		try {
			const pages = await this.pageTargets();
			this.tabs = pages.map((p) => ({
				targetId: p.targetId,
				title: p.title || p.url || "new tab",
				active: p.targetId === this.targetId,
			}));
			const active = pages.find((p) => p.targetId === this.targetId);
			if (active) this.url = active.url;
			this.paint();
		} catch (err) {
			log(`refreshTabs failed: ${String(err)}`);
		}
	}

	private async onTargetGone(): Promise<void> {
		const pages = await this.pageTargets().catch(() => []);
		if (pages.length === 0) {
			// Closing the last tab must not kill the view: open a blank one instead,
			// the same way a desktop browser keeps its window.
			log("last tab closed; opening about:blank");
			try {
				const created = (await this.cdp.send("Target.createTarget", { url: "about:blank" })) as {
					targetId?: string;
				};
				if (created.targetId) {
					await this.attachToActiveTab(created.targetId);
					this.urlEditing = "";
					await this.refreshTabs();
					return;
				}
			} catch (err) {
				log(`could not reopen a blank tab: ${String(err)}`);
			}
			await this.shutdown(0);
			return;
		}
		if (!pages.some((p) => p.targetId === this.targetId)) {
			await this.attachToActiveTab();
		}
		await this.refreshTabs();
	}

	private async attachToActiveTab(targetId?: string): Promise<void> {
		let pages = await this.pageTargets();
		if (pages.length === 0) {
			const created = (await this.cdp.send("Target.createTarget", {
				url: process.env.PI_HERDR_VIEW_URL || "about:blank",
			})) as { targetId?: string };
			if (!created.targetId) throw new Error("Target.createTarget returned no targetId");
			pages = await this.pageTargets();
			targetId = created.targetId;
		}
		const chosen = targetId ?? this.targetId ?? pages[0]!.targetId;

		if (this.sessionId) {
			const previous = this.sessionId;
			await this.cdp.send("Page.stopScreencast", {}, previous).catch(() => {});
			await this.cdp.send("Target.detachFromTarget", { sessionId: previous }).catch(() => {});
			this.cdp.offSession(previous);
			this.sessionId = undefined;
		}

		const attached = (await this.cdp.send("Target.attachToTarget", {
			targetId: chosen,
			flatten: true,
		})) as { sessionId?: string };
		if (!attached.sessionId) throw new Error("Target.attachToTarget returned no sessionId");

		this.sessionId = attached.sessionId;
		this.targetId = chosen;

		// CDP target activation keeps the Herdr tab strip and the page in sync.
		await this.cdp.send("Target.activateTarget", { targetId: chosen }).catch(() => {});

		const sid = this.sessionId;
		await this.cdp.send("Page.enable", {}, sid);
		await this.cdp.send("Runtime.enable", {}, sid).catch(() => {});
		await this.applyViewport();

		this.cdp.on("Page.screencastFrame", (params) => {
			this.frameQueue = this.frameQueue
				.then(() => this.onFrame(params))
				.catch((err) => log(`frame failed: ${String(err)}`));
		}, sid);
		this.cdp.on("Page.frameStartedLoading", () => {
			this.loading = true;
			this.paint();
		}, sid);
		this.cdp.on("Page.frameStoppedLoading", () => {
			this.loading = false;
			void this.refreshTabs();
		}, sid);
		this.cdp.on("Page.navigatedWithinDocument", (p) => {
			this.url = String(p.url ?? this.url);
			this.paint();
		}, sid);

		await this.startScreencast();
		await this.refreshTabs();
	}

	private async applyViewport(): Promise<void> {
		if (!this.sessionId) return;
		await this.cdp.send(
			"Emulation.setDeviceMetricsOverride",
			deviceMetricsForLayout(this.layout, this.zoom),
			this.sessionId,
		);
	}

	private async dispatchKey(e: KeyEvent): Promise<void> {
		if (!this.sessionId) return;
		const payload = keyToCdp(e);
		await this.cdp
			.send("Input.dispatchKeyEvent", payload, this.sessionId)
			.catch((err) => log(`key failed: ${String(err)}`));
		await this.cdp
			.send("Input.dispatchKeyEvent", { ...payload, type: "keyUp", text: undefined }, this.sessionId)
			.catch(() => {});
	}

	private async setBrowserZoom(target: number): Promise<void> {
		this.zoom = Math.round(Math.min(2.5, Math.max(0.5, target)) * 100) / 100;
		await this.applyViewport();
		this.paint();
	}

	private async startScreencast(): Promise<void> {
		if (!this.sessionId) return;
		await this.cdp.send(
			"Page.startScreencast",
			{
				format: "png",
				quality: 90,
				maxWidth: this.layout.imageWidth,
				maxHeight: this.layout.imageHeight,
				everyNthFrame: this.everyNthFrame,
			},
			this.sessionId,
		);
	}

	// ---------- frames ----------

	private minFrameGapMs(): number {
		const active = Date.now() - this.lastActivity < ACTIVE_WINDOW_MS;
		return Math.floor(1000 / (active ? ACTIVE_FPS : PASSIVE_FPS));
	}

	/**
	 * Backpressure: ack is delayed until the frame is handed to Herdr, so
	 * Chromium stops encoding instead of us discarding frames we already paid for.
	 */
	private async onFrame(params: Record<string, unknown>): Promise<void> {
		const data = String(params.data ?? "");
		const sessionId = params.sessionId;
		const png = Buffer.from(data, "base64");

		const now = Date.now();
		const gap = now - this.lastFrameAt;
		const minGap = this.minFrameGapMs();
		if (gap < minGap) {
			await new Promise((r) => setTimeout(r, minGap - gap));
		}

		if (!this.stream || this.stream.isClosed) {
			log("graphics stream closed; stopping");
			await this.shutdown(0);
			return;
		}

		await this.stream.send(
			{
				format: "png",
				image_width: this.layout.imageWidth,
				image_height: this.layout.imageHeight,
				placement: {
					viewport_col: this.layout.viewportCol,
					viewport_row: this.layout.viewportRow,
					grid_cols: this.layout.gridCols,
					grid_rows: this.layout.gridRows,
				},
			},
			png,
		);
		this.lastFrameAt = Date.now();
		this.framesSent++;
		if (this.showDiagnostics) this.paintDiagnostics();

		if (this.sessionId && sessionId !== undefined) {
			await this.cdp
				.send("Page.screencastFrameAck", { sessionId: Number(sessionId) }, this.sessionId)
				.catch(() => {});
		}
	}

	// ---------- painting ----------

	private paint(): void {
		if (!this.showToolbar || this.shuttingDown) return;
		const { lines, regions } = renderToolbar(
			{
				tabs: this.tabs,
				url: this.url,
				zoom: this.zoom,
				loading: this.loading,
				urlEditing: this.urlEditing,
			},
			this.pane.cols,
		);
		this.toolbarRegions = regions;
		let out = "";
		lines.forEach((line, i) => {
			out += `\x1b[${i + 1};1H\x1b[2K${line}`;
		});
		process.stdout.write(out);
		if (this.showDiagnostics) this.paintDiagnostics();
	}

	private paintDiagnostics(): void {
		const row = this.pane.rows;
		const text =
			`frames ${this.framesSent} · ${this.layout.imageWidth}x${this.layout.imageHeight} · ` +
			`grid ${this.layout.gridCols}x${this.layout.gridRows} · cell ${this.cell.cellWidthPx}x${this.cell.cellHeightPx}`;
		process.stdout.write(`\x1b[${row};1H\x1b[2K\x1b[2m${text.slice(0, this.pane.cols)}\x1b[0m`);
	}

	// ---------- input ----------

	private wireResize(): void {
		process.on("SIGWINCH", () => {
			void (async () => {
				try {
					this.pane = await paneGeometry(this.paneId);
					this.cell = await requireGraphicsSupport(this.paneId);
					this.recomputeLayout();
					await this.applyViewport();
					if (this.sessionId) {
						await this.cdp.send("Page.stopScreencast", {}, this.sessionId).catch(() => {});
						await this.startScreencast();
					}
					this.paint();
				} catch (err) {
					log(`resize failed: ${String(err)}`);
				}
			})();
		});
	}

	private wireStdin(): void {
		process.stdout.write(ENTER_ALT_SCREEN + ENABLE_MOUSE);
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.on("data", (chunk: Buffer) => {
			if (this.escapeTimer) clearTimeout(this.escapeTimer);
			this.stdinRest += chunk.toString("binary");
			const { events, rest } = parseAll(this.stdinRest);
			this.stdinRest = rest;
			for (const event of events) {
				this.inputQueue = this.inputQueue
					.then(() => this.handleEvent(event))
					.catch((err) => log(`input failed: ${String(err)}`));
			}
			if (rest === "\x1b") {
				this.escapeTimer = setTimeout(() => {
					const flushed = parseAll(this.stdinRest, true);
					this.stdinRest = flushed.rest;
					for (const event of flushed.events) {
						this.inputQueue = this.inputQueue
							.then(() => this.handleEvent(event))
							.catch((err) => log(`input failed: ${String(err)}`));
					}
				}, 25);
			}
		});
	}

	private async handleEvent(event: TermEvent): Promise<void> {
		this.lastActivity = Date.now();
		if (event.kind === "mouse") await this.handleMouse(event);
		else await this.handleKey(event);
	}

	private async handleMouse(e: MouseEvent): Promise<void> {
		// Toolbar first: those rows are never page area.
		if (this.showToolbar && e.row <= this.toolbarRows && e.action === "press") {
			const action = hitTest(this.toolbarRegions, e.row - 1, e.col - 1);
			log(
				`toolbar click row=${e.row} col=${e.col} paneCols=${this.pane.cols} ` +
					`stdout=${process.stdout.columns ?? "?"} -> ${action ? action.kind : "MISS"}`,
			);
			if (action) await this.runToolbarAction(action);
			return;
		}

		const point = cellToPagePixel(e.col, e.row, this.layout, this.cell, this.zoom);
		if (!point || !this.sessionId) return;
		const modifiers = cdpModifiers(e);
		const sid = this.sessionId;

		if (e.action === "wheel") {
			await this.cdp
				.send(
					"Input.dispatchMouseEvent",
					{
						type: "mouseWheel",
						x: point.x,
						y: point.y,
						deltaX: 0,
						deltaY: (e.wheelDelta ?? 1) * this.cell.cellHeightPx * 3,
						modifiers,
					},
					sid,
				)
				.catch((err) => log(`wheel failed: ${String(err)}`));
			return;
		}

		const type =
			e.action === "press" ? "mousePressed" : e.action === "release" ? "mouseReleased" : "mouseMoved";
		if (e.action === "press") this.mouseDown = true;
		if (e.action === "release") this.mouseDown = false;

		// Skip redundant moves: motion reports arrive per-cell and flood CDP.
		if (type === "mouseMoved") {
			if (point.x === this.lastMove.x && point.y === this.lastMove.y) return;
			this.lastMove = point;
		}

		await this.cdp
			.send(
				"Input.dispatchMouseEvent",
				{
					type,
					x: point.x,
					y: point.y,
					button: e.button === "none" ? "none" : e.button,
					buttons: this.mouseDown ? 1 : 0,
					clickCount: type === "mousePressed" ? 1 : 0,
					modifiers,
				},
				sid,
			)
			.catch((err) => log(`mouse failed: ${String(err)}`));
	}

	private async handleKey(e: KeyEvent): Promise<void> {
		// URL bar editing captures keys locally.
		if (this.urlEditing !== undefined) {
			if (e.key === "Enter") {
				const target = this.urlEditing.trim();
				this.urlEditing = undefined;
				if (target) await this.navigate(target);
				else this.paint();
				return;
			}
			if (e.key === "Escape") {
				this.urlEditing = undefined;
				this.paint();
				return;
			}
			if (e.key === "Backspace") {
				this.urlEditing = this.urlEditing.slice(0, -1);
				this.paint();
				return;
			}
			if (e.text && !e.ctrl && !e.alt) {
				this.urlEditing += e.text;
				this.paint();
			}
			return;
		}

		// Pane-level shortcuts.
		if (e.ctrl && e.key === "l") {
			this.urlEditing = this.url;
			this.paint();
			return;
		}
		if (e.ctrl && e.key === "q") {
			await this.shutdown(0);
			return;
		}
		if (e.ctrl && e.key === "r") {
			await this.runToolbarAction({ kind: "reload" });
			return;
		}
		if (e.ctrl && e.key === "t") {
			await this.runToolbarAction({ kind: "new-tab" });
			return;
		}
		if (e.ctrl && (e.key === "-" || e.key === "=" || e.key === "0")) {
			await this.setBrowserZoom(e.key === "0" ? 1 : this.zoom + (e.key === "=" ? ZOOM_STEP : -ZOOM_STEP));
			return;
		}

		await this.dispatchKey(e);
	}

	private async navigate(input: string): Promise<void> {
		const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
			? input
			: input.includes(" ") || !input.includes(".")
				? `https://duckduckgo.com/?q=${encodeURIComponent(input)}`
				: `https://${input}`;
		if (!this.sessionId) return;
		this.loading = true;
		this.paint();
		await this.cdp.send("Page.navigate", { url }, this.sessionId).catch((err) => {
			log(`navigate failed: ${String(err)}`);
			this.loading = false;
		});
	}

	private async runToolbarAction(action: ToolbarAction): Promise<void> {
		const sid = this.sessionId;
		try {
			switch (action.kind) {
				case "select-tab":
					await this.attachToActiveTab(action.targetId);
					return;
				case "close-tab":
					await this.cdp.send("Target.closeTarget", { targetId: action.targetId });
					return;
				case "new-tab": {
					log("new-tab requested");
					const created = (await this.cdp.send("Target.createTarget", { url: "about:blank" })) as {
						targetId?: string;
					};
					log(`new-tab created ${created.targetId ?? "(none)"}`);
					if (created.targetId) await this.attachToActiveTab(created.targetId);
					this.urlEditing = "";
					this.paint();
					return;
				}
				case "back":
					if (sid) await this.historyGo(-1);
					return;
				case "forward":
					if (sid) await this.historyGo(1);
					return;
				case "reload":
					if (sid) await this.cdp.send("Page.reload", {}, sid);
					return;
				case "stop":
					if (sid) await this.cdp.send("Page.stopLoading", {}, sid);
					this.loading = false;
					this.paint();
					return;
				case "zoom-out":
				case "zoom-in":
					await this.setBrowserZoom(this.zoom + (action.kind === "zoom-in" ? ZOOM_STEP : -ZOOM_STEP));
					return;
				case "focus-url":
					this.urlEditing = this.url;
					this.paint();
					return;
			}
		} catch (err) {
			log(`toolbar ${action.kind} failed: ${String(err)}`);
		}
	}

	private async historyGo(delta: number): Promise<void> {
		if (!this.sessionId) return;
		const history = (await this.cdp.send("Page.getNavigationHistory", {}, this.sessionId)) as {
			currentIndex?: number;
			entries?: Array<{ id: number }>;
		};
		const idx = (history.currentIndex ?? 0) + delta;
		const entry = history.entries?.[idx];
		if (!entry) return;
		await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, this.sessionId);
	}

	async shutdown(code: number): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		try {
			if (this.sessionId) {
				await this.cdp.send("Page.stopScreencast", {}, this.sessionId).catch(() => {});
			}
			this.stream?.close();
			await herdrRequest("pane.graphics.clear", { pane_id: this.paneId }).catch(() => {});
			this.cdp.close();
		} finally {
			process.stdout.write(DISABLE_MOUSE + LEAVE_ALT_SCREEN);
			process.stdin.setRawMode?.(false);
			process.exit(code);
		}
	}
}

export async function runView(): Promise<void> {
	const paneId = process.env.HERDR_PANE_ID;
	const cdpHttp = process.env.PI_HERDR_VIEW_CDP;
	if (!paneId) throw new Error("HERDR_PANE_ID is not set — run this inside a Herdr pane");
	if (!cdpHttp) throw new Error("PI_HERDR_VIEW_CDP is not set");

	const view = new BrowserView(
		paneId,
		cdpHttp,
		process.env.PI_HERDR_VIEW_TOOLBAR !== "0",
		process.env.PI_HERDR_VIEW_DIAG === "1",
		envNum("PI_HERDR_VIEW_SCALE", 1),
		envNum("PI_HERDR_VIEW_NTH", 1),
	);

	const bye = () => void view.shutdown(0);
	process.on("SIGINT", bye);
	process.on("SIGTERM", bye);
	process.on("SIGHUP", bye);

	await view.start();
	// Stay alive; everything is event driven from here.
	await new Promise(() => {});
}

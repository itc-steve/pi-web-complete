/**
 * Herdr socket API client — newline-delimited JSON over a Unix socket.
 *
 * Used for pane.graphics.* (frame streaming) and pane lookups. Only the few
 * methods the browser view needs; everything else goes through the herdr CLI.
 */

import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export function herdrSocketPath(): string {
	const explicit = process.env.HERDR_SOCKET_PATH?.trim();
	if (explicit) return explicit;
	const session = process.env.HERDR_SESSION?.trim();
	const base = join(homedir(), ".config", "herdr");
	return session ? join(base, "sessions", session, "herdr.sock") : join(base, "herdr.sock");
}

export function isHerdrPane(): boolean {
	return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID);
}

interface HerdrEnvelope {
	id?: string;
	result?: Record<string, unknown> & { type?: string };
	error?: { code?: string; message?: string };
}

function fail(envelope: HerdrEnvelope, method: string): never {
	const code = envelope.error?.code ?? "unknown";
	const message = envelope.error?.message ?? `herdr ${method} failed`;
	const err = new Error(`${message} (${code})`);
	(err as Error & { code?: string }).code = code;
	throw err;
}

/** One request, one response line, socket closed. */
export function herdrRequest(
	method: string,
	params: Record<string, unknown>,
	timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const sock = connect(herdrSocketPath());
		let buf = "";
		let settled = false;

		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.destroy();
			fn();
		};

		const timer = setTimeout(
			() => done(() => reject(new Error(`herdr ${method} timed out after ${timeoutMs}ms`))),
			timeoutMs,
		);

		sock.on("connect", () => {
			sock.write(`${JSON.stringify({ id: `pi-${method}`, method, params })}\n`);
		});
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf-8");
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			let envelope: HerdrEnvelope;
			try {
				envelope = JSON.parse(buf.slice(0, nl)) as HerdrEnvelope;
			} catch {
				done(() => reject(new Error(`herdr ${method} returned invalid JSON`)));
				return;
			}
			done(() => {
				if (envelope.error) {
					try {
						fail(envelope, method);
					} catch (err) {
						reject(err);
					}
					return;
				}
				resolve(envelope.result ?? {});
			});
		});
		sock.on("error", (err) => done(() => reject(err)));
		sock.on("close", () =>
			done(() => reject(new Error(`herdr ${method}: socket closed before a reply`))),
		);
	});
}

export interface CellSize {
	cellWidthPx: number;
	cellHeightPx: number;
}

/**
 * Attached-client cell geometry. Fails with `cell_size_unavailable` when the
 * client connected without graphics support (see requireGraphicsSupport).
 */
export async function paneGraphicsInfo(paneId: string): Promise<CellSize> {
	const result = await herdrRequest("pane.graphics.info", { pane_id: paneId });
	const cellWidthPx = Number(result.cell_width_px ?? 0);
	const cellHeightPx = Number(result.cell_height_px ?? 0);
	return { cellWidthPx, cellHeightPx };
}

const GRAPHICS_HELP = [
	"Herdr cannot place pane graphics right now.",
	"",
	"1. Enable the experimental feature in ~/.config/herdr/config.toml:",
	"",
	"     [experimental]",
	"     kitty_graphics = true",
	"",
	"2. Apply it:  herdr server reload-config",
	"3. Fully restart the Herdr *client* (detach and re-attach, or quit and run `herdr`).",
	"   A client that attached before the flag was on reports a 0px cell size and",
	"   frames are dropped silently.",
	"4. Use a Kitty-graphics terminal (Ghostty, kitty, WezTerm).",
].join("\n");

/**
 * Verify frames can actually be placed before launching a browser.
 * Herdr accepts a graphics stream even when cell size is 0 and renders nothing,
 * so a zero cell size is treated as unsupported rather than trusted.
 */
export async function requireGraphicsSupport(paneId: string): Promise<CellSize> {
	let cell: CellSize;
	try {
		cell = await paneGraphicsInfo(paneId);
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === "feature_disabled" || code === "cell_size_unavailable") {
			throw new Error(`${GRAPHICS_HELP}\n\nHerdr said: ${(err as Error).message}`);
		}
		throw err;
	}
	if (cell.cellWidthPx <= 0 || cell.cellHeightPx <= 0) {
		throw new Error(`${GRAPHICS_HELP}\n\nHerdr reported a 0px cell size.`);
	}
	return cell;
}

export interface GraphicsFrameHeader {
	format: "png" | "rgb" | "rgba";
	image_width: number;
	image_height: number;
	data_length: number;
	placement: {
		viewport_col: number;
		viewport_row: number;
		grid_cols: number;
		grid_rows: number;
	};
}

/**
 * Long-lived graphics stream: one JSON header line then exactly data_length
 * raw bytes per frame. Owns the pane's graphics layer until closed.
 */
export class GraphicsStream {
	private sock: Socket | undefined;
	private closed = false;

	constructor(private readonly paneId: string) {}

	async open(timeoutMs = 5_000): Promise<void> {
		const sock = connect(herdrSocketPath());
		this.sock = sock;
		await new Promise<void>((resolve, reject) => {
			let buf = "";
			let settled = false;
			const done = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn();
			};
			const timer = setTimeout(
				() => done(() => {
					sock.destroy();
					reject(new Error("pane.graphics.stream timed out"));
				}),
				timeoutMs,
			);
			sock.on("connect", () => {
				sock.write(
					`${JSON.stringify({
						id: "pi-graphics-stream",
						method: "pane.graphics.stream",
						params: { pane_id: this.paneId },
					})}\n`,
				);
			});
			sock.on("data", (chunk) => {
				buf += chunk.toString("utf-8");
				const nl = buf.indexOf("\n");
				if (nl < 0) return;
				let envelope: HerdrEnvelope;
				try {
					envelope = JSON.parse(buf.slice(0, nl)) as HerdrEnvelope;
				} catch {
					done(() => {
						sock.destroy();
						reject(new Error("pane.graphics.stream returned invalid JSON"));
					});
					return;
				}
				done(() => {
					if (envelope.error) {
						const code = envelope.error.code ?? "unknown";
						sock.destroy();
						reject(new Error(`${envelope.error.message ?? "stream refused"} (${code})`));
						return;
					}
					resolve();
				});
			});
			sock.on("error", (err) => done(() => reject(err)));
			sock.on("close", () => {
				this.closed = true;
				done(() => reject(new Error("pane.graphics.stream closed before ack")));
			});
		});
		sock.on("error", () => {
			this.closed = true;
		});
		sock.on("close", () => {
			this.closed = true;
		});
	}

	get isClosed(): boolean {
		return this.closed || !this.sock || this.sock.destroyed;
	}

	/** Write one frame and wait when the socket applies backpressure. */
	async send(header: Omit<GraphicsFrameHeader, "data_length">, data: Buffer): Promise<void> {
		const sock = this.sock;
		if (this.isClosed || !sock) throw new Error("graphics stream is closed");
		const full: GraphicsFrameHeader = { ...header, data_length: data.length };
		const headerWritable = sock.write(`${JSON.stringify(full)}\n`);
		const dataWritable = sock.write(data);
		if (headerWritable && dataWritable) return;
		await new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout>;
			const cleanup = () => {
				clearTimeout(timer);
				sock.off("drain", onDrain);
				sock.off("close", onClose);
			};
			const onDrain = () => {
				cleanup();
				resolve();
			};
			const onClose = () => {
				cleanup();
				reject(new Error("graphics stream closed before drain"));
			};
			timer = setTimeout(() => {
				cleanup();
				reject(new Error("graphics stream drain timed out"));
			}, 5_000);
			sock.once("drain", onDrain);
			sock.once("close", onClose);
		});
	}

	close(): void {
		this.closed = true;
		this.sock?.destroy();
		this.sock = undefined;
	}
}

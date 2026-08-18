/**
 * Terminal input → CDP Input events.
 *
 * Parses SGR mouse reports (CSI < b ; col ; row M/m) and key escape sequences
 * from a raw-mode stdin stream. Pure functions so the mapping is testable
 * without a terminal or a browser.
 */

export interface MouseEvent {
	kind: "mouse";
	/** press | release | move | wheel */
	action: "press" | "release" | "move" | "wheel";
	button: "left" | "middle" | "right" | "none";
	/** 1-based terminal cell coordinates as reported by the terminal. */
	col: number;
	row: number;
	wheelDelta?: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

export interface KeyEvent {
	kind: "key";
	/** CDP key identifier, e.g. "Enter", "ArrowLeft", "a". */
	key: string;
	/** Printable text to insert, when applicable. */
	text?: string;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

export type TermEvent = MouseEvent | KeyEvent;

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

/** Enable SGR mouse reporting (press, drag, motion) + focus tracking. */
export const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
export const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
export const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[?25l";
export const LEAVE_ALT_SCREEN = "\x1b[?25h\x1b[?1049l";

interface KeyMapEntry {
	key: string;
	text?: string;
}

/** CSI/SS3 final-byte sequences → CDP keys. */
const CSI_KEYS: Record<string, KeyMapEntry> = {
	A: { key: "ArrowUp" },
	B: { key: "ArrowDown" },
	C: { key: "ArrowRight" },
	D: { key: "ArrowLeft" },
	H: { key: "Home" },
	F: { key: "End" },
	P: { key: "F1" },
	Q: { key: "F2" },
	R: { key: "F3" },
	S: { key: "F4" },
};

/** CSI <n> ~ sequences. */
const TILDE_KEYS: Record<string, KeyMapEntry> = {
	"1": { key: "Home" },
	"2": { key: "Insert" },
	"3": { key: "Delete" },
	"4": { key: "End" },
	"5": { key: "PageUp" },
	"6": { key: "PageDown" },
	"15": { key: "F5" },
	"17": { key: "F6" },
	"18": { key: "F7" },
	"19": { key: "F8" },
	"20": { key: "F9" },
	"21": { key: "F10" },
	"23": { key: "F11" },
	"24": { key: "F12" },
};

function mouseButton(code: number): MouseEvent["button"] {
	switch (code & 0b11) {
		case 0:
			return "left";
		case 1:
			return "middle";
		case 2:
			return "right";
		default:
			return "none";
	}
}

/**
 * Parse one event off the front of buf.
 * Returns the event (or null for a consumed-but-ignored sequence) plus how many
 * bytes were consumed. consumed === 0 means "incomplete, wait for more input".
 */
export function parseOne(buf: string): { event: TermEvent | null; consumed: number } {
	if (buf.length === 0) return { event: null, consumed: 0 };

	// --- SGR mouse ---
	const mouse = SGR_MOUSE.exec(buf);
	if (mouse) {
		const code = Number(mouse[1]);
		const col = Number(mouse[2]);
		const row = Number(mouse[3]);
		const isRelease = mouse[4] === "m";
		const consumed = mouse[0].length;

		const shift = (code & 4) !== 0;
		const alt = (code & 8) !== 0;
		const ctrl = (code & 16) !== 0;
		const isMotion = (code & 32) !== 0;
		const isWheel = (code & 64) !== 0;

		if (isWheel) {
			// 64 = up, 65 = down, 66/67 = horizontal (ignored).
			const low = code & 0b11;
			if (low > 1) return { event: null, consumed };
			return {
				event: {
					kind: "mouse",
					action: "wheel",
					button: "none",
					col,
					row,
					wheelDelta: low === 0 ? -1 : 1,
					shift,
					alt,
					ctrl,
				},
				consumed,
			};
		}

		const button = mouseButton(code);
		const action: MouseEvent["action"] = isRelease
			? "release"
			: isMotion
				? "move"
				: "press";
		return {
			event: { kind: "mouse", action, button, col, row, shift, alt, ctrl },
			consumed,
		};
	}

	// --- escape sequences ---
	if (buf.startsWith("\x1b")) {
		if (buf.length === 1) return { event: null, consumed: 0 }; // maybe more coming
		const second = buf[1];

		if (second === "[" || second === "O") {
			// Incomplete CSI/SS3 — wait unless it's already terminated.
			const body = buf.slice(2);
			const finalIdx = body.search(/[A-Za-z~]/);
			if (finalIdx < 0) {
				// Cap unbounded growth from a broken stream.
				return buf.length > 32 ? { event: null, consumed: buf.length } : { event: null, consumed: 0 };
			}
			const params = body.slice(0, finalIdx);
			const final = body[finalIdx];
			const consumed = 2 + finalIdx + 1;

			// Modifier is the 2nd param: CSI 1;5C = ctrl+Right.
			const parts = params.split(";");
			const mod = Number(parts[1] ?? "1");
			const modBits = Number.isFinite(mod) && mod > 1 ? mod - 1 : 0;
			const shift = (modBits & 1) !== 0;
			const alt = (modBits & 2) !== 0;
			const ctrl = (modBits & 4) !== 0;

			if (final === "~") {
				const entry = TILDE_KEYS[parts[0] ?? ""];
				if (!entry) return { event: null, consumed };
				return { event: { kind: "key", ...entry, shift, alt, ctrl }, consumed };
			}
			const entry = CSI_KEYS[final ?? ""];
			if (!entry) return { event: null, consumed };
			return { event: { kind: "key", ...entry, shift, alt, ctrl }, consumed };
		}

		// Alt + printable
		if (second >= " " && second <= "~") {
			return {
				event: { kind: "key", key: second, text: second, shift: false, alt: true, ctrl: false },
				consumed: 2,
			};
		}
		// Bare ESC
		return {
			event: { kind: "key", key: "Escape", shift: false, alt: false, ctrl: false },
			consumed: 1,
		};
	}

	// --- control + printable ---
	const ch = buf[0]!;
	const code = ch.charCodeAt(0);

	if (ch === "\r" || ch === "\n") {
		return {
			event: { kind: "key", key: "Enter", text: "\r", shift: false, alt: false, ctrl: false },
			consumed: 1,
		};
	}
	if (ch === "\t") {
		return {
			event: { kind: "key", key: "Tab", text: "\t", shift: false, alt: false, ctrl: false },
			consumed: 1,
		};
	}
	if (code === 127 || code === 8) {
		return {
			event: { kind: "key", key: "Backspace", shift: false, alt: false, ctrl: false },
			consumed: 1,
		};
	}
	if (code < 32) {
		// Ctrl+letter: 1 => a.
		const letter = String.fromCharCode(code + 96);
		return {
			event: { kind: "key", key: letter, shift: false, alt: false, ctrl: true },
			consumed: 1,
		};
	}

	return {
		event: {
			kind: "key",
			key: ch,
			text: ch,
			shift: /[A-Z]/.test(ch),
			alt: false,
			ctrl: false,
		},
		consumed: 1,
	};
}

/** Drain every complete event from a buffer; returns the unconsumed remainder. */
export function parseAll(buf: string, flushEscape = false): { events: TermEvent[]; rest: string } {
	const events: TermEvent[] = [];
	let rest = buf;
	if (flushEscape && rest === "\x1b") {
		return {
			events: [{ kind: "key", key: "Escape", shift: false, alt: false, ctrl: false }],
			rest: "",
		};
	}
	// eslint-disable-next-line no-constant-condition
	while (rest.length > 0) {
		const { event, consumed } = parseOne(rest);
		if (consumed === 0) break;
		rest = rest.slice(consumed);
		if (event) events.push(event);
	}
	return { events, rest };
}

/** CDP modifier bitmask: alt=1, ctrl=2, meta=4, shift=8. */
export function cdpModifiers(e: { shift: boolean; alt: boolean; ctrl: boolean }): number {
	return (e.alt ? 1 : 0) | (e.ctrl ? 2 : 0) | (e.shift ? 8 : 0);
}

/** Keys that must not be sent as text even though they are printable-ish. */
const NON_TEXT_KEYS = new Set(["Enter", "Tab", "Backspace", "Escape", "Delete"]);

const CHROMIUM_SHORTCUT_KEYS: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
	"-": { code: "Minus", windowsVirtualKeyCode: 189 },
	"=": { code: "Equal", windowsVirtualKeyCode: 187 },
	"0": { code: "Digit0", windowsVirtualKeyCode: 48 },
};

export function keyToCdp(e: KeyEvent): Record<string, unknown> {
	const modifiers = cdpModifiers(e);
	const isPrintable = Boolean(e.text) && !NON_TEXT_KEYS.has(e.key) && !e.ctrl && !e.alt;
	const shortcut = e.ctrl ? CHROMIUM_SHORTCUT_KEYS[e.key] : undefined;
	return {
		type: isPrintable ? "keyDown" : "rawKeyDown",
		key: e.key,
		modifiers,
		...(isPrintable ? { text: e.text } : {}),
		...(shortcut ? { ...shortcut, nativeVirtualKeyCode: shortcut.windowsVirtualKeyCode } : {}),
		...(e.key === "Enter" ? { text: "\r", windowsVirtualKeyCode: 13 } : {}),
		...(e.key === "Tab" ? { windowsVirtualKeyCode: 9 } : {}),
		...(e.key === "Backspace" ? { windowsVirtualKeyCode: 8 } : {}),
	};
}

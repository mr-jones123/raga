import { isAppleTerminalSession } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * The Mahoraga wheel, 16 cells wide and 8 lines tall. Braille dots carry the 8 handles,
 * the rim, the hub, and the spokes; the glyphs follow the theme's accent color.
 */
const WHEEL = [
	"       ⣴⣦",
	"  ⢠⣶⠄⣠⣤⣬⣧⣤⣄⠠⣶⡄",
	"   ⣡⣿⢟⠋⠉⡏⠙⡻⣿⣌",
	"⢀⣤⡀⣿⡏ ⠑⣤⣧⠊ ⢹⣿⢀⣤⡀",
	"⠈⠛⠉⣿⣏⠉⡩⠛⡟⢍⠉⣹⣿⠉⠛⠁",
	"   ⡙⣿⣮⣄⣀⣇⣠⣵⣿⢋",
	"  ⠘⠿⠂⠙⠛⢛⡟⠛⠋⠐⠿⠃",
	"       ⠻⠟",
] as const;

/** Braille bit for each dot of a 2x4 cell, indexed [row][column]. */
const BRAILLE_BITS = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
] as const;
const DOTS_WIDE = 32;
const DOTS_HIGH = WHEEL.length * 4;
/** Sub-samples per dot axis when rotating; fewer leave gaps in the rim mid-turn. */
const SAMPLES = 4;

const WHEEL_DOTS = (() => {
	const dots = new Uint8Array(DOTS_WIDE * DOTS_HIGH);
	WHEEL.forEach((line, row) => {
		Array.from(line).forEach((char, column) => {
			const code = char.codePointAt(0)! - 0x2800;
			if (code <= 0 || code > 0xff) return;
			BRAILLE_BITS.forEach((bits, dy) => {
				bits.forEach((bit, dx) => {
					if (code & bit) dots[(row * 4 + dy) * DOTS_WIDE + column * 2 + dx] = 1;
				});
			});
		});
	});
	return dots;
})();

function isDotSet(sourceX: number, sourceY: number): boolean {
	const x = Math.round(sourceX);
	const y = Math.round(sourceY);
	return x >= 0 && x < DOTS_WIDE && y >= 0 && y < DOTS_HIGH && WHEEL_DOTS[y * DOTS_WIDE + x] === 1;
}

/**
 * The wheel turned clockwise by `angle` radians. A dot is set when at least half of its sub-samples land on a
 * dot of the unrotated wheel, so angle 0 reproduces the drawing exactly.
 */
export function ragaLogoLines(angle = 0): string[] {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const centerX = (DOTS_WIDE - 1) / 2;
	const centerY = (DOTS_HIGH - 1) / 2;
	const lines: string[] = [];
	for (let row = 0; row < WHEEL.length; row++) {
		let line = "";
		for (let column = 0; column < DOTS_WIDE / 2; column++) {
			let code = 0;
			BRAILLE_BITS.forEach((bits, dy) => {
				bits.forEach((bit, dx) => {
					let hits = 0;
					for (let sy = 0; sy < SAMPLES; sy++) {
						for (let sx = 0; sx < SAMPLES; sx++) {
							const x = column * 2 + dx + (sx + 0.5) / SAMPLES - 0.5 - centerX;
							const y = row * 4 + dy + (sy + 0.5) / SAMPLES - 0.5 - centerY;
							if (isDotSet(cos * x + sin * y + centerX, -sin * x + cos * y + centerY)) hits++;
						}
					}
					if (hits * 2 >= SAMPLES * SAMPLES) code |= bit;
				});
			});
			line += code === 0 ? " " : String.fromCodePoint(0x2800 + code);
		}
		lines.push(theme.fg("accent", line));
	}
	return lines;
}

/**
 * Apple Terminal misaligns braille and half blocks, so it gets the text wordmark.
 */
export function supportsRagaLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback for the wheel. */
export function ragaWordmark(): string {
	return theme.fg("accent", "raga");
}

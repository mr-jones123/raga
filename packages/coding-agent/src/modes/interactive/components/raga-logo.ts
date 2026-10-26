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

export function ragaLogoLines(): string[] {
	return WHEEL.map((line) => theme.fg("accent", line));
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

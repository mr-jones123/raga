/** The 3-row braille wheel drawn beside a running RLM cell, in the transcript and in the cell panel. */
import { rgbColor } from "@earendil-works/pi-tui";

/** Eight frames of a 7x3 braille wheel; the gap rotates to read as spin. */
const FRAMES = [
	[" ⢴⣴⡶⣦⡦ ", "⠰⣿⣭⡷⣭⣿⠆", " ⠺⠻⣷⠟⠗ "],
	[" ⢴⣴⡿⣦⡄ ", "⠰⣿⣭⡷⣭⣿⠆", " ⠺⠻⣷⠟⠗ "],
	[" ⢴⣴⡿⣦⡦ ", "⠰⣿⣭⡷⣭⣿ ", " ⠺⠻⣷⠟⠗ "],
	[" ⢴⣴⡿⣦⡦ ", "⠰⣿⣭⡷⣭⣿⠆", " ⠺⠻⣷⠟⠃ "],
	[" ⢴⣴⡿⣦⡦ ", "⠰⣿⣭⡷⣭⣿⠆", " ⠺⠻⠷⠟⠗ "],
	[" ⢴⣴⡿⣦⡦ ", "⠰⣿⣭⡷⣭⣿⠆", " ⠘⠻⣷⠟⠗ "],
	[" ⢴⣴⡿⣦⡦ ", " ⣿⣭⡷⣭⣿⠆", " ⠺⠻⣷⠟⠗ "],
	[" ⢠⣴⡿⣦⡦ ", "⠰⣿⣭⡷⣭⣿⠆", " ⠺⠻⣷⠟⠗ "],
] as const;

export const WHEEL_PALETTE = [
	rgbColor(228, 138, 122),
	rgbColor(79, 142, 179),
	rgbColor(234, 182, 93),
	rgbColor(126, 190, 122),
	rgbColor(200, 120, 200),
	rgbColor(90, 190, 190),
];

export const WHEEL_FRAME_MS = 80;

/** The wheel's three rows at `now`; `offset` shifts the phase so concurrent wheels do not spin in step. Undefined `now` gives the resting frame. */
export function wheelFrame(startedAt: number, now: number | undefined, offset = 0): readonly [string, string, string] {
	if (now === undefined) return FRAMES[0];
	return FRAMES[Math.floor(Math.max(0, now - startedAt) / WHEEL_FRAME_MS + offset) % FRAMES.length];
}

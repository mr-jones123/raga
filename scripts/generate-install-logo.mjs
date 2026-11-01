#!/usr/bin/env node
/**
 * Writes the installer's logo animation frames into install.sh.
 *
 * The frames come from the wheel in packages/coding-agent/src/modes/interactive/components/raga-logo.ts, so
 * the installer shows the same wheel as the TUI. install.sh is plain POSIX sh and may run before Node.js is
 * installed, so it cannot compute frames itself; this script precomputes them.
 *
 * Usage: node scripts/generate-install-logo.mjs [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logoPath = join(root, "packages/coding-agent/src/modes/interactive/components/raga-logo.ts");
const installPath = join(root, "install.sh");
const BEGIN = "# BEGIN GENERATED LOGO FRAMES (node scripts/generate-install-logo.mjs)";
const END = "# END GENERATED LOGO FRAMES";

const logoSource = readFileSync(logoPath, "utf8");
const wheelMatch = /const WHEEL = \[([\s\S]*?)\] as const;/.exec(logoSource);
if (!wheelMatch) throw new Error(`WHEEL not found in ${logoPath}`);
const WHEEL = [...wheelMatch[1].matchAll(/"([^"]*)"/g)].map((match) => match[1]);

const BRAILLE_BITS = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];
const COLUMNS = 16;
const DOTS_WIDE = COLUMNS * 2;
const DOTS_HIGH = WHEEL.length * 4;
const CENTER_X = (DOTS_WIDE - 1) / 2;
const CENTER_Y = (DOTS_HIGH - 1) / 2;
const SAMPLES = 4;

/** Wheel parts by distance from the center. The variable names are the shell color variables in install.sh. */
function partOf(x, y) {
	const radius = Math.hypot(x - CENTER_X, y - CENTER_Y);
	if (radius < 4) return "H"; // hub
	if (radius < 7.5) return "S"; // spokes
	if (radius < 11.5) return "R"; // rim
	return "K"; // the eight handles
}

/** Handle index 0-7, clockwise from the top. */
function handleOf(x, y) {
	const angle = Math.atan2(x - CENTER_X, -(y - CENTER_Y));
	return (Math.round(angle / (Math.PI / 4)) + 8) % 8;
}

/** Map of "x,y" to part for every dot of the unrotated wheel. */
const wheel = new Map();
WHEEL.forEach((line, row) => {
	Array.from(line).forEach((char, column) => {
		const code = char.codePointAt(0) - 0x2800;
		if (code <= 0 || code > 0xff) return;
		BRAILLE_BITS.forEach((bits, dy) => {
			bits.forEach((bit, dx) => {
				if (code & bit) {
					const x = column * 2 + dx;
					const y = row * 4 + dy;
					wheel.set(`${x},${y}`, partOf(x, y));
				}
			});
		});
	});
});

/** Render a dot field (`dotAt(x, y)` returns a part or undefined) as shell-quoted lines with color variables. */
function render(dotAt, colorOverride) {
	const lines = [];
	for (let row = 0; row < WHEEL.length; row++) {
		let line = "  ";
		let current;
		for (let column = 0; column < COLUMNS; column++) {
			let code = 0;
			const counts = new Map();
			BRAILLE_BITS.forEach((bits, dy) => {
				bits.forEach((bit, dx) => {
					const part = dotAt(column * 2 + dx, row * 4 + dy);
					if (!part) return;
					code |= bit;
					counts.set(part, (counts.get(part) ?? 0) + 1);
				});
			});
			if (code === 0) {
				line += " ";
				continue;
			}
			const part = colorOverride ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
			if (part !== current) {
				line += `\${${part}}`;
				current = part;
			}
			line += String.fromCodePoint(0x2800 + code);
		}
		lines.push(`${line.trimEnd()}\${Z}\${E}`);
	}
	return lines.join("\\n");
}

/**
 * The wheel with `fixed` parts in place (handles only up to `handles`), plus `falling` parts shifted down by
 * `fall` dots. A negative `fall` puts them above their final position.
 */
function partial(fixed, handles = 0, falling = new Set(), fall = 0) {
	return (x, y) => {
		const settled = wheel.get(`${x},${y}`);
		if (settled && fixed.has(settled) && (settled !== "K" || handleOf(x, y) < handles)) return settled;
		const dropping = wheel.get(`${x},${y - fall}`);
		return dropping && falling.has(dropping) ? dropping : undefined;
	};
}

/** The full wheel turned clockwise by `angle` radians; a dot takes the part most of its samples land on. */
function rotated(angle) {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return (x, y) => {
		const counts = new Map();
		let hits = 0;
		for (let sy = 0; sy < SAMPLES; sy++) {
			for (let sx = 0; sx < SAMPLES; sx++) {
				const px = x + (sx + 0.5) / SAMPLES - 0.5 - CENTER_X;
				const py = y + (sy + 0.5) / SAMPLES - 0.5 - CENTER_Y;
				const source = wheel.get(
					`${Math.round(cos * px + sin * py + CENTER_X)},${Math.round(-sin * px + cos * py + CENTER_Y)}`,
				);
				if (!source) continue;
				hits++;
				counts.set(source, (counts.get(source) ?? 0) + 1);
			}
		}
		if (hits * 2 < SAMPLES * SAMPLES) return undefined;
		return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
	};
}

function easeInOutCubic(t) {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

const frames = [];
const sequence = [];
function frame(body, delay) {
	let index = frames.indexOf(body);
	if (index === -1) {
		index = frames.length;
		frames.push(body);
	}
	sequence.push(`${index}:${delay}`);
}

const none = new Set();
const rimOnly = new Set(["R"]);
const rimAndCenter = new Set(["R", "S", "H"]);
const full = render((x, y) => wheel.get(`${x},${y}`));

// 1. The rim drops in from above, then the hub and spokes drop into it, like pieces falling into place.
for (const fall of [-16, -12, -8, -4, 0]) frame(render(partial(none, 0, rimOnly, fall)), 0.06);
for (const fall of [-16, -12, -8, -4, 0]) frame(render(partial(rimOnly, 0, new Set(["S", "H"]), fall)), 0.06);
// 2. The eight handles lock on one by one, clockwise from the top.
for (let handles = 1; handles <= 8; handles++) frame(render(partial(rimAndCenter, handles)), 0.05);
frame(full, 0.25);
// 3. A hit: the wheel flashes.
const white = render((x, y) => wheel.get(`${x},${y}`), "W");
frame(white, 0.08);
frame(full, 0.08);
frame(white, 0.08);
frame(full, 0.12);
// 4. It adapts: one handle's turn clockwise. The wheel has 8-fold symmetry, so the turn ends on the start frame.
const TURN_FRAMES = 10;
for (let step = 1; step < TURN_FRAMES; step++) {
	frame(render(rotated((Math.PI / 4) * easeInOutCubic(step / TURN_FRAMES))), 0.05);
}
frame(full, 0.45);

const block = [
	BEGIN,
	"# Wheel frames for raga_logo_animation. Each frame is 8 lines of braille with color variables",
	"# H (hub), S (spokes), R (rim), K (handles), W (flash), Z (reset), and E (clear to end of line).",
	"raga_logo_frame() {",
	'  case "$1" in',
	...frames.map((body, index) => `    ${index}) RAGA_LOGO_FRAME="${body}" ;;`),
	"  esac",
	"}",
	`RAGA_LOGO_FINAL_FRAME=${frames.indexOf(full)}`,
	`RAGA_LOGO_SEQUENCE="${sequence.join(" ")}"`,
	END,
].join("\n");

const install = readFileSync(installPath, "utf8");
const start = install.indexOf(BEGIN);
const end = install.indexOf(END);
if (start === -1 || end === -1) throw new Error(`Logo frame markers not found in ${installPath}`);
const next = `${install.slice(0, start)}${block}${install.slice(end + END.length)}`;
if (process.argv.includes("--check")) {
	if (next !== install) {
		console.error("install.sh logo frames are stale. Run: node scripts/generate-install-logo.mjs");
		process.exit(1);
	}
} else if (next !== install) {
	writeFileSync(installPath, next);
	console.log(`Wrote ${frames.length} logo frames to install.sh`);
}

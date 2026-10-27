import {
	type Component,
	type OverlayHandle,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { ragaLogoLines, ragaWordmark, supportsRagaLogo } from "./raga-logo.ts";

/** Each period the wheel rests, then turns one handle (1/8 of a circle) clockwise, like Mahoraga adapting. */
const PERIOD_MS = 2000;
const TURN_MS = 600;
const TURN_ANGLE = Math.PI / 4;
const FRAME_MS = 33;

function easeInOutCubic(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Wheel angle at `elapsed` ms. The wheel has 8-fold symmetry, so each turn ends where it started. */
function wheelAngle(elapsed: number): number {
	const turnStart = PERIOD_MS - TURN_MS;
	const phase = elapsed % PERIOD_MS;
	return phase < turnStart ? 0 : TURN_ANGLE * easeInOutCubic((phase - turnStart) / TURN_MS);
}

/** Delay until the frame after `elapsed`: a frame interval mid-turn, otherwise the start of the next turn. */
function nextFrameDelay(elapsed: number): number {
	const untilTurn = PERIOD_MS - TURN_MS - (elapsed % PERIOD_MS);
	return untilTurn > 0 ? untilTurn : FRAME_MS;
}

/** Fullscreen screensaver: the raga wheel turning in the center of an empty terminal. Any key or click exits. */
class IdleWheel implements Component {
	readonly startTime = performance.now();
	private readonly tui: TUI;
	private readonly onExit: () => void;

	constructor(tui: TUI, onExit: () => void) {
		this.tui = tui;
		this.onExit = onExit;
	}

	handleInput(): void {
		this.onExit();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
		if (event.type === "click") this.onExit();
		return { handled: true, render: false };
	}

	invalidate(): void {}

	render(width: number): string[] {
		const height = Math.max(1, this.tui.terminal.rows);
		const art = supportsRagaLogo() ? ragaLogoLines(wheelAngle(performance.now() - this.startTime)) : [ragaWordmark()];
		const left = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(art[0]!)) / 2)));
		const top = Math.max(0, Math.floor((height - art.length) / 2));
		const lines = Array.from({ length: height }, () => "");
		art.forEach((line, index) => {
			if (top + index < height) lines[top + index] = left + line;
		});
		return lines;
	}
}

/** Show the idle wheel over the whole terminal until a key press or click. */
export function showIdleWheel(tui: TUI): void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const exit = () => {
		clearTimeout(timer);
		overlay.hide();
	};
	const wheel = new IdleWheel(tui, exit);
	const overlay: OverlayHandle = tui.showOverlay(wheel, { anchor: "top-left", width: "100%", maxHeight: "100%" });
	const tick = () => {
		// Stop once something else removed the overlay, e.g. a fullscreen exit hiding all overlays.
		if (!overlay.getBounds()) return;
		tui.requestRender();
		timer = setTimeout(tick, nextFrameDelay(performance.now() - wheel.startTime));
		timer.unref?.();
	};
	timer = setTimeout(tick, nextFrameDelay(0));
	timer.unref?.();
}

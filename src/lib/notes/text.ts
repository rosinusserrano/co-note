// Text box geometry, shared by the canvas, the eraser, Fit and the PDF export
// so all of them put the same text in the same place.
//
// The canvas draws text in Arimo, which has Helvetica's metrics; the export
// uses the PDF standard font Helvetica (nothing to embed). Same widths, so a
// line ends where it ended on screen. Baselines are placed by the constants
// here, not by either font's own ascent.

import type { TextBox } from './model';

export const TEXT_FONT = "Arimo, Arial, Helvetica, 'Liberation Sans', sans-serif";
/** Line spacing, in font sizes. */
export const TEXT_LINE = 1.25;
/** First baseline below the box's top, in font sizes: where a textarea with
 *  this line height puts it in Arimo (ascent 0.905, descent 0.212, the rest
 *  of the line split above and below), so editing and drawn text line up. */
export const TEXT_ASCENT = (TEXT_LINE - (0.905 + 0.212)) / 2 + 0.905;
/** Size range (world units / pt) for the text tool's slider, and its default. */
export const TEXT_SIZE = { size: 16, min: 8, max: 72 };

export const textLines = (t: TextBox) => t.text.split('\n');

let measurer: CanvasRenderingContext2D | null = null;
// Text boxes are immutable, so their widths can be cached per object.
let widths = new WeakMap<TextBox, number>();

/** The box's widest line, in its own units (canvas metrics; ~Helvetica's). */
export function textWidth(t: TextBox): number {
	const hit = widths.get(t);
	if (hit !== undefined) return hit;
	measurer ??= typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
	let w = 0;
	if (measurer) {
		// Measured at a fixed size and scaled: tiny world sizes measure poorly.
		measurer.font = `100px ${TEXT_FONT}`;
		for (const line of textLines(t)) w = Math.max(w, measurer.measureText(line).width);
		w *= t.size / 100;
	} else {
		w = Math.max(...textLines(t).map((l) => l.length)) * t.size * 0.55;
	}
	widths.set(t, w);
	return w;
}

/** Forget measured widths (the font just finished loading). */
export function remeasureText() {
	widths = new WeakMap();
}

/** The box's extent in its own coordinates (page-local or world). */
export function textBounds(t: TextBox) {
	const lines = textLines(t).length;
	return { x: t.x, y: t.y, w: Math.max(textWidth(t), t.size * 0.3), h: t.size * TEXT_LINE * lines };
}

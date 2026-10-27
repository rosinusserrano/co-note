// Stroke geometry, shared by the canvas and the PDF export so both draw the
// same ink.
//
// Brush strokes (pen, brush, marker) are filled outlines from perfect-freehand:
// thickness follows pressure — or, from a mouse, speed (fast = thin) — with
// optional tapered ends. The outline is smoothed into quadratic curves through
// its midpoints.
//
// Strokes from before brushes existed (no `brush` field) keep their original
// look: a stroked centre line, smoothed through sample midpoints, cut into runs
// of equal (quantised) pressure width.
//
// Presets are part of the stored data's meaning: a stroke only records its
// brush name, so changing a preset restyles every existing stroke of that kind.
//
// Zoom: perfect-freehand's thresholds are in the units it's given — it skips
// the first stroke-width of a line, thins the outline at width × smoothing,
// and drops the last 3 units outright. Width is in world units, so zoomed in
// (thick on screen) those swallowed exactly the small details you zoom in to
// draw. So a stroke records the zoom it was drawn at (`Stroke.z`), and its
// shape is computed in the screen pixels the drawer saw, with the start skip
// and outline spacing capped in pixels and the trailing average (streamline)
// eased off as the zoom grows. `z` is stored, not the viewer's zoom, so every
// device and the export get the same shape.

import { getStrokeOutlinePoints, getStrokePoints } from 'perfect-freehand';
import type { Brush, Stroke, StrokePoint } from './model';

export type Seg = { q: false; x: number; y: number } | { q: true; cx: number; cy: number; x: number; y: number };

export interface InkRun {
	width: number;
	x: number;
	y: number;
	segs: Seg[];
}

export type InkShape =
	/** Legacy: stroked runs (and a dot for a single sample). */
	| { kind: 'runs'; dot?: { x: number; y: number; r: number }; runs: InkRun[] }
	/** Brush: one closed outline to fill. */
	| { kind: 'fill'; path: InkRun | null; marker: boolean };

export interface BrushPreset {
	label: string;
	/** Effect of pressure (or speed) on thickness, 0..1. */
	thinning: number;
	smoothing: number;
	streamline: number;
	/** Taper length at each end, in multiples of the stroke's size. */
	taper: number;
	/** Default size (world units) and the slider's range. */
	size: number;
	min: number;
	max: number;
	/** Drawn translucent and multiplied, under the other ink. */
	marker?: boolean;
}

export const BRUSHES: Record<Brush, BrushPreset> = {
	pen: { label: 'Pen', thinning: 0.6, smoothing: 0.5, streamline: 0.35, taper: 0, size: 3, min: 0.1, max: 16 },
	brush: { label: 'Brush', thinning: 0.85, smoothing: 0.6, streamline: 0.45, taper: 10, size: 6, min: 0.2, max: 30 },
	marker: { label: 'Marker', thinning: 0, smoothing: 0.6, streamline: 0.5, taper: 0, size: 18, min: 6, max: 60, marker: true }
};

/** How opaque marker ink is (all markers share it; see the canvas's marker layer). */
export const MARKER_ALPHA = 0.4;

/** Keep a floor so zero-pressure samples still leave a visible mark. */
export const pressureScale = (p: number) => 0.35 + 0.65 * p;

const LEVELS = 20;
const level = (p: StrokePoint) => Math.round(pressureScale(p.pressure) * LEVELS);

// Strokes are immutable once committed, and Yjs hands back the same objects
// on every read, so shapes can be cached per stroke object.
const cache = new WeakMap<Stroke, InkShape>();

export function inkShape(s: Stroke): InkShape {
	const hit = cache.get(s);
	if (hit) return hit;
	const shape = computeShape(s, true);
	cache.set(s, shape);
	return shape;
}

/** For the stroke still being drawn, which changes every sample: no cache,
 *  and its end isn't tapered yet. */
export const liveInkShape = (s: Stroke) => computeShape(s, false);

export const isMarker = (s: Stroke) => s.brush === 'marker';

function computeShape(s: Stroke, last: boolean): InkShape {
	return s.brush ? brushShape(s, BRUSHES[s.brush] ?? BRUSHES.pen, last) : legacyShape(s);
}

/** Screen px (at the drawing zoom): how long a line's start may go unbent,
 *  and the closest outline points may be — whatever the stroke's width. */
const START_PX = 4;
const OUTLINE_PX = 2;

/** Streamline factor at zoom z: full at 100% and below, eased off above
 *  (half at 400%, a quarter at 1600%). */
export const streamlineAt = (streamline: number, z: number) => streamline * Math.min(1, 1 / Math.sqrt(z));

/** A drawing zoom fit to store: within the viewport's range, two decimals. */
export const strokeZoom = (scale: number) => Math.round(Math.min(20, Math.max(0.1, scale)) * 100) / 100;

function brushShape(s: Stroke, b: BrushPreset, last: boolean): InkShape {
	// (Clamped: `z` comes from whoever drew the stroke.)
	const z = s.z && Number.isFinite(s.z) && s.z > 0 ? Math.min(50, Math.max(0.05, s.z)) : null;
	let outline: number[][];
	if (z === null) {
		// Drawn before strokes knew their zoom: exactly the old shape.
		const opts = { size: s.width, streamline: b.streamline, last };
		outline = getStrokeOutlinePoints(getStrokePoints(s.points.map((p) => [p.x, p.y, p.pressure]), opts), {
			...opts,
			thinning: b.thinning,
			smoothing: b.smoothing,
			simulatePressure: !!s.sim,
			start: { taper: b.taper * s.width, cap: true },
			end: { taper: b.taper * s.width, cap: true }
		});
	} else {
		// In the drawer's screen pixels, then back to world units.
		const size = s.width * z;
		const pts = getStrokePoints(
			s.points.map((p) => [p.x * z, p.y * z, p.pressure]),
			// `size` here only sets how long the start goes unbent.
			{ size: Math.min(size, START_PX), streamline: streamlineAt(b.streamline, z), last }
		);
		outline = getStrokeOutlinePoints(pts, {
			size,
			thinning: b.thinning,
			smoothing: Math.min(b.smoothing, OUTLINE_PX / size),
			simulatePressure: !!s.sim,
			start: { taper: b.taper * size, cap: true },
			end: { taper: b.taper * size, cap: true },
			last
		}).map(([x, y]) => [x / z, y / z]);
	}
	const marker = !!b.marker;
	const n = outline.length;
	if (n < 3) return { kind: 'fill', path: null, marker };
	// Closed and smooth: from the midpoint of the closing edge, bend through
	// each outline point to the next midpoint.
	const mid = (i: number) => {
		const a = outline[i % n];
		const c = outline[(i + 1) % n];
		return [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
	};
	const [sx, sy] = mid(n - 1);
	const segs: Seg[] = [];
	for (let i = 0; i < n; i++) {
		const [x, y] = mid(i);
		segs.push({ q: true, cx: outline[i][0], cy: outline[i][1], x, y });
	}
	return { kind: 'fill', path: { width: 0, x: sx, y: sy, segs }, marker };
}

function legacyShape(s: Stroke): InkShape {
	const pts = s.points;
	const n = pts.length;
	if (n === 0) return { kind: 'runs', runs: [] };
	if (n === 1) {
		const p = pts[0];
		return { kind: 'runs', dot: { x: p.x, y: p.y, r: (s.width * pressureScale(p.pressure)) / 2 }, runs: [] };
	}
	const runs: InkRun[] = [];
	let run: InkRun | null = null;
	let runLevel = -1;
	const piece = (lv: number, fromX: number, fromY: number, seg: Seg) => {
		if (lv !== runLevel || !run) {
			run = { width: (s.width * lv) / LEVELS, x: fromX, y: fromY, segs: [] };
			runs.push(run);
			runLevel = lv;
		}
		run.segs.push(seg);
	};
	const mid = (a: StrokePoint, b: StrokePoint) => [(a.x + b.x) / 2, (a.y + b.y) / 2];

	// p0 → first midpoint, straight.
	let [mx, my] = mid(pts[0], pts[1]);
	piece(level(pts[0]), pts[0].x, pts[0].y, { q: false, x: mx, y: my });
	// midpoint → midpoint, bending through each inner sample.
	for (let i = 1; i < n - 1; i++) {
		const [nx, ny] = mid(pts[i], pts[i + 1]);
		piece(level(pts[i]), mx, my, { q: true, cx: pts[i].x, cy: pts[i].y, x: nx, y: ny });
		mx = nx;
		my = ny;
	}
	// last midpoint → last sample, straight.
	piece(level(pts[n - 1]), mx, my, { q: false, x: pts[n - 1].x, y: pts[n - 1].y });
	return { kind: 'runs', runs };
}

/** "#rrggbb" → [r, g, b] in 0..1 (black for anything else). */
export function hexToRgb(hex: string): [number, number, number] {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!m) return [0, 0, 0];
	const v = parseInt(m[1], 16);
	return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

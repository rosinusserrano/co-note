// Shape geometry (see Shape in model.ts), shared by the canvas, the eraser,
// the lasso, Fit and the PDF export, so all of them agree on what a shape is.

import type { Shape, ShapeKind } from './model';

export const SHAPE_KINDS: { id: ShapeKind; label: string }[] = [
	{ id: 'rect', label: 'Rectangle' },
	{ id: 'ellipse', label: 'Ellipse' },
	{ id: 'line', label: 'Line' },
	{ id: 'arrow', label: 'Arrow' },
	{ id: 'cover', label: 'Cover' }
];

export const isShapeKind = (v: unknown): v is ShapeKind => SHAPE_KINDS.some((k) => k.id === v);

/** A box's corners in order (x0 ≤ x1, y0 ≤ y1). */
export function shapeBox(s: Pick<Shape, 'x0' | 'y0' | 'x1' | 'y1'>) {
	return { x0: Math.min(s.x0, s.x1), y0: Math.min(s.y0, s.y1), x1: Math.max(s.x0, s.x1), y1: Math.max(s.y0, s.y1) };
}

/** What a shape covers, its line width included (the arrow's head too). */
export function shapeBounds(s: Shape) {
	const b = shapeBox(s);
	const r = s.kind === 'cover' ? 0 : s.width / 2 + (s.kind === 'arrow' ? arrowSize(s) : 0);
	return { x0: b.x0 - r, y0: b.y0 - r, x1: b.x1 + r, y1: b.y1 + r };
}

/** Its middle: what the lasso goes by. */
export const shapeMiddle = (s: Shape) => ({ x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2 });

/** How long an arrow's head is: with the line's width, and never more than
 *  half the arrow. */
const arrowSize = (s: Shape) => Math.min(Math.max(8, s.width * 4.5), Math.hypot(s.x1 - s.x0, s.y1 - s.y0) / 2);

/** An arrow's head: the two barb ends, the tip being (x1, y1). */
export function arrowHead(s: Shape) {
	const len = arrowSize(s);
	const a = Math.atan2(s.y1 - s.y0, s.x1 - s.x0);
	const spread = Math.PI / 7;
	return [
		{ x: s.x1 - len * Math.cos(a - spread), y: s.y1 - len * Math.sin(a - spread) },
		{ x: s.x1 - len * Math.cos(a + spread), y: s.y1 - len * Math.sin(a + spread) }
	];
}

/** Bézier circle constant. */
export const KAPPA = 0.5522847498;

/** An ellipse inside a box as four cubic Béziers: start point, then the
 *  segments' [c1x, c1y, c2x, c2y, x, y]. */
export function ellipseCurves(b: { x0: number; y0: number; x1: number; y1: number }) {
	const cx = (b.x0 + b.x1) / 2;
	const cy = (b.y0 + b.y1) / 2;
	const rx = (b.x1 - b.x0) / 2;
	const ry = (b.y1 - b.y0) / 2;
	const kx = rx * KAPPA;
	const ky = ry * KAPPA;
	return {
		start: { x: cx + rx, y: cy },
		segs: [
			[cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
			[cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
			[cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
			[cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy]
		]
	};
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Does a point (same coordinates as the shape) touch it, within `radius`?
 *  Outlines count along their line; a cover anywhere inside. */
export function shapeHit(s: Shape, x: number, y: number, radius: number) {
	const r = radius + (s.kind === 'cover' ? 0 : s.width / 2);
	const b = shapeBox(s);
	if (s.kind === 'line' || s.kind === 'arrow') {
		if (segDist(x, y, s.x0, s.y0, s.x1, s.y1) <= r) return true;
		if (s.kind === 'line') return false;
		return arrowHead(s).some((p) => segDist(x, y, s.x1, s.y1, p.x, p.y) <= r);
	}
	const inBox = x >= b.x0 - r && x <= b.x1 + r && y >= b.y0 - r && y <= b.y1 + r;
	if (s.kind === 'cover' || !inBox) return inBox;
	if (s.kind === 'rect') return !(x > b.x0 + r && x < b.x1 - r && y > b.y0 + r && y < b.y1 - r);
	// Ellipse: distance from the outline, roughly (exact on the axes).
	const rx = (b.x1 - b.x0) / 2;
	const ry = (b.y1 - b.y0) / 2;
	if (rx <= 0 || ry <= 0) return true;
	const k = Math.hypot((x - (b.x0 + rx)) / rx, (y - (b.y0 + ry)) / ry);
	return Math.abs(k - 1) * Math.min(rx, ry) <= r;
}

/** The end of a drag from (x0, y0) to (x, y), held straight with Shift:
 *  a square / circle for boxes, a multiple of 45° for lines. */
export function constrain(kind: ShapeKind, x0: number, y0: number, x: number, y: number) {
	const dx = x - x0;
	const dy = y - y0;
	if (kind === 'line' || kind === 'arrow') {
		const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
		const len = Math.hypot(dx, dy);
		return { x: x0 + len * Math.cos(a), y: y0 + len * Math.sin(a) };
	}
	const side = Math.max(Math.abs(dx), Math.abs(dy));
	return { x: x0 + Math.sign(dx || 1) * side, y: y0 + Math.sign(dy || 1) * side };
}

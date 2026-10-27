// The lasso's geometry and clipboard: picking strokes, text boxes and shapes
// inside a loop, moving them, and copying them between places (and notes).
//
// Selected items are handled in world coordinates; putting them down again
// (`place`) gives them new ids and re-homes each onto the page under its
// start, page-local, the same way a fresh stroke or text box is.

import { uid, type Shape, type Stroke, type TextBox } from './model';
import { pageAt, type PlacedPage } from './pages';
import { textBounds } from './text';
import { shapeBounds, shapeMiddle } from './shapes';
import type { Box } from './viewport.svelte';

type Point = { x: number; y: number };

/** Items in world coordinates (no `page`). */
export interface Items {
	strokes: Stroke[];
	texts: TextBox[];
	shapes: Shape[];
}

/** An item's world copy, or null if it sits on a deleted page (not shown). */
function worldStroke(s: Stroke, pages: Map<string, PlacedPage>): Stroke | null {
	if (!s.page) return s;
	const p = pages.get(s.page);
	if (!p) return null;
	const { page: _, ...rest } = s;
	return { ...rest, points: s.points.map((q) => ({ x: q.x + p.x, y: q.y + p.y, pressure: q.pressure })) };
}

function worldText(t: TextBox, pages: Map<string, PlacedPage>): TextBox | null {
	if (!t.page) return t;
	const p = pages.get(t.page);
	if (!p) return null;
	const { page: _, ...rest } = t;
	return { ...rest, x: t.x + p.x, y: t.y + p.y };
}

function worldShape(s: Shape, pages: Map<string, PlacedPage>): Shape | null {
	if (!s.page) return s;
	const p = pages.get(s.page);
	if (!p) return null;
	const { page: _, ...rest } = s;
	return { ...rest, x0: s.x0 + p.x, y0: s.y0 + p.y, x1: s.x1 + p.x, y1: s.y1 + p.y };
}

/** Is (x, y) inside the polygon (even-odd)? */
function inside(poly: Point[], x: number, y: number) {
	let hit = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i];
		const b = poly[j];
		if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
	}
	return hit;
}

/** The items a lasso loop (world points) takes: strokes with most of their
 *  points inside it, text boxes and shapes whose middle is. */
export function lassoed(loop: Point[], strokes: Stroke[], texts: TextBox[], shapes: Shape[], pages: PlacedPage[]): Items {
	const byId = new Map(pages.map((p) => [p.id, p]));
	const out: Items = { strokes: [], texts: [], shapes: [] };
	if (loop.length < 3) return out;
	for (const s of strokes) {
		const w = worldStroke(s, byId);
		if (!w || w.points.length === 0) continue;
		const n = w.points.reduce((k, q) => k + (inside(loop, q.x, q.y) ? 1 : 0), 0);
		if (n * 2 >= w.points.length) out.strokes.push(w);
	}
	for (const t of texts) {
		const w = worldText(t, byId);
		if (!w) continue;
		const b = textBounds(w);
		if (inside(loop, b.x + b.w / 2, b.y + b.h / 2)) out.texts.push(w);
	}
	for (const s of shapes) {
		const w = worldShape(s, byId);
		const m = w && shapeMiddle(w);
		if (w && m && inside(loop, m.x, m.y)) out.shapes.push(w);
	}
	return out;
}

/** The world copies of the items with these ids (those still visible). */
export function itemsById(ids: Set<string>, strokes: Stroke[], texts: TextBox[], shapes: Shape[], pages: PlacedPage[]): Items {
	const byId = new Map(pages.map((p) => [p.id, p]));
	const out: Items = { strokes: [], texts: [], shapes: [] };
	for (const s of strokes) {
		const w = ids.has(s.id) ? worldStroke(s, byId) : null;
		if (w) out.strokes.push(w);
	}
	for (const t of texts) {
		const w = ids.has(t.id) ? worldText(t, byId) : null;
		if (w) out.texts.push(w);
	}
	for (const s of shapes) {
		const w = ids.has(s.id) ? worldShape(s, byId) : null;
		if (w) out.shapes.push(w);
	}
	return out;
}

/** World bounds of items (half a stroke's width included), or null if none. */
export function itemsBounds(items: Items): Box | null {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const s of items.strokes) {
		const r = s.width / 2;
		for (const q of s.points) {
			x0 = Math.min(x0, q.x - r);
			y0 = Math.min(y0, q.y - r);
			x1 = Math.max(x1, q.x + r);
			y1 = Math.max(y1, q.y + r);
		}
	}
	for (const t of items.texts) {
		const b = textBounds(t);
		x0 = Math.min(x0, b.x);
		y0 = Math.min(y0, b.y);
		x1 = Math.max(x1, b.x + b.w);
		y1 = Math.max(y1, b.y + b.h);
	}
	for (const s of items.shapes) {
		const b = shapeBounds(s);
		x0 = Math.min(x0, b.x0);
		y0 = Math.min(y0, b.y0);
		x1 = Math.max(x1, b.x1);
		y1 = Math.max(y1, b.y1);
	}
	return x0 <= x1 ? { x0, y0, x1, y1 } : null;
}

export const itemIds = (items: Items) =>
	new Set([...items.strokes.map((s) => s.id), ...items.texts.map((t) => t.id), ...items.shapes.map((s) => s.id)]);

/** World items shifted by (dx, dy), as new strokes / text boxes for the doc:
 *  fresh ids, each on the page under its start (page-local), else free. */
export function place(items: Items, dx: number, dy: number, pages: PlacedPage[]): Items {
	const strokes = items.strokes.map((s): Stroke => {
		const first = s.points[0];
		const p = pageAt(pages, first.x + dx, first.y + dy);
		const ox = dx - (p?.x ?? 0);
		const oy = dy - (p?.y ?? 0);
		const { page: _, ...rest } = s;
		return {
			...rest,
			id: uid(),
			points: s.points.map((q) => ({ x: q.x + ox, y: q.y + oy, pressure: q.pressure })),
			...(p ? { page: p.id } : {})
		};
	});
	const texts = items.texts.map((t): TextBox => {
		const p = pageAt(pages, t.x + dx, t.y + dy);
		const { page: _, ...rest } = t;
		return { ...rest, id: uid(), x: t.x + dx - (p?.x ?? 0), y: t.y + dy - (p?.y ?? 0), ...(p ? { page: p.id } : {}) };
	});
	const shapes = items.shapes.map((s): Shape => {
		const p = pageAt(pages, s.x0 + dx, s.y0 + dy);
		const ox = dx - (p?.x ?? 0);
		const oy = dy - (p?.y ?? 0);
		const { page: _, ...rest } = s;
		return { ...rest, id: uid(), x0: s.x0 + ox, y0: s.y0 + oy, x1: s.x1 + ox, y1: s.y1 + oy, ...(p ? { page: p.id } : {}) };
	});
	return { strokes, texts, shapes };
}

// --- Clipboard: per device, shared by its tabs (and notes) ---------------------

const CLIP_KEY = 'conote:clip';
let clip: Items | null = null;

export function copyItems(items: Items) {
	clip = structuredClone(items);
	try {
		localStorage.setItem(CLIP_KEY, JSON.stringify(clip));
	} catch {
		/* too big to keep, or storage off: this tab still has it */
	}
}

/** What was copied last (in any tab of this device), if anything. */
export function clipboard(): Items | null {
	try {
		const raw = localStorage.getItem(CLIP_KEY);
		if (raw) {
			const v = JSON.parse(raw) as Items;
			// Copied before shapes existed: none.
			if (Array.isArray(v?.strokes) && Array.isArray(v?.texts)) clip = { ...v, shapes: Array.isArray(v.shapes) ? v.shapes : [] };
		}
	} catch {
		/* keep this tab's own */
	}
	return clip && clip.strokes.length + clip.texts.length + clip.shapes.length > 0 ? clip : null;
}

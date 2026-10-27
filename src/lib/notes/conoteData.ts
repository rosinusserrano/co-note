// The ink a conote PDF carries for conote itself (see exportPdf.ts): an
// embedded file `conote.json`, read back on import so the strokes stay
// editable. It comes from a file, so everything in it is checked.

import { BRUSHES } from './ink';
import type { Brush, PageLayout, Shape, Stroke, TextBox } from './model';
import { isShapeKind } from './shapes';

export const CONOTE_FILE = 'conote.json';
/** The optional-content layer the drawn ink sits in; conote hides it. */
export const CONOTE_LAYER = 'conote ink';

export interface ConoteData {
	v: 1;
	layout: PageLayout;
	/** Per page of the PDF, in order. */
	pages: { extra: boolean }[];
	/** Page-local strokes; `page` is the PDF page index. */
	strokes: (Omit<Stroke, 'id' | 'page'> & { page: number })[];
	/** Page-local text boxes, the same way (absent in older exports). */
	texts: (Omit<TextBox, 'id' | 'page'> & { page: number })[];
	/** Page-local shapes, the same way (absent in older exports). */
	shapes: (Omit<Shape, 'id' | 'page'> & { page: number })[];
}

const MAX_STROKES = 200_000;
const MAX_POINTS = 20_000;
const MAX_TEXTS = 20_000;
const MAX_TEXT = 20_000;
const MAX_SHAPES = 20_000;
const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** The data, if `json` is conote data for a PDF of `pageCount` pages; else null. */
export function readConoteData(json: unknown, pageCount: number): ConoteData | null {
	if (!json || typeof json !== 'object') return null;
	const d = json as Record<string, unknown>;
	if (d.v !== 1 || !Array.isArray(d.pages) || !Array.isArray(d.strokes)) return null;
	if (d.pages.length !== pageCount || d.strokes.length > MAX_STROKES) return null;
	const strokes: ConoteData['strokes'] = [];
	for (const raw of d.strokes) {
		const s = raw as Record<string, unknown>;
		if (!s || typeof s !== 'object') continue;
		if (typeof s.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.color)) continue;
		if (!num(s.width, 0.01, 1000) || !Number.isInteger(s.page) || !num(s.page, 0, pageCount - 1)) continue;
		if (!Array.isArray(s.points) || s.points.length === 0 || s.points.length > MAX_POINTS) continue;
		const points = [];
		for (const p of s.points as Record<string, unknown>[]) {
			if (!p || !num(p.x, -1e6, 1e6) || !num(p.y, -1e6, 1e6) || !num(p.pressure, 0, 1)) break;
			points.push({ x: p.x, y: p.y, pressure: p.pressure });
		}
		if (points.length !== s.points.length) continue;
		const brush = typeof s.brush === 'string' && s.brush in BRUSHES ? (s.brush as Brush) : undefined;
		strokes.push({
			color: s.color,
			width: s.width,
			points,
			page: s.page as number,
			...(brush ? { brush } : {}),
			...(s.sim === true ? { sim: true } : {}),
			...(num(s.z, 0.001, 1000) ? { z: s.z } : {})
		});
	}
	const texts: ConoteData['texts'] = [];
	for (const raw of Array.isArray(d.texts) ? d.texts.slice(0, MAX_TEXTS) : []) {
		const t = raw as Record<string, unknown>;
		if (!t || typeof t !== 'object') continue;
		if (typeof t.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(t.color)) continue;
		if (typeof t.text !== 'string' || !t.text.trim() || t.text.length > MAX_TEXT) continue;
		if (!num(t.size, 0.5, 1000) || !num(t.x, -1e6, 1e6) || !num(t.y, -1e6, 1e6)) continue;
		if (!Number.isInteger(t.page) || !num(t.page, 0, pageCount - 1)) continue;
		texts.push({ x: t.x, y: t.y, text: t.text, size: t.size, color: t.color, page: t.page as number });
	}
	const shapes: ConoteData['shapes'] = [];
	for (const raw of Array.isArray(d.shapes) ? d.shapes.slice(0, MAX_SHAPES) : []) {
		const t = raw as Record<string, unknown>;
		if (!t || typeof t !== 'object' || !isShapeKind(t.kind)) continue;
		if (typeof t.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(t.color) || !num(t.width, 0, 1000)) continue;
		if (![t.x0, t.y0, t.x1, t.y1].every((v) => num(v, -1e6, 1e6))) continue;
		if (!Number.isInteger(t.page) || !num(t.page, 0, pageCount - 1)) continue;
		shapes.push({
			kind: t.kind,
			x0: t.x0 as number,
			y0: t.y0 as number,
			x1: t.x1 as number,
			y1: t.y1 as number,
			color: t.color,
			width: t.width,
			page: t.page as number,
			...(t.open === true ? { open: true } : {})
		});
	}
	return {
		v: 1,
		layout: d.layout === 'horizontal' ? 'horizontal' : 'vertical',
		pages: d.pages.map((p) => ({ extra: !!(p as { extra?: unknown })?.extra })),
		strokes,
		texts,
		shapes
	};
}

// The ink a conote PDF carries for conote itself (see exportPdf.ts): an
// embedded file `conote.json`, read back on import so the strokes stay
// editable. It comes from a file, so everything in it is checked.

import { BRUSHES } from './ink';
import type { Brush, PageLayout, Stroke } from './model';

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
}

const MAX_STROKES = 200_000;
const MAX_POINTS = 20_000;
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
	return {
		v: 1,
		layout: d.layout === 'horizontal' ? 'horizontal' : 'vertical',
		pages: d.pages.map((p) => ({ extra: !!(p as { extra?: unknown })?.extra })),
		strokes
	};
}

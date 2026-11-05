// Where each page sits in the world, and the geometry that depends on it.
//
// The page list (PageEntry[], shared in the Yjs doc) is in export order. The
// layout setting decides the axis the main pages run along ("the spine"); a
// page marked `extra` sits beside the page before it, across the spine:
//
//   vertical:   [1] [1a] [1b]        horizontal:  [1]  [2]
//               [2]                               [1a]
//                                                 [1b]
//
// Ink on a page is page-local, so recomputing this never moves ink off its page.

import type { PageEntry, PageLayout, Shape, Stroke, TextBox } from './model';
import type { Box } from './viewport.svelte';
import { textBounds } from './text';
import { shapeBounds } from './shapes';

/** Space between pages, world units (= PDF points at 100%). Leaves room for
 *  the page label above each page. */
export const PAGE_GAP = 48;

export interface PlacedPage extends PageEntry {
	x: number;
	y: number;
	/** 1-based position in the exported PDF. */
	n: number;
}

export function layoutPages(entries: PageEntry[], layout: PageLayout, origin = { x: 0, y: 0 }): PlacedPage[] {
	const vertical = layout === 'vertical';
	const out: PlacedPage[] = [];
	let rowStart = vertical ? origin.y : origin.x; // along the spine
	let rowSize = 0; // the row's extent along the spine
	let cross = 0; // next free position across it
	entries.forEach((e, i) => {
		const along = vertical ? e.h : e.w;
		const across = vertical ? e.w : e.h;
		if (!e.extra || i === 0) {
			if (i > 0) rowStart += rowSize + PAGE_GAP;
			rowSize = 0;
			cross = vertical ? origin.x : origin.y;
		}
		const x = vertical ? cross : rowStart;
		const y = vertical ? rowStart : cross;
		out.push({ ...e, x, y, n: i + 1 });
		cross += across + PAGE_GAP;
		rowSize = Math.max(rowSize, along);
	});
	return out;
}

/** The page under a world point, if any. */
export function pageAt(pages: PlacedPage[], wx: number, wy: number): PlacedPage | undefined {
	return pages.find((p) => wx >= p.x && wx <= p.x + p.w && wy >= p.y && wy <= p.y + p.h);
}

/** World-space bounds of the pages, all visible ink (half a stroke's width
 *  included) and text, or null for an empty note. Ink on a deleted page
 *  doesn't count. */
export function contentBounds(strokes: Stroke[], pages: PlacedPage[], texts: TextBox[] = [], shapes: Shape[] = []): Box | null {
	const byId = new Map(pages.map((p) => [p.id, p]));
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const p of pages) {
		x0 = Math.min(x0, p.x);
		y0 = Math.min(y0, p.y);
		x1 = Math.max(x1, p.x + p.w);
		y1 = Math.max(y1, p.y + p.h);
	}
	for (const s of strokes) {
		let dx = 0;
		let dy = 0;
		if (s.page) {
			const p = byId.get(s.page);
			if (!p) continue;
			dx = p.x;
			dy = p.y;
		}
		const r = s.width / 2;
		for (const pt of s.points) {
			x0 = Math.min(x0, pt.x + dx - r);
			y0 = Math.min(y0, pt.y + dy - r);
			x1 = Math.max(x1, pt.x + dx + r);
			y1 = Math.max(y1, pt.y + dy + r);
		}
	}
	for (const t of texts) {
		let dx = 0;
		let dy = 0;
		if (t.page) {
			const p = byId.get(t.page);
			if (!p) continue;
			dx = p.x;
			dy = p.y;
		}
		const b = textBounds(t);
		x0 = Math.min(x0, b.x + dx);
		y0 = Math.min(y0, b.y + dy);
		x1 = Math.max(x1, b.x + b.w + dx);
		y1 = Math.max(y1, b.y + b.h + dy);
	}
	for (const sh of shapes) {
		const p = sh.page ? byId.get(sh.page) : null;
		if (p === undefined) continue; // on a deleted page
		const b = shapeBounds(sh);
		x0 = Math.min(x0, b.x0 + (p?.x ?? 0));
		y0 = Math.min(y0, b.y0 + (p?.y ?? 0));
		x1 = Math.max(x1, b.x1 + (p?.x ?? 0));
		y1 = Math.max(y1, b.y1 + (p?.y ?? 0));
	}
	return x0 <= x1 ? { x0, y0, x1, y1 } : null;
}

// --- Rearranging ------------------------------------------------------------
//
// Every arrangement is rows: a row is a main page and the pages beside it
// (`extra`). These turn the flat list into rows and back, so a move, a swap
// or an insert is a list operation and the `extra` flags follow from where
// a page lands. Ink is page-local, so it goes wherever its page goes.

/** The pages grouped into rows, in order (the first page always starts one). */
export function pageRows<T extends PageEntry>(entries: T[]): T[][] {
	const rows: T[][] = [];
	entries.forEach((e, i) => {
		if (!e.extra || i === 0) rows.push([e]);
		else rows[rows.length - 1].push(e);
	});
	return rows;
}

/** Rows back to the flat list: each row's first page is its main page. */
export function joinRows(rows: PageEntry[][]): PageEntry[] {
	return rows.filter((r) => r.length > 0).flatMap((r) => r.map((p, i) => ({ ...strip(p), extra: i > 0 })));
}

/** A PageEntry without layout fields (x, y, n) a PlacedPage carries. */
function strip(p: PageEntry): PageEntry {
	const { id, w, h, extra, pdf } = p;
	return pdf ? { id, w, h, extra, pdf } : { id, w, h, extra };
}

/** Where a dragged page can go: into row `row` as its `at`-th page (0 = the
 *  row's main page), or into a row of its own before row `newRow`. */
export type PageSlot = { row: number; at: number } | { newRow: number };

/** `id` moved to `slot` (slot counted with the page still in its place). */
export function moveToSlot(entries: PageEntry[], id: string, slot: PageSlot): PageEntry[] {
	const page = entries.find((p) => p.id === id);
	if (!page) return entries;
	const MARK = { id: '\0mark' } as PageEntry;
	const rows = pageRows(entries).map((r) => [...r]);
	if ('newRow' in slot) rows.splice(Math.max(0, Math.min(slot.newRow, rows.length)), 0, [MARK]);
	else rows[slot.row]?.splice(Math.max(0, slot.at), 0, MARK);
	return joinRows(rows.map((r) => r.filter((p) => p.id !== id).map((p) => (p === MARK ? page : p))));
}

/** `id` swapped with the page before (dir −1) or after (+1) it. Each takes
 *  the other's place, so the rows keep their shape. */
export function swapPage(entries: PageEntry[], id: string, dir: -1 | 1): PageEntry[] {
	const i = entries.findIndex((p) => p.id === id);
	const j = i + dir;
	if (i < 0 || j < 0 || j >= entries.length) return entries;
	const out = entries.map(strip);
	out[i] = { ...strip(entries[j]), extra: entries[i].extra };
	out[j] = { ...strip(entries[i]), extra: entries[j].extra };
	return out;
}

/** `page` added just before or after `id`, in its row (before a main page:
 *  the new page becomes the row's main page, the old one beside it). */
export function insertPage(entries: PageEntry[], id: string, where: 'before' | 'after', page: PageEntry): PageEntry[] {
	const rows = pageRows(entries).map((r) => [...r]);
	for (const r of rows) {
		const k = r.findIndex((p) => p.id === id);
		if (k >= 0) {
			r.splice(where === 'before' ? k : k + 1, 0, page);
			return joinRows(rows);
		}
	}
	return entries;
}

/** `id` starting a row (`true`), or joining the row before it with the
 *  pages beside it (`false`). The first page always starts one. */
export function setRowStart(entries: PageEntry[], id: string, start: boolean): PageEntry[] {
	return entries.map((p, i) => (p.id === id && i > 0 ? { ...strip(p), extra: !start } : strip(p)));
}

/** Where a page dragged to world point (wx, wy) would land, and a line to
 *  show it (world coordinates). Over the middle of a row: beside the pages
 *  there, by which side of their middles it's on; near a row's leading or
 *  trailing edge, or past the ends: a row of its own. */
export function slotAt(
	pages: PlacedPage[],
	layout: PageLayout,
	wx: number,
	wy: number
): { slot: PageSlot; line: { x0: number; y0: number; x1: number; y1: number } } | null {
	if (pages.length === 0) return null;
	const vertical = layout === 'vertical';
	// along = the spine (rows follow each other), across = within a row
	const along = (p: { x: number; y: number }) => (vertical ? p.y : p.x);
	const across = (p: { x: number; y: number }) => (vertical ? p.x : p.y);
	const len = (p: PageEntry) => (vertical ? p.h : p.w);
	const wid = (p: PageEntry) => (vertical ? p.w : p.h);
	const pt = { x: wx, y: wy };
	const rows = pageRows(pages).map((r) => {
		const a0 = along(r[0]);
		const a1 = a0 + Math.max(...r.map(len));
		const c0 = across(r[0]);
		const c1 = across(r[r.length - 1]) + wid(r[r.length - 1]);
		return { r, a0, a1, c0, c1 };
	});
	const s = along(pt);
	const c = across(pt);
	const line = (a: number, b0: number, b1: number, a1 = a) =>
		vertical ? { x0: b0, y0: a, x1: b1, y1: a1 } : { x0: a, y0: b0, x1: a1, y1: b1 };
	const half = PAGE_GAP / 2;
	const newRow = (k: number) => {
		const next = rows[k];
		const prev = rows[k - 1];
		const a = next ? next.a0 - half : prev.a1 + half;
		const near = [prev, next].filter(Boolean) as typeof rows;
		const b0 = Math.min(...near.map((q) => q.c0));
		const b1 = Math.max(...near.map((q) => q.c1));
		return { slot: { newRow: k } as PageSlot, line: line(a, b0, b1) };
	};
	for (let k = 0; k < rows.length; k++) {
		const { r, a0, a1 } = rows[k];
		if (s < a0 - half) return newRow(k);
		if (s > a1 + half) continue;
		const edge = Math.min(0.2 * (a1 - a0), 160);
		if (s < a0 + edge) return newRow(k);
		if (s > a1 - edge) return newRow(k + 1);
		const at = r.filter((p) => across(p) + wid(p) / 2 < c).length;
		const b = at === 0 ? across(r[0]) - half : at === r.length ? across(r[at - 1]) + wid(r[at - 1]) + half : across(r[at]) - half;
		// Drawn as a cross-row bar: across = b, spanning the row along the spine.
		return { slot: { row: k, at }, line: vertical ? { x0: b, y0: a0, x1: b, y1: a1 } : { x0: a0, y0: b, x1: a1, y1: b } };
	}
	return newRow(rows.length);
}

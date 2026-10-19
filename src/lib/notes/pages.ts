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

import type { PageEntry, PageLayout, Stroke } from './model';
import type { Box } from './viewport.svelte';

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

/** World-space bounds of the pages and all visible ink (half a stroke's width
 *  included), or null for an empty note. Ink on a deleted page doesn't count. */
export function contentBounds(strokes: Stroke[], pages: PlacedPage[]): Box | null {
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
	return x0 <= x1 ? { x0, y0, x1, y1 } : null;
}

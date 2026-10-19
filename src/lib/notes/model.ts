// Core note/drawing data model.
//
// All stroke geometry is stored in *world* coordinates — an infinite 2D plane
// that is independent of any particular screen. Each session then maps this
// world onto its own screen via a Viewport (see viewport.svelte.ts). This is
// what lets a laptop and a tablet look at the same note content while keeping
// their own zoom and scroll.

/** A single sampled input point in world coordinates. */
export interface StrokePoint {
	x: number;
	y: number;
	/** Pen pressure in [0, 1]. 0.5 is used as a neutral default for mouse. */
	pressure: number;
}

export interface Stroke {
	id: string;
	color: string;
	/** Base width in world units; modulated per-point by pressure at render time. */
	width: number;
	points: StrokePoint[];
	/**
	 * How the ink is shaped (see BRUSHES in ink.ts). Absent on strokes from
	 * before brushes existed, which keep their original look.
	 */
	brush?: Brush;
	/** Pressure wasn't measured (mouse): thickness follows speed instead. */
	sim?: boolean;
	/**
	 * The zoom (screen px per world unit) it was drawn at. Smoothing works in
	 * those screen pixels, so detail drawn zoomed in survives (see ink.ts).
	 * Absent on older strokes, which keep the zoom-blind shape.
	 */
	z?: number;
	/**
	 * The page this ink was drawn on (a PageEntry id). Its points are then
	 * *page-local*: PDF points from the page's top-left corner, y down. That
	 * way ink moves with its page when the layout changes, and export can put
	 * it straight onto the PDF page. Absent: free ink in world coordinates.
	 */
	page?: string;
}

/**
 * One page of the note, in export order. Sizes are PDF points (1 pt = 1 world
 * unit at 100% zoom).
 *
 * `extra` pages are the ones added by hand: in the UI they sit *beside* the
 * page before them (to the right when pages run vertically, below when they
 * run horizontally); in the exported PDF they simply follow it.
 */
export interface PageEntry {
	id: string;
	w: number;
	h: number;
	extra: boolean;
	/** Set for a page of an imported PDF; absent for a blank page. */
	pdf?: {
		/** sha256 of the file, as stored on the note server. */
		file: string;
		/** 0-based page index in that file. */
		index: number;
		/** pdf.js viewport transform at scale 1 (PDF user space → page-local),
		 *  kept so export can map ink back without loading pdf.js. */
		vt: number[];
	};
}

export type PageLayout = 'vertical' | 'horizontal';

export type Brush = 'pen' | 'brush' | 'marker';

// A note itself has no type here: its strokes are the Yjs Y.Array in
// noteStore.svelte.ts, and its name/id/token are a NoteEntry in noteIndex.svelte.ts.
// The two are joined by note id.

/** Cheap unique-enough id for strokes/notes (no external dependency). */
export function uid(): string {
	return (
		Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
	);
}

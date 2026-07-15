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
}

export interface Note {
	id: string;
	title: string;
	strokes: Stroke[];
	updatedAt: number;
}

export function createEmptyNote(id = 'default'): Note {
	return { id, title: 'Untitled note', strokes: [], updatedAt: Date.now() };
}

/** Cheap unique-enough id for strokes/sessions (no external dependency). */
export function uid(): string {
	return (
		Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
	);
}

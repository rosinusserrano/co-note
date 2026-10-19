// Per-session viewport: how *this* session maps world coordinates onto its
// screen. This is the heart of the "independent zoom and scroll" requirement —
// each open session (laptop, tablet, ...) owns its own Viewport instance and
// never shares it, even while looking at the same note.
//
// Transform: screen = (world * scale) + offset
//            world  = (screen - offset) / scale

export interface Vec2 {
	x: number;
	y: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 20;

export class Viewport {
	scale = $state(1);
	offset = $state<Vec2>({ x: 0, y: 0 });

	/** Screen-space point (e.g. from a PointerEvent) -> world-space point. */
	toWorld(sx: number, sy: number): Vec2 {
		return {
			x: (sx - this.offset.x) / this.scale,
			y: (sy - this.offset.y) / this.scale
		};
	}

	/** World-space point -> screen-space point. */
	toScreen(wx: number, wy: number): Vec2 {
		return {
			x: wx * this.scale + this.offset.x,
			y: wy * this.scale + this.offset.y
		};
	}

	/** Pan by a screen-space delta (e.g. drag / two-finger move). */
	panBy(dx: number, dy: number) {
		this.offset = { x: this.offset.x + dx, y: this.offset.y + dy };
	}

	/**
	 * Zoom by `factor`, keeping the world point currently under (cx, cy) —
	 * the pinch centroid or the mouse cursor — pinned to that same screen spot.
	 */
	zoomAt(cx: number, cy: number, factor: number) {
		const next = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
		const applied = next / this.scale;
		this.offset = {
			x: cx - (cx - this.offset.x) * applied,
			y: cy - (cy - this.offset.y) * applied
		};
		this.scale = next;
	}

	reset() {
		this.scale = 1;
		this.offset = { x: 0, y: 0 };
	}

	/**
	 * Frame a world-space box in a `width`×`height` screen, centred, with
	 * `pad` screen pixels to spare. Never magnifies past MAX_FIT_SCALE, so a
	 * lone dot doesn't fill the screen. An empty note just resets.
	 */
	fit(box: Box | null, width: number, height: number, pad = 32) {
		if (!box || width <= 0 || height <= 0) return this.reset();
		const to = framing(box, width, height, pad, MAX_FIT_SCALE);
		this.scale = to.scale;
		this.offset = to.offset;
	}

	/** The world-space rectangle a `width`×`height` screen shows. */
	visible(width: number, height: number) {
		const a = this.toWorld(0, 0);
		return { x: a.x, y: a.y, w: width / this.scale, h: height / this.scale };
	}
}

/** Axis-aligned world-space bounds. */
export interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** How far fitting a drawing may magnify (a lone dot shouldn't fill the screen). */
export const MAX_FIT_SCALE = 3;

/** The scale and offset that frame `box`, centred, in a `width`×`height`
 *  screen with `pad` px to spare, magnifying no further than `maxScale`. */
export function framing(box: Box, width: number, height: number, pad = 0, maxScale = MAX_SCALE) {
	const w = Math.max(box.x1 - box.x0, 1);
	const h = Math.max(box.y1 - box.y0, 1);
	const scale = clamp(Math.min((width - 2 * pad) / w, (height - 2 * pad) / h), MIN_SCALE, maxScale);
	return {
		scale,
		offset: { x: width / 2 - ((box.x0 + box.x1) / 2) * scale, y: height / 2 - ((box.y0 + box.y1) / 2) * scale }
	};
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}

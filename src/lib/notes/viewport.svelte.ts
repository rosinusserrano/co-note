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
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}

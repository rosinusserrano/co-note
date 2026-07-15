<script lang="ts">
	import { noteStore } from '$lib/notes/noteStore.svelte';
	import { uid, type Stroke, type StrokePoint } from '$lib/notes/model';
	import type { Viewport } from '$lib/notes/viewport.svelte';

	interface Props {
		viewport: Viewport;
		/** 'draw' allows pen/mouse to ink; 'observe' is view-only (still pans/zooms). */
		mode?: 'draw' | 'observe';
		/** Active tool for pen/mouse input. */
		tool?: 'pen' | 'eraser';
		color?: string;
		strokeWidth?: number;
	}

	let {
		viewport,
		mode = 'draw',
		tool = 'pen',
		color = '#f9fafb',
		strokeWidth = 2.5
	}: Props = $props();

	// Eraser radius in *screen* pixels — kept constant on screen at any zoom.
	const ERASER_SCREEN_RADIUS = 14;

	let canvas: HTMLCanvasElement;
	let ctx: CanvasRenderingContext2D | null = null;
	let dpr = 1;
	let dirty = true;

	// The stroke currently being drawn by a pen/mouse (owned here, not the store,
	// so per-point updates stay off the reactive path).
	let liveStroke: Stroke | null = null;
	let drawingPointerId: number | null = null;

	// Eraser gesture state.
	let erasePointerId: number | null = null;
	let eraseStarted = false; // whether we've pushed a history step this gesture
	let eraserCursor: { x: number; y: number } | null = null; // screen coords

	// Active touch pointers, for one-finger pan and two-finger pinch-zoom.
	const touches = new Map<number, { x: number; y: number }>();
	let pinchPrev: { dist: number; cx: number; cy: number } | null = null;

	// --- Render loop -------------------------------------------------------

	function markDirty() {
		dirty = true;
	}

	function resize() {
		const rect = canvas.getBoundingClientRect();
		dpr = window.devicePixelRatio || 1;
		canvas.width = Math.round(rect.width * dpr);
		canvas.height = Math.round(rect.height * dpr);
		markDirty();
	}

	function strokeSegments(s: Stroke) {
		if (!ctx || s.points.length === 0) return;
		ctx.strokeStyle = s.color;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		if (s.points.length === 1) {
			const p = s.points[0];
			ctx.fillStyle = s.color;
			ctx.beginPath();
			ctx.arc(p.x, p.y, (s.width * pressureScale(p.pressure)) / 2, 0, Math.PI * 2);
			ctx.fill();
			return;
		}
		for (let i = 1; i < s.points.length; i++) {
			const a = s.points[i - 1];
			const b = s.points[i];
			ctx.lineWidth = s.width * pressureScale((a.pressure + b.pressure) / 2);
			ctx.beginPath();
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
			ctx.stroke();
		}
	}

	function pressureScale(p: number) {
		// Keep a floor so zero-pressure samples still leave a visible mark.
		return 0.35 + 0.65 * p;
	}

	function render() {
		if (ctx && dirty) {
			dirty = false;
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			// world -> device pixels
			ctx.setTransform(
				viewport.scale * dpr,
				0,
				0,
				viewport.scale * dpr,
				viewport.offset.x * dpr,
				viewport.offset.y * dpr
			);
			for (const s of noteStore.strokes) strokeSegments(s);
			if (liveStroke) strokeSegments(liveStroke);

			// Eraser cursor ring, drawn in screen space on top.
			if (eraserCursor) {
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				ctx.beginPath();
				ctx.arc(eraserCursor.x, eraserCursor.y, ERASER_SCREEN_RADIUS, 0, Math.PI * 2);
				ctx.strokeStyle = 'rgba(249,250,251,0.9)';
				ctx.lineWidth = 1.5;
				ctx.stroke();
			}
		}
		requestAnimationFrame(render);
	}

	// Redraw whenever shared strokes (local or remote) or this session's viewport
	// change. `revision` bumps on every Yjs update, including remote peers'.
	$effect(() => {
		// touch the reactive deps
		void noteStore.revision;
		void viewport.scale;
		void viewport.offset;
		markDirty();
	});

	$effect(() => {
		ctx = canvas.getContext('2d');
		resize();
		const ro = new ResizeObserver(resize);
		ro.observe(canvas);
		const raf = requestAnimationFrame(render);
		return () => {
			ro.disconnect();
			cancelAnimationFrame(raf);
		};
	});

	// --- Pointer input -----------------------------------------------------

	function samplePoint(e: PointerEvent): StrokePoint {
		const w = viewport.toWorld(e.clientX, e.clientY);
		const pressure = e.pressure > 0 ? e.pressure : 0.5;
		return { x: w.x, y: w.y, pressure };
	}

	// Squared distance from world point p to segment ab.
	function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
		const dx = bx - ax;
		const dy = by - ay;
		const len2 = dx * dx + dy * dy;
		let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
		t = Math.max(0, Math.min(1, t));
		const cx = ax + t * dx;
		const cy = ay + t * dy;
		return (px - cx) ** 2 + (py - cy) ** 2;
	}

	function strokeHit(s: Stroke, wx: number, wy: number, radius: number) {
		const r2 = radius * radius;
		if (s.points.length === 1) {
			return (wx - s.points[0].x) ** 2 + (wy - s.points[0].y) ** 2 <= r2;
		}
		for (let i = 1; i < s.points.length; i++) {
			const a = s.points[i - 1];
			const b = s.points[i];
			if (distToSegmentSq(wx, wy, a.x, a.y, b.x, b.y) <= r2) return true;
		}
		return false;
	}

	function eraseAt(e: PointerEvent) {
		const w = viewport.toWorld(e.clientX, e.clientY);
		const radius = ERASER_SCREEN_RADIUS / viewport.scale; // world units
		const hits = new Set<string>();
		for (const s of noteStore.strokes) {
			if (strokeHit(s, w.x, w.y, radius + s.width / 2)) hits.add(s.id);
		}
		if (hits.size === 0) return;
		if (!eraseStarted) {
			noteStore.beginChange(); // one history step per erase gesture
			eraseStarted = true;
		}
		noteStore.removeStrokes(hits);
	}

	function onPointerDown(e: PointerEvent) {
		if (e.pointerType === 'touch') {
			touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (touches.size === 2) beginPinch();
			return;
		}
		// pen or mouse
		if (mode !== 'draw') return;
		canvas.setPointerCapture(e.pointerId);
		if (tool === 'eraser') {
			erasePointerId = e.pointerId;
			eraseStarted = false;
			eraserCursor = { x: e.clientX, y: e.clientY };
			eraseAt(e);
			markDirty();
			return;
		}
		drawingPointerId = e.pointerId;
		liveStroke = { id: uid(), color, width: strokeWidth, points: [samplePoint(e)] };
		markDirty();
	}

	function onPointerMove(e: PointerEvent) {
		if (e.pointerType === 'touch') {
			if (!touches.has(e.pointerId)) return;
			touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (touches.size >= 2) updatePinch();
			else panWithTouch();
			return;
		}
		if (e.pointerId === erasePointerId) {
			eraserCursor = { x: e.clientX, y: e.clientY };
			const events = e.getCoalescedEvents?.() ?? [e];
			for (const ev of events) eraseAt(ev);
			markDirty();
			return;
		}
		if (e.pointerId !== drawingPointerId || !liveStroke) return;
		// Use coalesced events for high-frequency pen sampling.
		const events = e.getCoalescedEvents?.() ?? [e];
		for (const ev of events) liveStroke.points.push(samplePoint(ev));
		markDirty();
	}

	function onPointerUp(e: PointerEvent) {
		if (e.pointerType === 'touch') {
			touches.delete(e.pointerId);
			pinchPrev = null;
			if (touches.size === 1) primeTouchPan();
			return;
		}
		if (e.pointerId === erasePointerId) {
			erasePointerId = null;
			eraseStarted = false;
			eraserCursor = null;
			markDirty();
			return;
		}
		if (e.pointerId !== drawingPointerId) return;
		if (liveStroke && liveStroke.points.length > 0) {
			noteStore.addStroke($state.snapshot(liveStroke) as Stroke);
		}
		liveStroke = null;
		drawingPointerId = null;
	}

	// One-finger pan
	let lastTouchCentroid: { x: number; y: number } | null = null;
	function primeTouchPan() {
		const only = [...touches.values()][0];
		lastTouchCentroid = only ? { ...only } : null;
	}
	function panWithTouch() {
		const only = [...touches.values()][0];
		if (!only) return;
		if (lastTouchCentroid) {
			viewport.panBy(only.x - lastTouchCentroid.x, only.y - lastTouchCentroid.y);
		}
		lastTouchCentroid = { ...only };
	}

	// Two-finger pinch-zoom + pan
	function centroidAndDist() {
		const pts = [...touches.values()];
		const cx = (pts[0].x + pts[1].x) / 2;
		const cy = (pts[0].y + pts[1].y) / 2;
		const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
		return { cx, cy, dist };
	}
	function beginPinch() {
		pinchPrev = centroidAndDist();
		lastTouchCentroid = null;
	}
	function updatePinch() {
		if (touches.size < 2) return;
		const now = centroidAndDist();
		if (pinchPrev) {
			viewport.panBy(now.cx - pinchPrev.cx, now.cy - pinchPrev.cy);
			if (pinchPrev.dist > 0) viewport.zoomAt(now.cx, now.cy, now.dist / pinchPrev.dist);
		}
		pinchPrev = now;
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		if (e.ctrlKey) {
			// Trackpad pinch / ctrl+wheel -> zoom at cursor.
			viewport.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
		} else {
			// Mouse wheel -> zoom; hold shift for finer control handled by delta.
			viewport.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
		}
	}
</script>

<canvas
	bind:this={canvas}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onwheel={onWheel}
></canvas>

<style>
	canvas {
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none; /* we handle all pan/zoom ourselves */
		cursor: crosshair;
	}
</style>

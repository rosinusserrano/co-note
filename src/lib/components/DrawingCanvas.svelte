<script lang="ts">
	import { noteStore, type Presence } from '$lib/notes/noteStore.svelte';
	import { uid, type Stroke, type StrokePoint } from '$lib/notes/model';
	import { framing, type Box, type Viewport } from '$lib/notes/viewport.svelte';
	import { inkShape, liveInkShape, isMarker, strokeZoom, MARKER_ALPHA, type InkShape } from '$lib/notes/ink';
	import type { Brush } from '$lib/notes/model';
	import { pageAt, PAGE_GAP, type PlacedPage } from '$lib/notes/pages';
	import type { PageRenderer } from '$lib/notes/pdf';

	interface Props {
		viewport: Viewport;
		/** 'draw' allows pen/mouse to ink; 'observe' is view-only (still pans/zooms). */
		mode?: 'draw' | 'observe';
		/** Active tool for pen/mouse input: a brush, the eraser, the laser
		 *  pointer, or the hand (drags the view around). */
		tool?: Brush | 'eraser' | 'laser' | 'hand';
		color?: string;
		strokeWidth?: number;
		/** Draw other sessions' cursors and visible areas. */
		showPresence?: boolean;
		/** With presence on: their visible areas too, not just cursors. */
		showViews?: boolean;
		/** The canvas's size in CSS pixels — the screen the viewport maps onto. */
		width?: number;
		height?: number;
		/** Called when the user pans or zooms by hand (e.g. to leave follow mode). */
		onnavigate?: () => void;
		/** Show add/delete buttons on pages (editors). */
		pageActions?: boolean;
		/** After scrolling stops, glide to the nearest page edge (pages only). */
		snap?: boolean;
		/** Called with true when a stroke or laser starts and false when it
		 *  ends — the chrome steps back while the pen is down. */
		onactive?: (on: boolean) => void;
		/** One finger uses the tool (phones); otherwise it moves the view and
		 *  only pen/mouse ink (tablets with a pen). Two fingers always pan/zoom. */
		fingerInks?: boolean;
		/** Called once, the first time a pen is seen (touching or hovering). */
		onpen?: () => void;
		/** What a pen does while its barrel button is held as it touches down
		 *  (null: nothing special). A pen's eraser end always erases. */
		penButton?: PenUse | null;
	}

	type Tool = NonNullable<Props['tool']>;
	/** A tool with the ink it draws in. */
	type PenUse = { tool: Tool; color: string; width: number };

	let {
		viewport,
		mode = 'draw',
		tool = 'pen',
		color = '#111827',
		strokeWidth = 2.5,
		showPresence = true,
		showViews = true,
		width = $bindable(0),
		height = $bindable(0),
		onnavigate,
		pageActions = false,
		snap = false,
		onactive,
		fingerInks = false,
		onpen,
		penButton = null
	}: Props = $props();

	// The desk around the pages: warm paper with a dot grid. Pages stay white
	// (that's what a PDF expects, and what export prints on).
	const PAPER = '#f4f0e7';
	const GRID_DOT = 'rgba(52, 44, 28, 0.24)';
	/** Dot spacing on screen stays within [2, 4) × this many px: the world
	 *  spacing halves / doubles with the zoom, the finer level fading in. */
	const GRID_UNIT = 12;
	// Canvas text, in the app's typefaces (loaded by the chrome around it).
	const FONT_MONO = "'DM Mono', ui-monospace, monospace";

	// Eraser radius in *screen* pixels — kept constant on screen at any zoom.
	const ERASER_SCREEN_RADIUS = 14;
	// A new pen sample closer than this (screen px) to the last one adds nothing
	// visible, only bytes to sync.
	const MIN_SAMPLE_DIST = 0.75;
	// How often this session tells the others where its cursor / view is.
	const CURSOR_EVERY_MS = 50;
	// Faster while the laser is on: the others draw its trail from these.
	const LASER_EVERY_MS = 30;
	// A stroke in progress goes out to the others in chunks this often.
	const LIVE_EVERY_MS = 30;
	// How long a laser trail takes to fade.
	const LASER_FADE_MS = 900;
	const VIEW_EVERY_MS = 120;
	// Palm rejection: a touch that lands while the pen is down or hovering, or
	// this soon after it was, is a hand resting on the screen, not a gesture…
	const PEN_GRACE_MS = 500;
	// …and so is one whose contact patch is wider than a fingertip (CSS px;
	// fingers report roughly 5–25, browsers without contact size report 1).
	const PALM_PX = 64;
	// Predicted pen points drawn ahead of the real ones (never stored or sent).
	const MAX_PREDICTED = 3;
	// A finger stroke this young becomes a pinch if a second finger lands (and
	// isn't shown to the others until it's this old, so a pinch never flashes).
	const FINGER_SETTLE_MS = 250;
	// Following something: the view eases toward it with this time constant.
	const TRACK_TAU_MS = 110;
	// Being pulled to a view (showView): the glide's length grows with how far
	// it zooms out and back in (in e-folds of zoom), within these bounds.
	const PULL_MIN_MS = 500;
	const PULL_MS_PER_EFOLD = 480;
	const PULL_MAX_MS = 2300;
	// …and its speed: full at the start and end, easing down to this fraction
	// of that at the turn (the widest point), never stopping there.
	const PULL_TURN_SPEED = 0.35;

	let canvas: HTMLCanvasElement;
	let ctx: CanvasRenderingContext2D | null = null;
	// Committed strokes are drawn once into `base` and reused every frame, so a
	// live stroke only costs itself — not a redraw of the whole note per sample.
	const base = typeof document !== 'undefined' ? document.createElement('canvas') : null;
	let bctx: CanvasRenderingContext2D | null = null;
	// Marker ink gets its own layer, composited translucent and *multiplied*
	// under the other ink: a highlighter darkens what's beneath it (PDF text
	// stays black) instead of veiling it.
	const markers = typeof document !== 'undefined' ? document.createElement('canvas') : null;
	let mctx: CanvasRenderingContext2D | null = null;
	let dpr = 1;
	let dirty = true; // the frame needs compositing
	let baseDirty = true; // committed strokes or the transform changed

	// Screen coordinates throughout this component are canvas-local CSS pixels:
	// the canvas sits below the toolbar, so pointer clientX/Y are shifted by
	// its position first. The viewport maps world ↔ these coordinates.
	let originX = 0;
	let originY = 0;

	// The stroke currently being drawn by a pen/mouse (owned here, not the store,
	// so per-point updates stay off the reactive path).
	let liveStroke: Stroke | null = null;
	/** The page the live stroke is on (its points are local to it), if any. */
	let livePage: PlacedPage | null = null;
	let drawingPointerId: number | null = null;
	let lastSampleSkipped: StrokePoint | null = null;
	// How many of the live stroke's points the others have been sent.
	let liveSent = 0;
	let liveTimer: ReturnType<typeof setTimeout> | null = null;
	/** Where the pen is about to be (getPredictedEvents): drawn on the live
	 *  stroke's tip to hide a frame or two of latency, replaced every move. */
	let predicted: StrokePoint[] = [];
	/** Last time a pen touched or hovered (performance.now()), for palm rejection. */
	let penSeenAt = -Infinity;
	let penReported = false;
	/** The finger that is inking (drawing, erasing, pointing), and where it is —
	 *  kept so it can join a pinch if a second finger lands. */
	let touchInk: number | null = null;
	let touchInkAt: { x: number; y: number } | null = null;
	/** When the current stroke / erase / laser began (performance.now()). */
	let inkStartedAt = 0;
	/** The live stroke goes out to the others no earlier than this. */
	let liveHoldUntil = 0;

	// Eraser gesture state.
	let erasePointerId: number | null = null;
	let eraseStarted = false; // whether we've pushed a history step this gesture
	let eraserCursor: { x: number; y: number } | null = null; // screen coords

	// Laser pointer: trails in world coordinates (so they stay put under pan
	// and zoom), keyed 'self' or by the other session's awareness id. Never
	// stored in the note; the others see ours through presence (`laser` on +
	// the cursor stream) and build the same trail from it.
	type LaserPoint = { x: number; y: number; t: number; gap?: boolean };
	const trails = new Map<string | number, { pts: LaserPoint[]; on: boolean }>();
	let laserPointerId: number | null = null;

	// Active touch pointers, for one-finger pan and two-finger pinch-zoom.
	const touches = new Map<number, { x: number; y: number }>();
	let pinchPrev: { dist: number; cx: number; cy: number } | null = null;

	// --- Render loop -------------------------------------------------------

	function markDirty() {
		dirty = true;
	}

	function measure() {
		const rect = canvas.getBoundingClientRect();
		originX = rect.left;
		originY = rect.top;
		return rect;
	}

	function resize() {
		const rect = measure();
		dpr = window.devicePixelRatio || 1;
		canvas.width = Math.round(rect.width * dpr);
		canvas.height = Math.round(rect.height * dpr);
		for (const layer of [base, markers]) {
			if (!layer) continue;
			layer.width = canvas.width;
			layer.height = canvas.height;
		}
		width = rect.width;
		height = rect.height;
		baseDirty = true;
		markDirty();
	}

	/** Draw a stroke's shape (see ink.ts) in the context's current transform.
	 *  Marker opacity is the layer's business, not this function's. */
	function drawShape(c: CanvasRenderingContext2D, color: string, shape: InkShape) {
		c.strokeStyle = color;
		c.fillStyle = color;
		if (shape.kind === 'fill') {
			const path = shape.path;
			if (!path) return;
			c.beginPath();
			c.moveTo(path.x, path.y);
			for (const seg of path.segs) {
				if (seg.q) c.quadraticCurveTo(seg.cx, seg.cy, seg.x, seg.y);
				else c.lineTo(seg.x, seg.y);
			}
			c.closePath();
			c.fill();
			return;
		}
		c.lineCap = 'round';
		c.lineJoin = 'round';
		if (shape.dot) {
			c.beginPath();
			c.arc(shape.dot.x, shape.dot.y, shape.dot.r, 0, Math.PI * 2);
			c.fill();
		}
		for (const run of shape.runs) {
			c.lineWidth = run.width;
			c.beginPath();
			c.moveTo(run.x, run.y);
			for (const seg of run.segs) {
				if (seg.q) c.quadraticCurveTo(seg.cx, seg.cy, seg.x, seg.y);
				else c.lineTo(seg.x, seg.y);
			}
			c.stroke();
		}
	}

	/** Run `fn` in a page's local coordinates, clipped to the page: ink on a
	 *  page never shows outside it, just as in the exported PDF. */
	function onPage(c: CanvasRenderingContext2D, page: PlacedPage, fn: () => void) {
		c.save();
		c.translate(page.x, page.y);
		c.beginPath();
		c.rect(0, 0, page.w, page.h);
		c.clip();
		fn();
		c.restore();
	}

	/** Committed ink: free strokes in world coordinates, page strokes on their
	 *  page. `markerLayer` gets the marker strokes, `c` everything else. */
	function drawInk(c: CanvasRenderingContext2D, markerLayer: CanvasRenderingContext2D) {
		const pages = new Map(noteStore.pages.map((p) => [p.id, p]));
		const byPage = new Map<string, Stroke[]>();
		const target = (s: Stroke) => (isMarker(s) ? markerLayer : c);
		for (const s of noteStore.strokes) {
			if (!s.page) drawShape(target(s), s.color, inkShape(s));
			else if (pages.has(s.page)) {
				let list = byPage.get(s.page);
				if (!list) byPage.set(s.page, (list = []));
				list.push(s);
			}
			// else: its page was deleted; the ink waits in the doc for an undo
		}
		for (const [id, list] of byPage) {
			const page = pages.get(id)!;
			for (const layer of [markerLayer, c]) {
				const mine = list.filter((s) => target(s) === layer);
				if (mine.length > 0) onPage(layer, page, () => mine.forEach((s) => drawShape(layer, s.color, inkShape(s))));
			}
		}
	}

	let gridTile: HTMLCanvasElement | null = null;
	let gridTileKey = '';
	const GRID_TILE = 64; // device px; scaled to the real spacing by the pattern

	/** The dot grid, in world space so it moves and zooms with the ink, as one
	 *  pattern fill: a tile with one coarse dot and three fading fine ones. */
	function drawGrid(c: CanvasRenderingContext2D) {
		const s = viewport.scale;
		const world = 2 ** Math.floor(Math.log2((4 * GRID_UNIT) / s)); // world units between coarse dots
		const step = world * s; // screen px, in (2, 4] × GRID_UNIT
		const fine = Math.min(1, Math.max(0, (step - 2 * GRID_UNIT) / (2 * GRID_UNIT)));
		const T = step * dpr; // device px
		const k = GRID_TILE / T;
		const key = `${fine.toFixed(2)}|${k.toFixed(3)}|${dpr}`;
		if (!gridTile || key !== gridTileKey) {
			gridTile ??= document.createElement('canvas');
			gridTile.width = gridTile.height = GRID_TILE;
			const g = gridTile.getContext('2d')!;
			g.clearRect(0, 0, GRID_TILE, GRID_TILE);
			g.fillStyle = GRID_DOT;
			const r = 1.05 * dpr * k;
			const dot = (x: number, y: number) => {
				g.beginPath();
				g.arc(x, y, r, 0, Math.PI * 2);
				g.fill();
			};
			const h = GRID_TILE / 2;
			dot(h, h);
			g.globalAlpha = fine;
			dot(0, 0);
			dot(h, 0);
			dot(0, h);
			dot(GRID_TILE, 0);
			dot(0, GRID_TILE);
			dot(GRID_TILE, h);
			dot(h, GRID_TILE);
			dot(GRID_TILE, GRID_TILE);
			gridTileKey = key;
		}
		const pattern = c.createPattern(gridTile, 'repeat');
		if (!pattern) return;
		// Coarse dots on world multiples of `world`: the tile's centre dot lands there.
		const mod = (v: number) => ((v % T) + T) % T;
		pattern.setTransform(new DOMMatrix([1 / k, 0, 0, 1 / k, mod(viewport.offset.x * dpr - T / 2), mod(viewport.offset.y * dpr - T / 2)]));
		c.setTransform(1, 0, 0, 1, 0, 0);
		c.fillStyle = pattern;
		c.fillRect(0, 0, canvas.width, canvas.height);
	}

	/** Pages: a white sheet with a hairline edge and a soft shadow, then the
	 *  PDF content (if any) from the renderer. */
	function drawPages(c: CanvasRenderingContext2D) {
		const pages = noteStore.pages;
		if (pages.length === 0) return;
		const view = viewport.visible(width, height);
		const unit = 1 / viewport.scale; // one screen pixel, in world units
		setWorldTransform(c);
		for (const p of pages) {
			const vx0 = Math.max(p.x, view.x);
			const vy0 = Math.max(p.y, view.y);
			const vx1 = Math.min(p.x + p.w, view.x + view.w);
			const vy1 = Math.min(p.y + p.h, view.y + view.h);
			if (vx0 >= vx1 || vy0 >= vy1) continue; // off screen
			c.fillStyle = 'rgba(52,44,28,0.07)';
			c.fillRect(p.x + 2 * unit, p.y + 6 * unit, p.w, p.h);
			c.fillStyle = 'rgba(52,44,28,0.06)';
			c.fillRect(p.x + 1 * unit, p.y + 2 * unit, p.w, p.h);
			c.fillStyle = '#ffffff';
			c.fillRect(p.x, p.y, p.w, p.h);
			let ready = true;
			if (p.pdf && renderer) {
				ready = renderer.draw(c, p, { x: vx0 - p.x, y: vy0 - p.y, w: vx1 - vx0, h: vy1 - vy0 }, viewport.scale * dpr);
				if (!ready) pageNotice(c, p, renderer.failed(p.pdf.file) ? "Couldn't load this PDF page" : 'Loading…');
			}
			c.strokeStyle = 'rgba(52,44,28,0.22)';
			c.lineWidth = unit;
			c.strokeRect(p.x, p.y, p.w, p.h);
		}
	}

	function pageNotice(c: CanvasRenderingContext2D, p: PlacedPage, text: string) {
		const s = viewport.toScreen(p.x + p.w / 2, p.y + p.h / 2);
		c.save();
		c.setTransform(dpr, 0, 0, dpr, 0, 0);
		c.fillStyle = '#8a8274';
		c.font = `italic 22px 'Instrument Serif', Georgia, serif`;
		c.textAlign = 'center';
		c.fillText(text, s.x, s.y);
		c.restore();
	}

	function drawLive(c: CanvasRenderingContext2D) {
		let live = liveStroke;
		if (!live) return;
		if (predicted.length > 0) live = { ...live, points: [...live.points, ...predicted] };
		setWorldTransform(c);
		if (livePage) onPage(c, livePage, () => drawShape(c, live.color, liveInkShape(live)));
		else drawShape(c, live.color, liveInkShape(live));
	}

	/** The others' strokes in progress (markers or the rest), drawn like our
	 *  own live stroke until the real one lands. */
	function drawOthersLive(c: CanvasRenderingContext2D, markersPass: boolean) {
		const live = noteStore.liveStrokes;
		if (live.length === 0) return;
		setWorldTransform(c);
		for (const s of live) {
			if (isMarker(s) !== markersPass || s.points.length === 0) continue;
			if (s.page) {
				const page = noteStore.pages.find((p) => p.id === s.page);
				if (page) onPage(c, page, () => drawShape(c, s.color, liveInkShape(s)));
			} else drawShape(c, s.color, liveInkShape(s));
		}
	}

	function setWorldTransform(c: CanvasRenderingContext2D) {
		c.setTransform(
			viewport.scale * dpr,
			0,
			0,
			viewport.scale * dpr,
			viewport.offset.x * dpr,
			viewport.offset.y * dpr
		);
	}

	function drawPresence(c: CanvasRenderingContext2D, others: Presence[]) {
		c.setTransform(dpr, 0, 0, dpr, 0, 0);
		c.font = `500 11px ${FONT_MONO}`;
		c.textBaseline = 'middle';
		for (const p of others) {
			if (p.view && showViews) {
				const a = viewport.toScreen(p.view.x, p.view.y);
				const w = p.view.w * viewport.scale;
				const h = p.view.h * viewport.scale;
				c.strokeStyle = p.color;
				c.globalAlpha = 0.75;
				c.lineWidth = 1.5;
				c.setLineDash([2, 5]);
				c.lineCap = 'round';
				roundRect(c, a.x, a.y, w, h, 10);
				c.stroke();
				c.setLineDash([]);
				c.globalAlpha = 1;
				if (p.label) tag(c, p.label, p.color, a.x + 8, a.y + 8);
			}
			if (p.cursor) {
				const s = viewport.toScreen(p.cursor.x, p.cursor.y);
				c.fillStyle = '#fff';
				c.beginPath();
				c.arc(s.x, s.y, 6, 0, Math.PI * 2);
				c.fill();
				c.fillStyle = p.color;
				c.beginPath();
				c.arc(s.x, s.y, 4.5, 0, Math.PI * 2);
				c.fill();
				if (p.label) tag(c, p.label, p.color, s.x + 10, s.y + 10);
			}
		}
	}

	/** Fading laser trails (screen-constant widths), a glowing dot at the head
	 *  of each one that's on. Keeps the frame loop running while any fades. */
	function drawLasers(c: CanvasRenderingContext2D) {
		const now = performance.now();
		c.setTransform(dpr, 0, 0, dpr, 0, 0);
		c.lineCap = 'round';
		c.lineJoin = 'round';
		for (const [key, tr] of trails) {
			// While on, the newest point stays (it's where the dot is) however old.
			while (tr.pts.length > (tr.on ? 1 : 0) && now - tr.pts[0].t > LASER_FADE_MS) tr.pts.shift();
			if (tr.pts.length === 0 && !tr.on) {
				trails.delete(key);
				continue;
			}
			const pts = tr.pts.map((p) => ({ ...viewport.toScreen(p.x, p.y), k: 1 - (now - p.t) / LASER_FADE_MS, gap: p.gap }));
			// Smoothed through the midpoints, one piece per sample so each can
			// fade by the age of its newer end; two passes for a glow around a
			// hot core.
			for (const [width, color] of [
				[9, 'rgba(255,40,40,0.22)'],
				[3.2, 'rgba(255,48,48,1)']
			] as const) {
				c.strokeStyle = color;
				for (let i = 1; i < pts.length; i++) {
					if (pts[i].gap) continue;
					const a = pts[i - 1];
					const b = pts[i];
					const from = i >= 2 && !a.gap ? mid(pts[i - 2], a) : a;
					const to = i < pts.length - 1 && !pts[i + 1].gap ? mid(a, b) : b;
					const k = Math.max(0, b.k);
					c.globalAlpha = k;
					c.lineWidth = width * (0.35 + 0.65 * k);
					c.beginPath();
					c.moveTo(from.x, from.y);
					if (from === a) c.lineTo(to.x, to.y);
					else c.quadraticCurveTo(a.x, a.y, to.x, to.y);
					c.stroke();
				}
			}
			c.globalAlpha = 1;
			const head = pts[pts.length - 1];
			if (tr.on && head) {
				c.fillStyle = 'rgba(255,40,40,0.3)';
				c.beginPath();
				c.arc(head.x, head.y, 11, 0, Math.PI * 2);
				c.fill();
				c.fillStyle = '#ff2a2a';
				c.beginPath();
				c.arc(head.x, head.y, 5, 0, Math.PI * 2);
				c.fill();
				c.fillStyle = '#fff5f5';
				c.beginPath();
				c.arc(head.x, head.y, 2, 0, Math.PI * 2);
				c.fill();
			}
		}
		if (trails.size > 0) dirty = true; // fading: draw the next frame too
	}

	const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

	/** Add a point to a trail (world coords). After a break the first point
	 *  starts a new run instead of joining the old one. */
	function laserTo(key: string | number, x: number, y: number) {
		let tr = trails.get(key);
		if (!tr) trails.set(key, (tr = { pts: [], on: false }));
		const last = tr.pts[tr.pts.length - 1];
		if (tr.on && last && last.x === x && last.y === y) return;
		tr.pts.push({ x, y, t: performance.now(), gap: !tr.on });
		tr.on = true;
		markDirty();
	}

	function laserOff(key: string | number) {
		const tr = trails.get(key);
		if (tr) tr.on = false;
		markDirty();
	}

	// The others' lasers: their cursor while `laser` is on is the trail.
	$effect(() => {
		const seen = new Set<number>();
		for (const p of noteStore.presence) {
			seen.add(p.id);
			if (p.laser && p.cursor) laserTo(p.id, p.cursor.x, p.cursor.y);
			else laserOff(p.id);
		}
		for (const key of trails.keys()) if (typeof key === 'number' && !seen.has(key)) laserOff(key);
	});

	/** A small pill in the device's colour (top-left at x, y), readable over any ink. */
	function tag(c: CanvasRenderingContext2D, text: string, color: string, x: number, y: number) {
		const label = text.toUpperCase();
		const w = c.measureText(label).width;
		c.fillStyle = color;
		roundRect(c, x, y, w + 14, 19, 9.5);
		c.fill();
		c.fillStyle = '#fff';
		c.fillText(label, x + 7, y + 10);
	}

	function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
		c.beginPath();
		if (c.roundRect) c.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
		else c.rect(x, y, w, h);
	}

	function render(now: number) {
		stepTrack(now);
		if (ctx && bctx && base && mctx && markers && (dirty || baseDirty)) {
			if (baseDirty) {
				baseDirty = false;
				for (const [c, layer] of [[bctx, base], [mctx, markers]] as const) {
					c.setTransform(1, 0, 0, 1, 0, 0);
					c.clearRect(0, 0, layer.width, layer.height);
					setWorldTransform(c);
				}
				drawInk(bctx, mctx);
			}
			dirty = false;
			// Paper, then pages (PDF content), then ink on top of both.
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.fillStyle = PAPER;
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			drawGrid(ctx);
			drawPages(ctx);
			// Markers: translucent, multiplied onto paper/PDF, under the other ink.
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.globalCompositeOperation = 'multiply';
			ctx.globalAlpha = MARKER_ALPHA;
			ctx.drawImage(markers, 0, 0);
			if (liveStroke && isMarker(liveStroke)) drawLive(ctx);
			drawOthersLive(ctx, true);
			ctx.globalCompositeOperation = 'source-over';
			ctx.globalAlpha = 1;
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.drawImage(base, 0, 0);
			drawOthersLive(ctx, false);
			if (liveStroke && !isMarker(liveStroke)) drawLive(ctx);
			if (showPresence && noteStore.presence.length > 0) drawPresence(ctx, noteStore.presence);
			// Lasers show even with "Others" off: pointing is meant to be seen.
			if (trails.size > 0) drawLasers(ctx);

			// Eraser cursor ring, drawn in screen space on top.
			if (eraserCursor) {
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				ctx.beginPath();
				ctx.arc(eraserCursor.x, eraserCursor.y, ERASER_SCREEN_RADIUS, 0, Math.PI * 2);
				ctx.strokeStyle = 'rgba(25,24,20,0.7)';
				ctx.lineWidth = 1.5;
				ctx.stroke();
			}
		}
		raf = requestAnimationFrame(render);
	}
	let raf = 0;

	// Redraw whenever shared strokes (local or remote) or this session's viewport
	// change. `revision` bumps on every Yjs update, including remote peers'.
	$effect(() => {
		// touch the reactive deps
		void noteStore.revision;
		void viewport.scale;
		void viewport.offset;
		baseDirty = true;
		markDirty();
	});

	// Others moved, or the overlay was toggled: recomposite only.
	$effect(() => {
		void noteStore.presence;
		void noteStore.liveRevision;
		void showPresence;
		void showViews;
		markDirty();
	});

	$effect(() => {
		ctx = canvas.getContext('2d');
		bctx = base?.getContext('2d') ?? null;
		mctx = markers?.getContext('2d') ?? null;
		resize();
		const ro = new ResizeObserver(resize);
		ro.observe(canvas);
		raf = requestAnimationFrame(render);
		// Bound by hand to be sure it's not passive: preventDefault() is what
		// stops Ctrl+wheel from zooming the browser page instead of the note.
		canvas.addEventListener('wheel', onWheel, { passive: false });
		return () => {
			ro.disconnect();
			cancelAnimationFrame(raf);
			canvas.removeEventListener('wheel', onWheel);
			stopGlide();
		};
	});

	// --- Pages -------------------------------------------------------------

	// pdf.js is loaded only once the note has PDF pages, and torn down with it.
	let renderer: PageRenderer | null = null;
	const needsPdf = $derived(noteStore.pages.some((p) => p.pdf));
	$effect(() => {
		const id = noteStore.id;
		if (!needsPdf || !id) return;
		let alive = true;
		let mine: PageRenderer | null = null;
		void import('$lib/notes/pdf').then(({ PageRenderer }) => {
			if (!alive) return;
			mine = new PageRenderer((hash) => noteStore.fileBytes(hash), markDirty);
			renderer = mine;
			markDirty();
		});
		return () => {
			alive = false;
			mine?.destroy();
			if (renderer === mine) renderer = null;
		};
	});

	// Labels above the pages in view: number, and for editors add / delete.
	// They live in the gap above each page, so they're hidden once zoomed out
	// too far for them to fit there (rather than covering the page above).
	const PILL_HEIGHT = 22;
	const pills = $derived.by(() => {
		if (PAGE_GAP * viewport.scale < PILL_HEIGHT + 4 || width === 0) return [];
		const view = viewport.visible(width, height);
		return noteStore.pages
			.filter((p) => p.x < view.x + view.w && p.x + p.w > view.x && p.y - 30 / viewport.scale < view.y + view.h && p.y + p.h > view.y)
			.map((p) => ({ page: p, at: viewport.toScreen(p.x, p.y) }));
	});

	function deletePage(p: PlacedPage) {
		const inked = noteStore.strokes.some((s) => s.page === p.id);
		if ((inked || p.pdf) && !confirm(`Delete page ${p.n}${inked ? ' and the ink on it' : ''}? Undo brings it back.`)) return;
		noteStore.deletePage(p.id);
	}

	// --- Presence: tell the others where we are -----------------------------

	/** Leading + trailing throttle: the first call goes out at once, the last
	 *  one of a burst is never lost. */
	function throttle<T>(ms: number | (() => number), fn: (v: T) => void) {
		let last = 0;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let pending: T;
		return (v: T) => {
			pending = v;
			const wait = last + (typeof ms === 'number' ? ms : ms()) - Date.now();
			if (wait <= 0) {
				last = Date.now();
				fn(v);
			} else if (!timer) {
				timer = setTimeout(() => {
					timer = null;
					last = Date.now();
					fn(pending);
				}, wait);
			}
		};
	}
	const publishCursor = throttle<{ x: number; y: number } | null>(
		() => (laserPointerId !== null ? LASER_EVERY_MS : CURSOR_EVERY_MS),
		(cursor) =>
		noteStore.setPresence({ cursor })
	);
	const publishView = throttle<void>(VIEW_EVERY_MS, () => {
		if (width > 0 && height > 0) noteStore.setPresence({ view: viewport.visible(width, height) });
	});

	$effect(() => {
		void viewport.scale;
		void viewport.offset;
		void width;
		void height;
		void noteStore.id; // a fresh connection starts without a view
		publishView();
	});

	// --- Pointer input -----------------------------------------------------

	function local(e: PointerEvent | WheelEvent) {
		return { x: e.clientX - originX, y: e.clientY - originY };
	}

	function samplePoint(e: PointerEvent): StrokePoint {
		const s = local(e);
		const w = viewport.toWorld(s.x, s.y);
		const pressure = e.pressure > 0 ? e.pressure : 0.5;
		const ox = livePage?.x ?? 0;
		const oy = livePage?.y ?? 0;
		return { x: w.x - ox, y: w.y - oy, pressure };
	}

	function addSample(p: StrokePoint) {
		if (!liveStroke) return;
		const last = liveStroke.points[liveStroke.points.length - 1];
		const min = MIN_SAMPLE_DIST / viewport.scale;
		if (last && (p.x - last.x) ** 2 + (p.y - last.y) ** 2 < min * min) {
			lastSampleSkipped = p; // kept in case the stroke ends here
			return;
		}
		lastSampleSkipped = null;
		liveStroke.points.push(p);
		liveTimer ??= setTimeout(sendLive, LIVE_EVERY_MS);
	}

	const round = (v: number, k: number) => Math.round(v * k) / k;

	/** Send the others the live stroke's new points (see LiveChunk), with the
	 *  cursor at its tip — one presence message for both. */
	function sendLive() {
		if (liveTimer) clearTimeout(liveTimer);
		liveTimer = null;
		const wait = liveHoldUntil - performance.now();
		if (wait > 0) {
			liveTimer = setTimeout(sendLive, wait);
			return;
		}
		const s = liveStroke;
		if (!s || s.points.length <= liveSent) return;
		const pts: number[] = [];
		for (const p of s.points.slice(liveSent)) pts.push(round(p.x, 100), round(p.y, 100), round(p.pressure, 1000));
		const tip = s.points[s.points.length - 1];
		noteStore.setPresence({
			live: { id: s.id, color: s.color, width: s.width, brush: s.brush ?? 'pen', sim: !!s.sim, z: s.z, page: s.page, n: liveSent, pts },
			cursor: { x: tip.x + (livePage?.x ?? 0), y: tip.y + (livePage?.y ?? 0) }
		});
		liveSent = s.points.length;
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
		const s = local(e);
		const w = viewport.toWorld(s.x, s.y);
		const radius = ERASER_SCREEN_RADIUS / viewport.scale; // world units
		const pages = new Map(noteStore.pages.map((p) => [p.id, p]));
		const hits = new Set<string>();
		for (const s of noteStore.strokes) {
			let ox = 0;
			let oy = 0;
			if (s.page) {
				const p = pages.get(s.page);
				if (!p) continue; // on a deleted page: not visible, not erasable
				ox = p.x;
				oy = p.y;
			}
			if (strokeHit(s, w.x - ox, w.y - oy, radius + s.width / 2)) hits.add(s.id);
		}
		if (hits.size === 0) return;
		if (!eraseStarted) {
			noteStore.beginChange(); // one history step per erase gesture
			eraseStarted = true;
		}
		noteStore.removeStrokes(hits);
	}

	/** A stroke, erase or laser is under way: the view holds still until it
	 *  ends, or every sample after a move would land somewhere else. */
	const inking = () => drawingPointerId !== null || erasePointerId !== null || laserPointerId !== null;

	/** A touch to ignore: the hand holding the pen, not a finger meaning to
	 *  pan or zoom. */
	function isPalm(e: PointerEvent) {
		return inking() || performance.now() - penSeenAt < PEN_GRACE_MS || Math.max(e.width, e.height) > PALM_PX;
	}

	const inkPointer = (id: number) => id === drawingPointerId || id === erasePointerId || id === laserPointerId;

	function sawPen() {
		penSeenAt = performance.now();
		if (!penReported) {
			penReported = true;
			onpen?.();
		}
	}

	/** Throw away the stroke in progress: never committed, its preview ended. */
	function abortStroke() {
		if (liveTimer) clearTimeout(liveTimer);
		liveTimer = null;
		if (liveSent > 0) noteStore.setPresence({ live: null });
		liveStroke = null;
		livePage = null;
		predicted = [];
		drawingPointerId = null;
		lastSampleSkipped = null;
		liveHoldUntil = 0;
		onactive?.(false);
		markDirty();
	}

	/** A second finger while one is inking. Soon after the first, the pair was
	 *  a pinch all along: the young stroke is dropped and the two fingers zoom.
	 *  Later, a stroke keeps going and the extra finger is ignored; an erase or
	 *  laser always gives way. */
	function secondFinger(e: PointerEvent) {
		const first = touchInk;
		const at = touchInkAt;
		if (first === null || !at) return;
		if (first === drawingPointerId) {
			if (performance.now() - inkStartedAt > FINGER_SETTLE_MS) return;
			abortStroke();
		} else if (first === erasePointerId) {
			erasePointerId = null;
			eraseStarted = false;
			eraserCursor = null;
		} else if (first === laserPointerId) {
			laserPointerId = null;
			onactive?.(false);
			laserOff('self');
			noteStore.setPresence({ laser: false });
		}
		touchInk = null;
		touchInkAt = null;
		touches.set(first, at);
		touches.set(e.pointerId, local(e));
		stopGlide();
		beginGesture();
		beginPinch();
		markDirty();
	}

	/** Forget any touches in progress (a palm that landed before the pen). */
	function dropTouches() {
		touches.clear();
		pinchPrev = null;
		lastTouchCentroid = null;
		pinched = false;
	}

	function onPointerDown(e: PointerEvent) {
		measure(); // the canvas can move (banners above it) without resizing
		if (e.pointerType === 'pen') sawPen();
		const finger = e.pointerType === 'touch';
		if (finger) {
			if (touchInk !== null) return secondFinger(e);
			if (isPalm(e)) return; // never tracked, so its moves and lift are ignored too
			// Phones: a lone finger uses the tool, like a pen. Otherwise (and
			// for any further finger, and the hand tool) fingers navigate.
			const inks = fingerInks && mode === 'draw' && tool !== 'hand' && !spaceHeld && touches.size === 0;
			if (!inks) {
				touches.set(e.pointerId, local(e));
				stopGlide();
				if (touches.size === 2) beginPinch();
				else if (touches.size === 1) {
					primeTouchPan();
					beginGesture();
				}
				return;
			}
		}
		// pen, mouse, or an inking finger
		stopGlide();
		const use = useFor(e);
		// A pen touching down with its barrel button held reports the secondary
		// button; its eraser end, button 5. Both are a pen contact, not a
		// right-click — the barrel only when it's been given something to do.
		const pen = e.pointerType === 'pen';
		const contact = e.button === 0 || (pen && e.button === 5) || (pen && e.button === 2 && penButton !== null);
		// Drag to move: the hand tool, Space held, the middle button, or any
		// drag when this session can't draw anyway.
		if (use.tool === 'hand' || spaceHeld || e.button === 1 || mode !== 'draw') {
			if (!contact && e.button !== 1) return;
			e.preventDefault(); // no middle-click autoscroll
			canvas.setPointerCapture(e.pointerId);
			panPointerId = e.pointerId;
			panLast = local(e);
			panning = true;
			beginGesture();
			return;
		}
		if (!contact) return;
		canvas.setPointerCapture(e.pointerId);
		// The pen wins over whatever the hand started a moment ago.
		if (touches.size > 0) {
			dropTouches();
			gestureFrom = null;
		}
		stopTrackMotion();
		inkStartedAt = performance.now();
		if (finger) {
			touchInk = e.pointerId;
			touchInkAt = local(e);
		}
		if (use.tool === 'laser') {
			laserPointerId = e.pointerId;
			onactive?.(true);
			const at = local(e);
			const w = viewport.toWorld(at.x, at.y);
			laserTo('self', w.x, w.y);
			noteStore.setPresence({ laser: true, cursor: w });
			publishCursor(w); // so a pending throttled cursor can't send an older point
			return;
		}
		if (use.tool === 'eraser') {
			erasePointerId = e.pointerId;
			eraseStarted = false;
			eraserCursor = local(e);
			eraseAt(e);
			markDirty();
			return;
		}
		drawingPointerId = e.pointerId;
		onactive?.(true);
		lastSampleSkipped = null;
		// A stroke that starts on a page belongs to it (and is clipped to it).
		const at = local(e);
		const w = viewport.toWorld(at.x, at.y);
		livePage = pageAt(noteStore.pages, w.x, w.y) ?? null;
		liveStroke = {
			id: uid(),
			color: use.color,
			width: use.width,
			points: [samplePoint(e)],
			brush: use.tool === 'marker' || use.tool === 'brush' ? use.tool : 'pen',
			// A mouse has no pressure: let speed shape the line instead.
			sim: e.pointerType !== 'pen',
			// Smoothing works at the zoom it was drawn at (see ink.ts).
			z: strokeZoom(viewport.scale)
		};
		if (livePage) liveStroke.page = livePage.id;
		liveSent = 0;
		predicted = [];
		// A finger stroke might still turn out to be a pinch: show it to the others once it's settled.
		liveHoldUntil = finger ? inkStartedAt + FINGER_SETTLE_MS : 0;
		sendLive();
		markDirty();
	}

	/** What this pointer-down does: the tool, unless it's a pen's eraser end
	 *  or a pen with its barrel button held. Decided once per stroke, so
	 *  letting go of the button mid-stroke changes nothing. */
	function useFor(e: PointerEvent): PenUse {
		if (e.pointerType === 'pen') {
			if (e.button === 5 || e.buttons & 32) return { tool: 'eraser', color, width: strokeWidth };
			if (penButton && (e.button === 2 || e.buttons & 2)) return penButton;
		}
		return { tool, color, width: strokeWidth };
	}

	function onPointerMove(e: PointerEvent) {
		if (e.pointerType === 'pen') sawPen(); // touching or hovering
		if (e.pointerId === touchInk) touchInkAt = local(e);
		if (e.pointerType === 'touch' && !inkPointer(e.pointerId)) {
			if (!touches.has(e.pointerId)) return;
			touches.set(e.pointerId, local(e));
			if (touches.size >= 2) updatePinch();
			else panWithTouch();
			return;
		}
		// Pen/mouse, drawing or hovering: that's our cursor for the others
		// (while drawing it rides along with the live stroke instead).
		const here = local(e);
		if (e.pointerId !== drawingPointerId) publishCursor(viewport.toWorld(here.x, here.y));
		if (e.pointerId === panPointerId && panLast) {
			viewport.panBy(here.x - panLast.x, here.y - panLast.y);
			panLast = here;
			onnavigate?.();
			return;
		}
		if (e.pointerId === laserPointerId) {
			for (const ev of e.getCoalescedEvents?.() ?? [e]) {
				const at = local(ev);
				const w = viewport.toWorld(at.x, at.y);
				laserTo('self', w.x, w.y);
			}
			return;
		}
		if (e.pointerId === erasePointerId) {
			eraserCursor = here;
			const events = e.getCoalescedEvents?.() ?? [e];
			for (const ev of events) eraseAt(ev);
			markDirty();
			return;
		}
		if (e.pointerId !== drawingPointerId || !liveStroke) return;
		// Use coalesced events for high-frequency pen sampling.
		const events = e.getCoalescedEvents?.() ?? [e];
		for (const ev of events) addSample(samplePoint(ev));
		predicted = (e.getPredictedEvents?.() ?? []).slice(0, MAX_PREDICTED).map(samplePoint);
		markDirty();
	}

	function onPointerEnd(e: PointerEvent) {
		onPointerUp(e);
		// A pull that came in mid-gesture waits for the gesture to end.
		if (pendingView && !busy()) {
			const v = pendingView;
			pendingView = null;
			showView(v);
		}
	}

	function onPointerUp(e: PointerEvent) {
		if (e.pointerType === 'pen') sawPen();
		if (e.pointerId === touchInk) {
			touchInk = null;
			touchInkAt = null;
			publishCursor(null); // a finger doesn't hover: once lifted it's nowhere
		}
		if (e.pointerType === 'touch' && !inkPointer(e.pointerId)) {
			if (!touches.delete(e.pointerId)) return; // a palm, or dropped for the pen
			pinchPrev = null;
			if (touches.size === 1) primeTouchPan();
			if (touches.size === 0) {
				// A pan settles onto a page; a pinch is left where it was put.
				if (!pinched) scheduleSnap(0);
				else gestureFrom = null;
				pinched = false;
			}
			return;
		}
		if (e.pointerId === panPointerId) {
			panPointerId = null;
			panLast = null;
			panning = false;
			scheduleSnap(0);
			return;
		}
		if (e.pointerId === laserPointerId) {
			laserPointerId = null;
			onactive?.(false);
			laserOff('self');
			noteStore.setPresence({ laser: false });
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
			// End exactly where the pen lifted, even if that sample was too close to keep.
			if (lastSampleSkipped) liveStroke.points.push(lastSampleSkipped);
			sendLive(); // the last points first, so the preview is whole…
			noteStore.addStroke($state.snapshot(liveStroke) as Stroke);
		}
		// …then the real stroke, then the end of the preview: the others swap
		// one for the other without a blink.
		if (liveTimer) clearTimeout(liveTimer);
		liveTimer = null;
		noteStore.setPresence({ live: null });
		liveStroke = null;
		livePage = null;
		predicted = [];
		drawingPointerId = null;
		lastSampleSkipped = null;
		liveHoldUntil = 0;
		onactive?.(false);
	}

	function onPointerLeave(e: PointerEvent) {
		if (e.pointerType !== 'touch' && e.pointerId !== drawingPointerId) publishCursor(null);
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
			onnavigate?.();
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
		pinched = true;
		pinchPrev = centroidAndDist();
		lastTouchCentroid = null;
	}
	function updatePinch() {
		if (touches.size < 2) return;
		const now = centroidAndDist();
		if (pinchPrev) {
			viewport.panBy(now.cx - pinchPrev.cx, now.cy - pinchPrev.cy);
			if (pinchPrev.dist > 0) viewport.zoomAt(now.cx, now.cy, now.dist / pinchPrev.dist);
			onnavigate?.();
		}
		pinchPrev = now;
	}

	/** Wheel scrolls like any page (Shift: sideways); Ctrl+wheel zooms at the
	 *  cursor — which is also what a trackpad pinch sends. */
	function onWheel(e: WheelEvent) {
		e.preventDefault(); // or Ctrl+wheel zooms the whole browser page
		if (inking()) return; // the view holds still under a stroke
		stopGlide();
		measure();
		// Deltas can come in lines or pages (Firefox, some mice) rather than pixels.
		const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height : 1;
		let dx = e.deltaX * unit;
		let dy = e.deltaY * unit;
		if (e.ctrlKey) {
			const at = local(e);
			// A mouse notch is ~100, a pinch step a few: clamp so a notch is a step.
			viewport.zoomAt(at.x, at.y, Math.exp(-Math.max(-25, Math.min(25, dy)) * 0.01));
			gestureFrom = null; // offsets before and after a zoom don't compare
			onnavigate?.();
			return; // no snapping after a zoom: it stays where it was put
		}
		if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
		beginGesture();
		viewport.panBy(-dx, -dy);
		onnavigate?.();
		scheduleSnap(160); // once the wheel (or trackpad momentum) stops
	}

	// --- Drag to move, and page snapping -----------------------------------

	let panPointerId: number | null = null;
	let panning = $state(false); // for the cursor
	let panLast: { x: number; y: number } | null = null;
	let pinched = false;
	let spaceHeld = $state(false);

	// Space held = hand tool for as long as it's held (as in most drawing apps).
	function onKey(e: KeyboardEvent) {
		if (e.code !== 'Space') return;
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
		if (e.type === 'keydown') {
			e.preventDefault(); // no button activation / page scroll
			spaceHeld = true;
		} else spaceHeld = false;
	}

	let snapTimer: ReturnType<typeof setTimeout> | null = null;
	let glide = 0;
	/** Offset along the page axis where the current scroll/drag began, so the
	 *  snap knows which way it was going. */
	let gestureFrom: number | null = null;

	const axisOffset = () => (noteStore.layout === 'vertical' ? viewport.offset.y : viewport.offset.x);
	function beginGesture() {
		gestureFrom ??= axisOffset();
	}

	function stopGlide() {
		if (snapTimer) clearTimeout(snapTimer);
		snapTimer = null;
		if (glide) cancelAnimationFrame(glide);
		glide = 0;
	}

	function scheduleSnap(delay: number) {
		if (!snap || noteStore.pages.length === 0) {
			gestureFrom = null;
			return;
		}
		if (snapTimer) clearTimeout(snapTimer);
		snapTimer = setTimeout(() => {
			snapTimer = null;
			snapToPage();
		}, delay);
	}

	/** Screen margin a snapped page edge keeps (room for the page label). */
	const SNAP_MARGIN = 32;

	/** Movement (screen px) below which a scroll or drag counts as a nudge and
	 *  settles back, rather than heading for the next page. */
	const SNAP_INTENT = 40;

	/**
	 * Along the axis pages run on, move so a page row starts at the top (left)
	 * of the screen — or, for a row taller than the screen, ends at its bottom
	 * (right). After a real scroll it goes on to the next such edge in the
	 * direction you were going (so one wheel notch = next page); after a nudge,
	 * to the nearest. Rows that fit always snap; inside a taller row it only
	 * snaps near an edge, so you can still read the middle of a big page.
	 */
	function snapToPage() {
		const vertical = noteStore.layout === 'vertical';
		const size = vertical ? height : width;
		const scale = viewport.scale;
		const now = axisOffset();
		const moved = gestureFrom === null ? 0 : now - gestureFrom;
		gestureFrom = null;
		const dir = Math.abs(moved) > SNAP_INTENT ? Math.sign(moved) : 0;
		const rows = new Map<number, number>(); // row start → row end (world)
		for (const p of noteStore.pages) {
			const start = vertical ? p.y : p.x;
			const end = start + (vertical ? p.h : p.w);
			rows.set(start, Math.max(rows.get(start) ?? -Infinity, end));
		}
		const candidates: number[] = [];
		for (const [start, end] of rows) {
			const fits = (end - start) * scale <= size - 2 * SNAP_MARGIN;
			const reach = fits ? Infinity : size * 0.25;
			const targets = [SNAP_MARGIN - start * scale];
			if (!fits) targets.push(size - SNAP_MARGIN - end * scale);
			for (const t of targets) if (Math.abs(t - now) <= reach) candidates.push(t);
		}
		const nearest = (list: number[]) =>
			list.reduce<number | null>((b, t) => (b === null || Math.abs(t - now) < Math.abs(b - now) ? t : b), null);
		// Onward in the direction of travel; at the end of the pages, back to the last edge.
		const ahead = dir === 0 ? [] : candidates.filter((t) => Math.sign(t - now) === dir);
		const best = nearest(ahead.length > 0 ? ahead : candidates);
		if (best === null || Math.abs(best - now) < 0.5) return;
		const to = vertical ? { x: viewport.offset.x, y: best } : { x: best, y: viewport.offset.y };
		glideTo(to);
	}

	// --- Being shown somewhere (the owner's pull) -------------------------------

	let pendingView: { x: number; y: number; w: number; h: number } | null = null;

	/** Is the pen/mouse/fingers in the middle of something? */
	const busy = () =>
		drawingPointerId !== null ||
		erasePointerId !== null ||
		laserPointerId !== null ||
		panPointerId !== null ||
		touches.size > 0;

	/**
	 * Glide to show all of `view` (a world rect, e.g. another session's screen),
	 * centred. Waits if a stroke or gesture is under way: moving the view
	 * under a pen mid-stroke would kink the line.
	 *
	 * The camera never slides: the screen's edges first move outward until both
	 * where we are and where we're going are in sight, then inward onto the
	 * target. Each half is a zoom about one fixed world point (the first inside
	 * the current view, the second inside the target), so whatever you were
	 * looking at stays put while the target comes into view, and the farther
	 * the jump, the farther out the way there goes.
	 */
	export function showView(view: { x: number; y: number; w: number; h: number }) {
		if (width <= 0 || height <= 0) return;
		if (busy()) {
			pendingView = view;
			return;
		}
		stopGlide();
		gestureFrom = null;
		const to = framing({ x0: view.x, y0: view.y, x1: view.x + view.w, y1: view.y + view.h }, width, height);
		const from = viewport.visible(width, height);
		const target = { x: -to.offset.x / to.scale, y: -to.offset.y / to.scale, w: width / to.scale, h: height / to.scale };
		const over = outerView(from, target);
		const out = Math.log(over.w / from.w); // zoom out, in e-folds
		const back = Math.log(over.w / target.w); // zoom in
		const total = out + back;
		if (total < 1e-4 && Math.abs(target.x - from.x) * to.scale < 0.5 && Math.abs(target.y - from.y) * to.scale < 0.5) return;
		const duration = Math.min(PULL_MAX_MS, PULL_MIN_MS + PULL_MS_PER_EFOLD * total);
		// Each half gets its share of the time by how much it zooms (log width),
		// so both run at the same pace. Fast at the start and end, slowing (not
		// stopping) toward the turn: `slowing` is the progress through a half
		// whose speed falls smoothly from full to PULL_TURN_SPEED.
		const split = total < 1e-4 ? 1 : out / total;
		const q = PULL_TURN_SPEED;
		const slowing = (x: number) => (q * x + ((1 - q) * (x + Math.sin(Math.PI * x) / Math.PI)) / 2) / ((1 + q) / 2);
		const speeding = (x: number) => 1 - slowing(1 - x);
		// A move with no turn (one half only) slows in its middle instead.
		const whole = (k: number) => (k < 0.5 ? slowing(2 * k) / 2 : 1 - slowing(2 - 2 * k) / 2);
		const t0 = performance.now();
		const step = (t: number) => {
			const k = Math.min(1, (t - t0) / duration);
			const r =
				total < 1e-4
					? zoomBetween(from, target, whole(k))
					: split >= 1
						? zoomBetween(from, over, whole(k))
						: split <= 0
							? zoomBetween(over, target, whole(k))
							: k < split
								? zoomBetween(from, over, slowing(k / split))
								: zoomBetween(over, target, speeding((k - split) / (1 - split)));
			viewport.scale = width / r.w;
			viewport.offset = { x: -r.x * viewport.scale, y: -r.y * viewport.scale };
			glide = k < 1 ? requestAnimationFrame(step) : 0;
		};
		glide = requestAnimationFrame(step);
	}

	type Rect = { x: number; y: number; w: number; h: number };

	/** The smallest screen-shaped rect holding both `a` and `b` (centred on their union). */
	function outerView(a: Rect, b: Rect): Rect {
		const x0 = Math.min(a.x, b.x);
		const y0 = Math.min(a.y, b.y);
		let w = Math.max(a.x + a.w, b.x + b.w) - x0;
		let h = Math.max(a.y + a.h, b.y + b.h) - y0;
		const cx = x0 + w / 2;
		const cy = y0 + h / 2;
		const aspect = width / height;
		if (w / h < aspect) w = h * aspect;
		else h = w / aspect;
		return { x: cx - w / 2, y: cy - h / 2, w, h };
	}

	/**
	 * Fraction `t` of the way from rect `a` to rect `b` (same shape) as one zoom
	 * about the world point both share on screen: the width changes
	 * geometrically, and each edge moves only one way. Equal sizes (no such
	 * point) degrade to a straight slide.
	 */
	function zoomBetween(a: Rect, b: Rect, t: number): Rect {
		const s = b.w / a.w;
		const f = s ** t;
		// (1 - f) / (1 - s) → t as s → 1; the fixed point's share of the move.
		const g = Math.abs(Math.log(s)) < 1e-6 ? t : (1 - f) / (1 - s);
		return { x: a.x * f + (b.x - s * a.x) * g, y: a.y * f + (b.y - s * a.y) * g, w: a.w * f, h: a.h * f };
	}

	// --- Following something (the whole drawing, another device's view) ------

	/** What the view keeps framed, set by the parent; null = nothing. */
	let track: { box: Box; pad: number; maxScale?: number } | null = null;
	let trackLast = 0;

	/**
	 * Keep `box` (world) framed, easing toward it every frame rather than
	 * jumping or restarting a glide on each change, so a stream of updates
	 * (a growing drawing, someone panning) reads as one smooth camera. Holds
	 * still while a stroke or gesture is under way. null stops following.
	 */
	export function follow(box: Box | null, pad = 0, maxScale?: number) {
		track = box ? { box, pad, maxScale } : null;
		if (track) {
			stopGlide();
			pendingView = null;
		}
		trackLast = 0;
	}

	/** A pen-down keeps the target but restarts the easing clock afterwards. */
	function stopTrackMotion() {
		trackLast = 0;
	}

	function stepTrack(now: number) {
		if (!track || width <= 0 || height <= 0 || glide) return;
		if (busy()) {
			trackLast = 0;
			return;
		}
		const dt = trackLast ? Math.min(now - trackLast, 50) : 16;
		trackLast = now;
		const to = framing(track.box, width, height, track.pad, track.maxScale);
		const s0 = viewport.scale;
		const c0 = { x: (width / 2 - viewport.offset.x) / s0, y: (height / 2 - viewport.offset.y) / s0 };
		const c1 = { x: (width / 2 - to.offset.x) / to.scale, y: (height / 2 - to.offset.y) / to.scale };
		// Close enough (under half a pixel, under 0.1% zoom): stop touching the viewport.
		if (Math.abs(Math.log(to.scale / s0)) < 1e-3 && Math.hypot(c1.x - c0.x, c1.y - c0.y) * s0 < 0.5) return;
		const k = 1 - Math.exp(-dt / TRACK_TAU_MS);
		const scale = s0 * (to.scale / s0) ** k;
		const cx = c0.x + (c1.x - c0.x) * k;
		const cy = c0.y + (c1.y - c0.y) * k;
		viewport.scale = scale;
		viewport.offset = { x: width / 2 - cx * scale, y: height / 2 - cy * scale };
	}

	/** Ease the view to `to` (ease-out cubic). Any input cancels it. */
	function glideTo(to: { x: number; y: number }) {
		if (glide) cancelAnimationFrame(glide);
		const from = { ...viewport.offset };
		const t0 = performance.now();
		const DURATION = 260;
		const step = (t: number) => {
			const k = Math.min(1, (t - t0) / DURATION);
			const e = 1 - (1 - k) ** 3;
			viewport.offset = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
			glide = k < 1 ? requestAnimationFrame(step) : 0;
		};
		glide = requestAnimationFrame(step);
	}
</script>

<svelte:window onkeydown={onKey} onkeyup={onKey} onblur={() => (spaceHeld = false)} />

<div class="surface">
	<canvas
		bind:this={canvas}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerEnd}
		onpointercancel={onPointerEnd}
		onpointerleave={onPointerLeave}
		onauxclick={(e) => e.preventDefault()}
		oncontextmenu={(e) => e.preventDefault()}
		data-cursor={panning ? 'grabbing' : tool === 'hand' || spaceHeld || mode !== 'draw' ? 'grab' : tool}
	></canvas>
	<div class="pills">
		{#each pills as { page, at } (page.id)}
			<div class="pill" style:left="{at.x}px" style:top="{at.y - PILL_HEIGHT - 3}px">
				<span class="n">{String(page.n).padStart(2, '0')}</span>
				{#if pageActions}
					<button
						title={`Add a blank page after page ${page.n} (shown ${noteStore.layout === 'vertical' ? 'to its right' : 'below it'})`}
						onclick={() => noteStore.insertPageAfter(page.id)}
						>+ page {noteStore.layout === 'vertical' ? '→' : '↓'}</button
					>
					<button title={`Delete page ${page.n}`} aria-label={`Delete page ${page.n}`} onclick={() => deletePage(page)}
						>✕</button
					>
				{/if}
			</div>
		{/each}
	</div>
</div>

<style>
	.surface {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
	}
	canvas {
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none; /* we handle all pan/zoom ourselves */
		/* No long-press callout / selection: on Android it can cancel the pointer mid-stroke. */
		-webkit-touch-callout: none;
		-webkit-user-select: none;
		user-select: none;
		cursor: crosshair;
	}
	canvas[data-cursor='grab'] {
		cursor: grab;
	}
	canvas[data-cursor='grabbing'] {
		cursor: grabbing;
	}

	.pills {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}
	.pill {
		position: absolute;
		display: flex;
		align-items: center;
		gap: 0.3rem;
		height: 22px;
		font-family: var(--f-mono);
		font-size: 0.7rem;
		letter-spacing: 0.04em;
		color: var(--graphite);
		pointer-events: auto;
		white-space: nowrap;
	}
	.pill .n {
		min-width: 1.6rem;
		font-variant-numeric: tabular-nums;
	}
	.pill .n::before {
		content: 'P.';
		opacity: 0.55;
	}
	.pill button {
		font: inherit;
		color: var(--ink);
		background: rgb(25 24 20 / 0.06);
		border: 1px solid rgb(25 24 20 / 0.1);
		border-radius: 999px;
		padding: 0.1rem 0.55rem;
		cursor: pointer;
		text-transform: uppercase;
	}
	.pill button:hover {
		background: var(--lime);
		border-color: transparent;
	}
</style>

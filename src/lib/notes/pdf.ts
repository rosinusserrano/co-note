// PDF pages on the canvas, rendered by pdf.js straight from the file's vectors
// at whatever zoom the session is at — never pre-converted to images at a
// fixed resolution, so text stays sharp however far you zoom in.
//
// Each page keeps one bitmap: the whole page when that is affordable at the
// current zoom, otherwise just the visible part (plus a margin). While a new
// one renders, the old one is drawn scaled, so zooming never shows blank pages.
//
// pdf.js (~1 MB with its worker) is loaded on first use, so notes without a
// PDF never pay for it.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PlacedPage } from './pages';
import { CONOTE_FILE, CONOTE_LAYER, readConoteData, type ConoteData } from './conoteData';

type PdfJs = typeof import('pdfjs-dist');
let lib: Promise<PdfJs> | null = null;

function pdfjs(): Promise<PdfJs> {
	lib ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
		([m, worker]) => {
			m.GlobalWorkerOptions.workerSrc = worker.default;
			return m;
		}
	);
	return lib;
}

/** pdf.js takes ownership of (detaches) the buffer it's given; give it a copy. */
const open = async (bytes: Uint8Array) => (await pdfjs()).getDocument({ data: bytes.slice() }).promise;

export interface PdfPageInfo {
	w: number;
	h: number;
	/** Viewport transform at scale 1: PDF user space → page-local (y down). */
	vt: number[];
}

/** A bookmark in the PDF's outline and the pages it spans (0-based,
 *  inclusive): up to the next bookmark at its level or above. */
export interface PdfChapter {
	title: string;
	from: number;
	to: number;
	/** 0: top level, 1: inside one. */
	depth: number;
}

const MAX_CHAPTERS = 300;

/** The outline's first two levels as page spans; [] without an outline. */
async function readChapters(doc: PDFDocumentProxy): Promise<PdfChapter[]> {
	const found: { title: string; page: number; depth: number }[] = [];
	const pageOf = async (dest: string | unknown[] | null) => {
		const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
		const ref = explicit?.[0];
		if (ref == null) return null;
		return typeof ref === 'number' ? ref : await doc.getPageIndex(ref as never);
	};
	type Item = { title: string; dest: string | unknown[] | null; items: Item[] };
	const walk = async (items: Item[], depth: number) => {
		for (const it of items) {
			if (found.length >= MAX_CHAPTERS) return;
			const page = await pageOf(it.dest).catch(() => null);
			if (page !== null && page >= 0 && page < doc.numPages)
				found.push({ title: it.title.replace(/\s+/g, ' ').trim() || `Page ${page + 1}`, page, depth });
			if (depth < 1 && it.items?.length) await walk(it.items, depth + 1);
		}
	};
	try {
		await walk(((await doc.getOutline()) ?? []) as Item[], 0);
	} catch {
		return [];
	}
	return found.map((c, i) => {
		const next = found.slice(i + 1).find((n) => n.depth <= c.depth && n.page > c.page);
		return { title: c.title, from: c.page, to: next ? next.page - 1 : doc.numPages - 1, depth: c.depth };
	});
}

/** Page sizes (rotation and crop box applied) of a PDF, for importing it,
 *  the ink it carries if conote exported it, and its chapters. */
export async function readPdfPages(
	bytes: Uint8Array
): Promise<{ pages: PdfPageInfo[]; conote: ConoteData | null; chapters: PdfChapter[] }> {
	const doc = await open(bytes);
	try {
		const pages: PdfPageInfo[] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
			pages.push({ w: vp.width, h: vp.height, vt: [...vp.transform] });
		}
		let conote: ConoteData | null = null;
		try {
			const files = (await doc.getAttachments()) as Record<string, { filename: string; content: Uint8Array }> | null;
			const file = files && Object.values(files).find((f) => f.filename === CONOTE_FILE);
			if (file) conote = readConoteData(JSON.parse(new TextDecoder().decode(file.content)), pages.length);
		} catch {
			/* unreadable: import it as a plain PDF */
		}
		return { pages, conote, chapters: await readChapters(doc) };
	} finally {
		void doc.destroy();
	}
}

/** Rendering options that hide conote's own ink layer (it's drawn as strokes instead). */
async function withoutConoteInk(doc: PDFDocumentProxy) {
	const config = await doc.getOptionalContentConfig();
	let found = false;
	for (const [id, group] of Object.entries(config.getGroups() ?? {})) {
		if ((group as { name?: string }).name !== CONOTE_LAYER) continue;
		config.setVisibility(id, false);
		found = true;
	}
	return found ? config : null;
}

/** A rendered region of a page: page-local rect, at `scale` device px per unit. */
interface Bitmap {
	canvas: HTMLCanvasElement;
	scale: number;
	rx: number;
	ry: number;
	rw: number;
	rh: number;
}
type Target = Omit<Bitmap, 'canvas'>;

interface PageState {
	bitmap: Bitmap | null;
	busy: boolean;
	want: Target | null;
	timer: ReturnType<typeof setTimeout> | null;
	lastUsed: number;
}

/** A link inside the PDF (a citation, a cross-reference), page-local. */
export interface PdfLink {
	x: number;
	y: number;
	w: number;
	h: number;
	/** Named or explicit destination, as pdf.js gives it. */
	dest: string | unknown[];
}

/** A rendered crop of a link's destination: `w` × `h` in PDF points,
 *  meant to be shown `css` CSS px per point. */
export interface LinkPreview {
	canvas: HTMLCanvasElement;
	w: number;
	h: number;
	css: number;
}

/** Whole-page bitmaps up to this many device pixels (A4 at 200% on a 2× screen). */
const FULL_PAGE_MAX_PX = 8_000_000;
/** All bitmaps together; beyond this, pages out of view lose theirs. */
const TOTAL_MAX_PX = 48_000_000;

export class PageRenderer {
	#getBytes: (hash: string) => Promise<Uint8Array>;
	#onUpdate: () => void;
	#docs = new Map<string, Promise<PDFDocumentProxy | null>>();
	/** Per file: optional content with conote's ink layer off, if it has one. */
	#oc = new Map<string, Promise<Awaited<ReturnType<typeof withoutConoteInk>>>>();
	#pages = new Map<string, PageState>();
	#failed = new Set<string>();
	#destroyed = false;
	/** Per page id: its internal links once read (null while reading). */
	#links = new Map<string, PdfLink[] | null>();
	#previews = new Map<string, Promise<LinkPreview | null>>();

	/** `getBytes` fetches a file by hash; `onUpdate` is called when a better
	 *  bitmap is ready (or a file failed), i.e. when it's worth repainting. */
	constructor(getBytes: (hash: string) => Promise<Uint8Array>, onUpdate: () => void) {
		this.#getBytes = getBytes;
		this.#onUpdate = onUpdate;
	}

	#doc(hash: string) {
		let d = this.#docs.get(hash);
		if (!d) {
			d = this.#getBytes(hash)
				.then(open)
				.catch(() => null);
			this.#docs.set(hash, d);
			// Report a failure so the page can say so instead of staying blank.
			void d.then((doc) => {
				if (doc || this.#destroyed) return;
				this.#failed.add(hash);
				this.#onUpdate();
			});
		}
		return d;
	}

	/** Whether a file failed to load (missing, unreachable, not a PDF). */
	failed(hash: string) {
		return this.#failed.has(hash);
	}

	/**
	 * Paint what we have for `page` (ctx must carry the world transform) and
	 * make sure a sharp enough render is on its way. `visible` is the visible
	 * part of the page in page-local units; `px` is device pixels per unit.
	 * Returns false if there's nothing to show yet.
	 */
	draw(ctx: CanvasRenderingContext2D, page: PlacedPage, visible: { x: number; y: number; w: number; h: number }, px: number): boolean {
		if (!page.pdf) return true;
		let st = this.#pages.get(page.id);
		if (!st) this.#pages.set(page.id, (st = { bitmap: null, busy: false, want: null, timer: null, lastUsed: 0 }));
		st.lastUsed = performance.now();
		const bm = st.bitmap;
		if (bm) ctx.drawImage(bm.canvas, page.x + bm.rx, page.y + bm.ry, bm.rw, bm.rh);
		// A view gone wrong (NaN, an empty page) asks for nothing.
		if (!(px > 0) || !Number.isFinite(px) || ![visible.x, visible.y, visible.w, visible.h].every(Number.isFinite)) return bm !== null;

		const covers =
			bm !== null &&
			bm.rx <= visible.x + 0.5 &&
			bm.ry <= visible.y + 0.5 &&
			bm.rx + bm.rw >= visible.x + visible.w - 0.5 &&
			bm.ry + bm.rh >= visible.y + visible.h - 0.5;
		// Sharp enough: rendered at this zoom, or a little above (zooming out).
		const sharp = bm !== null && bm.scale >= px * 0.98 && bm.scale <= px * 1.6;
		if (covers && sharp) return true;

		let target: Target;
		if (page.w * px * (page.h * px) <= FULL_PAGE_MAX_PX) {
			target = { scale: px, rx: 0, ry: 0, rw: page.w, rh: page.h };
		} else {
			// Too big whole: render what's visible, plus half a screen around it.
			const mx = visible.w / 2;
			const my = visible.h / 2;
			const rx = Math.max(0, visible.x - mx);
			const ry = Math.max(0, visible.y - my);
			target = {
				scale: px,
				rx,
				ry,
				rw: Math.min(page.w, visible.x + visible.w + mx) - rx,
				rh: Math.min(page.h, visible.y + visible.h + my) - ry
			};
		}
		// Nothing usable on screen: render now. Only blurry: wait for the zoom to settle.
		this.#schedule(page, st, target, covers ? 180 : 16);
		return bm !== null;
	}

	#schedule(page: PlacedPage, st: PageState, target: Target, delay: number) {
		st.want = target;
		if (st.timer) clearTimeout(st.timer);
		st.timer = setTimeout(() => {
			st.timer = null;
			if (!st.busy) void this.#render(page, st);
		}, delay);
	}

	async #render(page: PlacedPage, st: PageState) {
		const t = st.want;
		if (!t || !page.pdf || this.#destroyed) return;
		st.want = null;
		st.busy = true;
		try {
			const doc = await this.#doc(page.pdf.file);
			if (!doc || this.#destroyed) return;
			let oc = this.#oc.get(page.pdf.file);
			if (!oc) this.#oc.set(page.pdf.file, (oc = withoutConoteInk(doc).catch(() => null)));
			const config = await oc;
			const pp = await doc.getPage(page.pdf.index + 1);
			const w = Math.ceil(t.rw * t.scale);
			const h = Math.ceil(t.rh * t.scale);
			// A 0×0 canvas makes drawImage throw on every later frame.
			if (!Number.isFinite(w) || !Number.isFinite(h) || ![t.rx, t.ry].every(Number.isFinite)) return;
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, w);
			canvas.height = Math.max(1, h);
			const ctx = canvas.getContext('2d');
			if (!ctx) return;
			await pp.render({
				canvasContext: ctx,
				viewport: pp.getViewport({ scale: t.scale }),
				// Shift so the region's corner lands at the canvas origin.
				transform: [1, 0, 0, 1, -t.rx * t.scale, -t.ry * t.scale],
				...(config ? { optionalContentConfigPromise: Promise.resolve(config) } : {})
			}).promise;
			if (this.#destroyed) return;
			// The canvas was rounded up to whole pixels; keep the mapping exact.
			st.bitmap = { canvas, ...t, rw: canvas.width / t.scale, rh: canvas.height / t.scale };
			this.#evict(page.id);
			this.#onUpdate();
		} catch {
			/* render cancelled or failed; the next frame asks again */
		} finally {
			st.busy = false;
			if (st.want && !st.timer && !this.#destroyed) void this.#render(page, st);
		}
	}

	/**
	 * The page's internal links (citations, references to figures…), or null
	 * while they're being read — `onUpdate` fires once they're in.
	 */
	links(page: PlacedPage): PdfLink[] | null {
		if (!page.pdf) return [];
		if (this.#links.has(page.id)) return this.#links.get(page.id)!;
		this.#links.set(page.id, null);
		const { file, index, vt } = page.pdf;
		void (async () => {
			const out: PdfLink[] = [];
			try {
				const doc = await this.#doc(file);
				const pp = doc && (await doc.getPage(index + 1));
				for (const a of pp ? await pp.getAnnotations({ intent: 'display' }) : []) {
					if (a.subtype !== 'Link' || !a.dest || a.url) continue;
					const [x1, y1, x2, y2] = a.rect as number[];
					const p = apply(vt, x1, y1);
					const q = apply(vt, x2, y2);
					out.push({ x: Math.min(p[0], q[0]), y: Math.min(p[1], q[1]), w: Math.abs(q[0] - p[0]), h: Math.abs(q[1] - p[1]), dest: a.dest });
				}
			} catch {
				/* no links then */
			}
			if (this.#destroyed) return;
			this.#links.set(page.id, out);
			this.#onUpdate();
		})();
		return null;
	}

	/**
	 * Where a link leads, cropped to what's there: the reference entry a
	 * citation points to, say. The crop starts at the destination and takes
	 * in the lines of text below it in that column (found from the page's
	 * text), a few lines deep. Rendered for `css` CSS px per point, or less
	 * if that would be wider than `maxWidth` CSS px.
	 */
	preview(file: string, dest: string | unknown[], css: number, maxWidth: number, dpr: number): Promise<LinkPreview | null> {
		const key = `${file}|${JSON.stringify(dest)}|${css}|${maxWidth}|${dpr}`;
		let p = this.#previews.get(key);
		if (!p) {
			p = this.#preview(file, dest, css, maxWidth, dpr).catch(() => null);
			this.#previews.set(key, p);
		}
		return p;
	}

	async #preview(file: string, dest: string | unknown[], css: number, maxWidth: number, dpr: number): Promise<LinkPreview | null> {
		const doc = await this.#doc(file);
		if (!doc || this.#destroyed) return null;
		const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
		if (!Array.isArray(explicit) || explicit.length < 2) return null;
		const ref = explicit[0];
		const pageIndex = typeof ref === 'number' ? ref : await doc.getPageIndex(ref as never);
		const pp = await doc.getPage(pageIndex + 1);
		const vp = pp.getViewport({ scale: 1 });
		// The destination's point in PDF space (null: that coordinate isn't given).
		const kind = (explicit[1] as { name?: string } | null)?.name;
		const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
		let left: number | null = null;
		let top: number | null = null;
		if (kind === 'XYZ') [left, top] = [num(explicit[2]), num(explicit[3])];
		else if (kind === 'FitH' || kind === 'FitBH') top = num(explicit[2]);
		else if (kind === 'FitR') [left, top] = [num(explicit[2]), num(explicit[5])];
		const [px, py] = vp.convertToViewportPoint(left ?? pp.view[0], top ?? pp.view[3]) as [number, number];

		// The text below the destination: each item's left, baseline, width, height (page-local).
		const items = (await pp.getTextContent()).items
			.filter((it): it is typeof it & { str: string; transform: number[]; width: number; height: number } => 'str' in it && it.str.trim() !== '')
			.map((it) => {
				const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]) as [number, number];
				return { x, y, w: it.width, h: it.height || Math.hypot(it.transform[2], it.transform[3]) };
			});
		const near = items.filter((it) => it.y >= py - 1 && it.y <= py + 60);
		const lineH = near.length ? Math.max(6, median(near.map((it) => it.h)) * 1.2) : 12;
		const below = items.filter((it) => it.y >= py - 1 && it.y <= py + lineH * 4.6);
		// The column: lines starting at the destination's left edge (hanging
		// indents allowed), then whatever continues them to the right.
		let x0 = left === null ? 0 : px - 4;
		let x1 = x0;
		for (const it of below) if (it.x >= x0 && it.x <= px + 40) x1 = Math.max(x1, it.x + it.w);
		for (let grew = true; grew; ) {
			grew = false;
			for (const it of below) {
				if (it.x >= x0 && it.x <= x1 + 6 && it.x + it.w > x1) {
					x1 = it.x + it.w;
					grew = true;
				}
			}
		}
		if (x1 - x0 < 40) x1 = Math.min(vp.width, x0 + 320);
		x0 = Math.max(0, x0);
		x1 = Math.min(vp.width, x1 + 4);
		const y0 = Math.max(0, py - 2);
		let y1 = Math.min(vp.height, py + lineH * 4.6);
		// Entries set with a hanging indent (or a label column): the next line
		// back at the left edge starts the next entry, so stop there.
		if (left !== null) {
			const lines = new Map<number, number>(); // baseline → leftmost x, in this column
			for (const it of below) {
				if (it.x < x0 || it.x > x1) continue;
				const b = Math.round(it.y);
				lines.set(b, Math.min(lines.get(b) ?? Infinity, it.x));
			}
			const rows = [...lines].sort((a, b) => a[0] - b[0]);
			const atEdge = (x: number) => Math.abs(x - rows[0]?.[1]) <= 2;
			if (rows.length > 1 && rows.slice(1).some(([, x]) => !atEdge(x))) {
				const next = rows.slice(1).find(([, x]) => atEdge(x));
				if (next) y1 = Math.min(y1, next[0] - lineH * 0.8);
			}
		}
		const w = x1 - x0;
		const h = y1 - y0;
		if (w <= 0 || h <= 0) return null;

		css = Math.min(css, maxWidth / w);
		const scale = css * dpr;
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.ceil(w * scale));
		canvas.height = Math.max(1, Math.ceil(h * scale));
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		let oc = this.#oc.get(file);
		if (!oc) this.#oc.set(file, (oc = withoutConoteInk(doc).catch(() => null)));
		const config = await oc;
		await pp.render({
			canvasContext: ctx,
			viewport: pp.getViewport({ scale }),
			transform: [1, 0, 0, 1, -x0 * scale, -y0 * scale],
			...(config ? { optionalContentConfigPromise: Promise.resolve(config) } : {})
		}).promise;
		return { canvas, w, h, css };
	}

	/** Over budget: drop the bitmaps used longest ago, never `keep`'s. */
	#evict(keep: string) {
		const px = (b: Bitmap) => b.canvas.width * b.canvas.height;
		let total = 0;
		for (const st of this.#pages.values()) if (st.bitmap) total += px(st.bitmap);
		if (total <= TOTAL_MAX_PX) return;
		const old = [...this.#pages.entries()]
			.filter(([id, st]) => st.bitmap && id !== keep)
			.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		for (const [, st] of old) {
			if (total <= TOTAL_MAX_PX) break;
			total -= px(st.bitmap!);
			st.bitmap = null;
		}
	}

	destroy() {
		this.#destroyed = true;
		for (const st of this.#pages.values()) if (st.timer) clearTimeout(st.timer);
		this.#pages.clear();
		this.#links.clear();
		this.#previews.clear();
		for (const d of this.#docs.values()) void d.then((doc) => doc?.destroy());
		this.#docs.clear();
	}
}

const apply = (m: number[], x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function median(v: number[]) {
	const s = [...v].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

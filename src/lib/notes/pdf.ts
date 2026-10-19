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

/** Page sizes (rotation and crop box applied) of a PDF, for importing it,
 *  and the ink it carries if conote exported it. */
export async function readPdfPages(bytes: Uint8Array): Promise<{ pages: PdfPageInfo[]; conote: ConoteData | null }> {
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
		return { pages, conote };
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
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.ceil(t.rw * t.scale));
			canvas.height = Math.max(1, Math.ceil(t.rh * t.scale));
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
		for (const d of this.#docs.values()) void d.then((doc) => doc?.destroy());
		this.#docs.clear();
	}
}

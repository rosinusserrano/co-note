// Export a note as a PDF: the imported pages themselves (copied, not
// re-rendered, so they keep their original quality), blank pages where pages
// were added, and the ink on top as vector paths. Ink is page-local, so on each
// page it's drawn through one transform: page-local → that page's PDF space.
//
// A note without pages exports its free ink on one page framing it. Free ink
// in a note that has pages (drawn beside them) isn't on any page, so it isn't
// exported.
//
// pdf-lib is loaded on first use.

import type { PDFDocument, PDFPage, PDFOperator } from 'pdf-lib';
import type { PageEntry, Stroke } from './model';
import { inkShape, hexToRgb, isMarker, MARKER_ALPHA, type InkRun } from './ink';

type Mat = [number, number, number, number, number, number];

/** Inverse of an affine [a b c d e f] (x' = a·x + c·y + e, y' = b·x + d·y + f). */
function invert([a, b, c, d, e, f]: number[]): Mat {
	const det = a * d - b * c;
	return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

const MARGIN = 24;

export async function exportPdf(
	pages: PageEntry[],
	strokes: Stroke[],
	getFile: (hash: string) => Promise<Uint8Array>
): Promise<Uint8Array> {
	const lib = await import('pdf-lib');
	const out = await lib.PDFDocument.create();
	out.setProducer('conote');

	const onPage = new Map<string, Stroke[]>();
	for (const s of strokes) {
		const key = s.page ?? '';
		let list = onPage.get(key);
		if (!list) onPage.set(key, (list = []));
		list.push(s);
	}

	if (pages.length === 0) {
		const free = onPage.get('') ?? [];
		const b = bounds(free);
		if (!b) {
			out.addPage(); // nothing drawn: one empty page rather than an invalid PDF
		} else {
			const w = b.x1 - b.x0 + 2 * MARGIN;
			const h = b.y1 - b.y0 + 2 * MARGIN;
			const page = out.addPage([w, h]);
			drawInk(lib, page, free, [1, 0, 0, -1, MARGIN - b.x0, h - MARGIN + b.y0]);
		}
		return out.save();
	}

	// Copy each source file's pages in one go, so resources they share (fonts,
	// images) are copied once rather than once per page.
	const wanted = new Map<string, number[]>();
	for (const p of pages) if (p.pdf) wanted.set(p.pdf.file, [...(wanted.get(p.pdf.file) ?? []), p.pdf.index]);
	const copied = new Map<string, PDFPage[]>();
	for (const [file, indices] of wanted) {
		const src: PDFDocument = await lib.PDFDocument.load(await getFile(file), { ignoreEncryption: true });
		copied.set(file, await out.copyPages(src, indices));
	}

	for (const p of pages) {
		let page: PDFPage;
		let m: Mat;
		if (p.pdf) {
			page = out.addPage(copied.get(p.pdf.file)!.shift()!);
			m = invert(p.pdf.vt);
		} else {
			page = out.addPage([p.w, p.h]);
			m = [1, 0, 0, -1, 0, p.h]; // page-local is y-down from the top-left
		}
		drawInk(lib, page, onPage.get(p.id) ?? [], m);
	}
	return out.save();
}

function bounds(strokes: Stroke[]) {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const s of strokes) {
		const r = s.width / 2;
		for (const p of s.points) {
			x0 = Math.min(x0, p.x - r);
			y0 = Math.min(y0, p.y - r);
			x1 = Math.max(x1, p.x + r);
			y1 = Math.max(y1, p.y + r);
		}
	}
	return x0 <= x1 ? { x0, y0, x1, y1 } : null;
}

/** Bézier circle constant. */
const K = 0.5522847498;

function drawInk(lib: typeof import('pdf-lib'), page: PDFPage, strokes: Stroke[], m: Mat) {
	if (strokes.length === 0) return;
	const {
		pushGraphicsState,
		popGraphicsState,
		concatTransformationMatrix,
		setGraphicsState,
		setLineCap,
		setLineJoin,
		LineCapStyle,
		LineJoinStyle,
		setStrokingRgbColor,
		setFillingRgbColor,
		setLineWidth,
		moveTo,
		lineTo,
		appendBezierCurve,
		closePath,
		stroke,
		fill
	} = lib;

	/** A smoothed path: quadratics raised to cubics exactly (PDF has no
	 *  quadratic curves, and pdf-lib's appendQuadraticCurve emits `v`, which is
	 *  a different curve). */
	const path = (run: InkRun) => {
		ops.push(moveTo(run.x, run.y));
		let px = run.x;
		let py = run.y;
		for (const seg of run.segs) {
			if (seg.q) {
				ops.push(
					appendBezierCurve(
						px + (2 / 3) * (seg.cx - px),
						py + (2 / 3) * (seg.cy - py),
						seg.x + (2 / 3) * (seg.cx - seg.x),
						seg.y + (2 / 3) * (seg.cy - seg.y),
						seg.x,
						seg.y
					)
				);
			} else {
				ops.push(lineTo(seg.x, seg.y));
			}
			px = seg.x;
			py = seg.y;
		}
	};

	const draw = (s: Stroke) => {
		const [r, g, b] = hexToRgb(s.color);
		const shape = inkShape(s);
		if (shape.kind === 'fill') {
			if (!shape.path) return;
			ops.push(setFillingRgbColor(r, g, b));
			path(shape.path);
			ops.push(closePath(), fill());
			return;
		}
		if (shape.dot) {
			const { x, y, r: rad } = shape.dot;
			const k = rad * K;
			ops.push(
				setFillingRgbColor(r, g, b),
				moveTo(x + rad, y),
				appendBezierCurve(x + rad, y + k, x + k, y + rad, x, y + rad),
				appendBezierCurve(x - k, y + rad, x - rad, y + k, x - rad, y),
				appendBezierCurve(x - rad, y - k, x - k, y - rad, x, y - rad),
				appendBezierCurve(x + k, y - rad, x + rad, y - k, x + rad, y),
				closePath(),
				fill()
			);
			return;
		}
		ops.push(setStrokingRgbColor(r, g, b));
		for (const run of shape.runs) {
			ops.push(setLineWidth(run.width));
			path(run);
			ops.push(stroke());
		}
	};

	const ops: PDFOperator[] = [
		pushGraphicsState(),
		concatTransformationMatrix(...m),
		setLineCap(LineCapStyle.Round),
		setLineJoin(LineJoinStyle.Round)
	];

	// Markers first, under the rest, translucent and multiplied — as on screen.
	const marked = strokes.filter(isMarker);
	if (marked.length > 0) {
		const ctx = page.doc.context;
		const gs = ctx.register(ctx.obj({ Type: 'ExtGState', ca: MARKER_ALPHA, CA: MARKER_ALPHA, BM: 'Multiply' }));
		ops.push(pushGraphicsState(), setGraphicsState(page.node.newExtGState('GS', gs)));
		marked.forEach(draw);
		ops.push(popGraphicsState());
	}
	strokes.filter((s) => !isMarker(s)).forEach(draw);

	ops.push(popGraphicsState());
	// Spread in chunks: a big drawing is far more operators than a call can take.
	for (let i = 0; i < ops.length; i += 5000) page.pushOperators(...ops.slice(i, i + 5000));
}

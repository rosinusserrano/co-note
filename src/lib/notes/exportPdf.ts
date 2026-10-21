// Export a note as a PDF: the imported pages themselves (copied, not
// re-rendered, so they keep their original quality), blank pages where pages
// were added, and the ink on top as vector paths. Ink is page-local, so on each
// page it's drawn through one transform: page-local → that page's PDF space.
//
// Text boxes go into the same ink stream, in Helvetica (a standard font, so
// nothing is embedded; the canvas uses Arimo, which has the same widths).
// Characters Helvetica can't encode (outside Latin-1, roughly) become "?" in
// the drawn text; conote.json keeps them as typed.
//
// A note without pages exports its free ink on one page framing it. Free ink
// in a note that has pages (drawn beside them) isn't on any page, so it isn't
// exported.
//
// The PDF also carries the ink as conote data (`conote.json`, an embedded
// file, see ConoteData), so opening it in conote again — on any device, or
// after a trip through Zotero — brings the ink back as strokes you can keep
// editing, not as part of the page. For that the drawn ink sits in its own
// content stream (marked `/ConoteInk true`) inside an optional-content layer
// "conote ink": conote hides that layer when it renders such a page, and an
// export strips those streams from copied pages before drawing the ink anew.
// Other PDF viewers just show the ink.
//
// pdf-lib is loaded on first use.

import type { PDFDocument, PDFFont, PDFPage, PDFOperator, PDFRef } from 'pdf-lib';
import type { PageEntry, PageLayout, Stroke, TextBox } from './model';
import { TEXT_ASCENT, TEXT_LINE, textBounds, textLines } from './text';
import { inkShape, hexToRgb, isMarker, MARKER_ALPHA, type InkRun } from './ink';
import { CONOTE_FILE, CONOTE_LAYER, type ConoteData } from './conoteData';

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
	texts: TextBox[],
	getFile: (hash: string) => Promise<Uint8Array>,
	layout: PageLayout = 'vertical'
): Promise<Uint8Array> {
	const lib = await import('pdf-lib');
	const out = await lib.PDFDocument.create();
	out.setProducer('conote');
	const ctx = out.context;
	const { PDFName, PDFHexString, PDFArray, PDFStream } = lib;

	// The layer the ink is drawn in (see the header).
	const layer = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFHexString.fromText(CONOTE_LAYER) }));
	out.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [layer], D: { Order: [layer] } }));

	/** The ink again, as data: per page in export order. */
	const data: ConoteData = { v: 1, layout, pages: [], strokes: [], texts: [] };
	const keepText = (t: TextBox, page: number, dx = 0, dy = 0) =>
		data.texts.push({ x: round(t.x + dx, 100), y: round(t.y + dy, 100), text: t.text, size: t.size, color: t.color, page });
	// Loaded only if there is text.
	let font: PDFFont | null = null;
	if (texts.length > 0) font = await out.embedFont(lib.StandardFonts.Helvetica);
	const keep = (s: Stroke, page: number, dx = 0, dy = 0) =>
		data.strokes.push({
			color: s.color,
			width: s.width,
			...(s.brush ? { brush: s.brush } : {}),
			...(s.sim ? { sim: true } : {}),
			...(s.z ? { z: s.z } : {}),
			page,
			points: s.points.map((p) => ({ x: round(p.x + dx, 100), y: round(p.y + dy, 100), pressure: round(p.pressure, 1000) }))
		});
	const finish = async () => {
		await out.attach(new TextEncoder().encode(JSON.stringify(data)), CONOTE_FILE, {
			mimeType: 'application/json',
			description: 'The ink, for opening this PDF in conote and drawing on'
		});
		return out.save();
	};

	const onPage = new Map<string, Stroke[]>();
	for (const s of strokes) {
		const key = s.page ?? '';
		let list = onPage.get(key);
		if (!list) onPage.set(key, (list = []));
		list.push(s);
	}
	const textOn = new Map<string, TextBox[]>();
	for (const t of texts) {
		const key = t.page ?? '';
		let list = textOn.get(key);
		if (!list) textOn.set(key, (list = []));
		list.push(t);
	}

	if (pages.length === 0) {
		const free = onPage.get('') ?? [];
		const freeText = textOn.get('') ?? [];
		const b = bounds(free, freeText);
		if (!b) {
			out.addPage(); // nothing drawn: one empty page rather than an invalid PDF
		} else {
			const w = b.x1 - b.x0 + 2 * MARGIN;
			const h = b.y1 - b.y0 + 2 * MARGIN;
			const page = out.addPage([w, h]);
			drawInk(lib, page, free, freeText, font, [1, 0, 0, -1, MARGIN - b.x0, h - MARGIN + b.y0], layer);
			// Reopened, it's ink on this page: page-local, from its top-left.
			data.pages.push({ extra: false });
			for (const s of free) keep(s, 0, MARGIN - b.x0, MARGIN - b.y0);
			for (const t of freeText) keepText(t, 0, MARGIN - b.x0, MARGIN - b.y0);
		}
		return finish();
	}

	// Copy each source file's pages in one go, so resources they share (fonts,
	// images) are copied once rather than once per page.
	const wanted = new Map<string, number[]>();
	for (const p of pages) if (p.pdf) wanted.set(p.pdf.file, [...(wanted.get(p.pdf.file) ?? []), p.pdf.index]);
	const copied = new Map<string, PDFPage[]>();
	for (const [file, indices] of wanted) {
		const src: PDFDocument = await lib.PDFDocument.load(await getFile(file), { ignoreEncryption: true });
		const list = await out.copyPages(src, indices);
		// A page from an earlier conote export: its old ink comes back as
		// strokes, so the drawn copy of it goes.
		for (const page of list) {
			const contents = page.node.Contents();
			if (!(contents instanceof PDFArray)) continue;
			for (let i = contents.size() - 1; i >= 0; i--) {
				const stream = ctx.lookup(contents.get(i));
				if (stream instanceof PDFStream && stream.dict.get(PDFName.of(INK_MARK))) contents.remove(i);
			}
		}
		copied.set(file, list);
	}

	for (const [index, p] of pages.entries()) {
		let page: PDFPage;
		let m: Mat;
		if (p.pdf) {
			page = out.addPage(copied.get(p.pdf.file)!.shift()!);
			m = invert(p.pdf.vt);
		} else {
			page = out.addPage([p.w, p.h]);
			m = [1, 0, 0, -1, 0, p.h]; // page-local is y-down from the top-left
		}
		drawInk(lib, page, onPage.get(p.id) ?? [], textOn.get(p.id) ?? [], font, m, layer);
		data.pages.push({ extra: p.extra });
		for (const s of onPage.get(p.id) ?? []) keep(s, index);
		for (const t of textOn.get(p.id) ?? []) keepText(t, index);
	}
	return finish();
}

const round = (v: number, k: number) => Math.round(v * k) / k;

/** The key that marks a content stream as conote's ink. */
const INK_MARK = 'ConoteInk';

function bounds(strokes: Stroke[], texts: TextBox[]) {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const t of texts) {
		const b = textBounds(t);
		x0 = Math.min(x0, b.x);
		y0 = Math.min(y0, b.y);
		x1 = Math.max(x1, b.x + b.w);
		y1 = Math.max(y1, b.y + b.h);
	}
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

function drawInk(
	lib: typeof import('pdf-lib'),
	page: PDFPage,
	strokes: Stroke[],
	texts: TextBox[],
	font: PDFFont | null,
	m: Mat,
	layer: PDFRef
) {
	if (strokes.length === 0 && texts.length === 0) return;
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
		fill,
		beginText,
		endText,
		setFontAndSize,
		setTextMatrix,
		showText
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

	// The page's name for the layer, for the marked-content operator below.
	const ctx = page.doc.context;
	const { PDFName, PDFDict, PDFOperator: Op } = lib;
	const { Resources } = page.node.normalizedEntries();
	let props = Resources.lookupMaybe(PDFName.of('Properties'), PDFDict);
	if (!props) Resources.set(PDFName.of('Properties'), (props = ctx.obj({})));
	props.set(PDFName.of(INK_MARK), layer);

	const ops: PDFOperator[] = [
		Op.of('BDC' as never, [PDFName.of('OC'), PDFName.of(INK_MARK)]),
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

	// Text on top. The transform above flips y (page-local runs down), so each
	// line's text matrix flips it back.
	if (font && texts.length > 0) {
		const key = page.node.newFontDictionary(font.name, font.ref);
		const known = new Set(font.getCharacterSet());
		const safe = (line: string) => [...line].map((ch) => (known.has(ch.codePointAt(0)!) ? ch : '?')).join('');
		for (const t of texts) {
			const [r, g, b] = hexToRgb(t.color);
			ops.push(beginText(), setFillingRgbColor(r, g, b), setFontAndSize(key, t.size));
			textLines(t).forEach((line, i) => {
				if (!line) return;
				ops.push(setTextMatrix(1, 0, 0, -1, t.x, t.y + t.size * (TEXT_ASCENT + i * TEXT_LINE)), showText(font.encodeText(safe(line))));
			});
			ops.push(endText());
		}
	}

	ops.push(popGraphicsState(), Op.of('EMC' as never));
	// A stream of its own, marked, after the page's own content (normalize
	// wraps that in q/Q first, so its leftover state can't touch the ink).
	page.node.addContentStream(ctx.register(ctx.contentStream(ops, { [INK_MARK]: true })));
}

<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { fly, scale } from 'svelte/transition';
	import DrawingCanvas from './DrawingCanvas.svelte';
	import NoteSettings from './NoteSettings.svelte';
	import Icon, { type IconName } from './Icon.svelte';
	import ZoteroConnect from './ZoteroConnect.svelte';
	import { noteStore, destroyNoteData } from '$lib/notes/noteStore.svelte';
	import { noteIndex, myName, isOwner, type NoteEntry } from '$lib/notes/noteIndex.svelte';
	import { account } from '$lib/notes/account.svelte';
	import {
		joinNote,
		ownerSession,
		claimNote,
		zoteroVerify,
		zoteroSearch,
		zoteroPdfs,
		zoteroFile,
		zoteroSave,
		ApiError,
		type NoteSession,
		type ZoteroItem,
		type ZoteroPdf
	} from '$lib/notes/api';
	import { zotero } from '$lib/notes/zotero.svelte';
	import { appUpdate } from '$lib/appUpdate.svelte';
	import { Viewport, MAX_FIT_SCALE } from '$lib/notes/viewport.svelte';
	import { PAGE_GAP } from '$lib/notes/pages';
	import { BRUSHES, MARKER_ALPHA } from '$lib/notes/ink';
	import { TEXT_FONT, TEXT_SIZE } from '$lib/notes/text';
	import type { Brush } from '$lib/notes/model';
	import {
		Bars,
		ANCHORS,
		ANCHOR_NAMES,
		BAR_NAMES,
		isColumn,
		isCorner,
		fits,
		type Anchor,
		type BarId
	} from './bars.svelte';

	interface Props {
		entry: NoteEntry;
		onleave: () => void;
	}
	let { entry, onleave }: Props = $props();

	// One viewport per session — this is what stays independent across devices.
	// The parent remounts this component per note, so a note never inherits
	// another note's zoom.
	const viewport = new Viewport();

	// White last: on white paper it's for covering things up on a PDF page.
	const palette = ['#191814', '#6b665c', '#e5484d', '#f07a2b', '#f2c230', '#2f9e5b', '#2f6fed', '#7c5cff', '#ffffff'];
	// Each ink type (the brushes, and text) keeps its own colour and size; the
	// palette and slider edit the current one (the last one used, while the
	// eraser, laser or hand is active). For text the size is the font size.
	type Ink = Brush | 'text';
	const INKS: Record<Ink, { label: string; size: number; min: number; max: number }> = {
		...BRUSHES,
		text: { label: 'Text', ...TEXT_SIZE }
	};
	let inks = $state<Record<Ink, { color: string; width: number }>>({
		pen: { color: '#191814', width: BRUSHES.pen.size },
		brush: { color: '#191814', width: BRUSHES.brush.size },
		marker: { color: '#f2c230', width: BRUSHES.marker.size },
		text: { color: '#191814', width: TEXT_SIZE.size }
	});
	/** The current ink type. */
	let brush = $state<Ink>('pen');
	const color = $derived(inks[brush].color);
	const strokeWidth = $derived(inks[brush].width);

	type Tool = Ink | 'eraser' | 'laser' | 'hand';
	const TOOLS: { id: Tool; icon: IconName; label: string; key: string; hint?: string }[] = [
		{ id: 'pen', icon: 'pen', label: 'Pen', key: 'P' },
		{ id: 'brush', icon: 'brush', label: 'Brush', key: 'B' },
		{ id: 'marker', icon: 'marker', label: 'Marker', key: 'M' },
		{ id: 'text', icon: 'text', label: 'Text', key: 'T', hint: 'tap to type, tap a text to change it' },
		{ id: 'eraser', icon: 'eraser', label: 'Eraser', key: 'E' },
		{ id: 'laser', icon: 'laser', label: 'Laser', key: 'L', hint: 'hold to point, everyone sees a fading trail' },
		{ id: 'hand', icon: 'hand', label: 'Hand', key: 'H', hint: 'drag to move around (or hold Space)' }
	];

	// Saved inks: a brush with its colour and size, one tap away (per device).
	const PRESETS_KEY = 'conote:presets';
	const MAX_PRESETS = 6;
	type Preset = { brush: Ink; color: string; width: number };
	const validPreset = (p: unknown): p is Preset => {
		const q = p as Preset;
		return (
			!!q &&
			typeof q === 'object' &&
			Object.hasOwn(INKS, q.brush) &&
			typeof q.color === 'string' &&
			/^#[0-9a-f]{6}$/i.test(q.color) &&
			typeof q.width === 'number' &&
			q.width >= INKS[q.brush].min &&
			q.width <= INKS[q.brush].max
		);
	};
	let presets = $state<Preset[]>(
		(() => {
			try {
				const v = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]');
				return Array.isArray(v) ? v.filter(validPreset).slice(0, MAX_PRESETS) : [];
			} catch {
				return [];
			}
		})()
	);
	const isCurrent = (p: Preset) => isBrush(tool) && p.brush === brush && p.color === color && p.width === strokeWidth;
	const presetSaved = $derived(presets.some((p) => p.brush === brush && p.color === color && p.width === strokeWidth));
	function savePresets() {
		writeLocal(PRESETS_KEY, JSON.stringify(presets));
	}
	function addPreset() {
		if (presetSaved || presets.length >= MAX_PRESETS) return;
		presets.push({ brush, color, width: strokeWidth });
		savePresets();
	}
	function removePreset(i: number) {
		presets.splice(i, 1);
		savePresets();
	}
	function usePreset(p: Preset) {
		inks[p.brush] = { color: p.color, width: p.width };
		pickTool(p.brush);
	}
	/** A preset's icon grows with its thickness, within its brush's range. */
	const presetSize = (p: Preset) => {
		const b = INKS[p.brush];
		return Math.round(12 + (10 * (p.width - b.min)) / (b.max - b.min));
	};

	function pickColor(c: string) {
		inks[brush].color = c;
		if (!isBrush(tool)) tool = brush; // picking a colour means "draw with it"
	}
	/** A tool that puts something down in the current ink. */
	const isBrush = (t: Tool): t is Ink => t === 'pen' || t === 'brush' || t === 'marker' || t === 'text';
	function pickTool(t: Tool) {
		if (isBrush(t)) brush = t;
		tool = t;
	}
	let mode = $state<'draw' | 'observe'>('draw');
	let tool = $state<Tool>('pen');

	// The canvas's size (bound from DrawingCanvas): the screen the viewport maps onto.
	let canvasWidth = $state(0);
	let canvasHeight = $state(0);

	const canEdit = $derived(entry.role === 'edit');
	/** Owner rights: this device holds the key, or the note is in our account. */
	const owner = $derived(isOwner(entry));

	/** Which floating panel is open. One at a time; a tap elsewhere closes it. */
	let pop = $state<'' | 'people' | 'share' | 'more' | 'ink' | 'keep' | 'zotero'>('');
	/** The button that opened the panel, and where its bar sits: panels hang
	 *  off it toward the middle of the screen, wherever the bar was put. */
	let popFrom = $state<{ r: DOMRect; g: DOMRect; a: Anchor } | null>(null);
	function toggle(p: typeof pop, e?: MouseEvent) {
		const el = e?.currentTarget as HTMLElement | undefined;
		const group = el?.closest<HTMLElement>('[data-anchor]');
		if (el && group) {
			popFrom = { r: el.getBoundingClientRect(), g: group.getBoundingClientRect(), a: group.dataset.anchor as Anchor };
		}
		pop = pop === p ? '' : p;
	}
	let showSettings = $state(false);
	let showOthers = $state(true);

	/** What this session's view keeps framed by itself: the whole drawing as
	 *  it grows (the laptop-in-a-call view), another device's view (by its
	 *  presence id), or nothing. Panning or zooming by hand turns it off. */
	type Follow = null | 'drawing' | number;
	let follow = $state<Follow>(null);

	/** The pen is down (stroke or laser): the chrome steps back. */
	let inking = $state(false);

	/** Glide to the nearest page edge when scrolling stops. Per device, remembered. */
	const SNAP_KEY = 'conote:snap';
	let snap = $state(readSnap());
	function readSnap() {
		try {
			return localStorage.getItem(SNAP_KEY) === '1';
		} catch {
			return false;
		}
	}
	function toggleSnap() {
		snap = !snap;
		try {
			localStorage.setItem(SNAP_KEY, snap ? '1' : '0');
		} catch {
			/* not remembered, still on for this session */
		}
	}

	// --- Fingers: draw (phones) or move the view (tablets with a pen) ----------

	/** Per device, remembered. Unset = automatic: fingers draw until a pen
	 *  shows up on this device, then they move the view. */
	const FINGER_KEY = 'conote:finger';
	const PEN_KEY = 'conote:pen';
	let fingerPref = $state<'draw' | 'move' | null>(readLocal(FINGER_KEY) as 'draw' | 'move' | null);
	let penSeen = $state(readLocal(PEN_KEY) === '1');
	const fingerInks = $derived(fingerPref ? fingerPref === 'draw' : !penSeen);
	/** Brief notice when a pen just took over drawing from fingers. */
	let penNotice = $state(false);

	function readLocal(key: string) {
		try {
			const v = localStorage.getItem(key);
			return v === 'draw' || v === 'move' || v === '1' ? v : null;
		} catch {
			return null;
		}
	}
	function writeLocal(key: string, value: string) {
		try {
			localStorage.setItem(key, value);
		} catch {
			/* not remembered, still applies for this session */
		}
	}

	function onPen() {
		if (penSeen) return;
		const wasDrawing = fingerInks;
		penSeen = true;
		writeLocal(PEN_KEY, '1');
		if (wasDrawing && !fingerPref) {
			penNotice = true;
			setTimeout(() => (penNotice = false), 5000);
		}
	}

	// --- The pen's barrel button: a tool for as long as it's held ------------

	const PEN_BUTTON_KEY = 'conote:penButton';
	const PEN_BUTTON = [
		{ id: 'eraser', icon: 'eraser', label: 'Eraser' },
		{ id: 'marker', icon: 'marker', label: 'Marker' },
		{ id: 'laser', icon: 'laser', label: 'Laser' },
		{ id: 'hand', icon: 'hand', label: 'Hand (move)' },
		{ id: 'off', icon: 'x', label: 'Nothing' }
	] as const satisfies readonly { id: Tool | 'off'; icon: IconName; label: string }[];
	type PenButton = (typeof PEN_BUTTON)[number]['id'];
	/** Per device, remembered; erasing is what most pens' button means elsewhere. */
	let penButton = $state<PenButton>(
		(() => {
			try {
				const v = localStorage.getItem(PEN_BUTTON_KEY);
				return PEN_BUTTON.some((b) => b.id === v) ? (v as PenButton) : 'eraser';
			} catch {
				return 'eraser';
			}
		})()
	);
	/** The marker keeps its own colour and size; the rest don't draw. */
	const penButtonUse = $derived(
		penButton === 'off' ? null : { tool: penButton, color: inks.marker.color, width: inks.marker.width }
	);
	function setPenButton(b: PenButton) {
		penButton = b;
		writeLocal(PEN_BUTTON_KEY, b);
	}

	function toggleFinger() {
		fingerPref = fingerInks ? 'move' : 'draw';
		writeLocal(FINGER_KEY, fingerPref);
		penNotice = false;
	}

	// --- Focus: nothing but the note, for devices that watch ---------------------

	/** No chrome, no ink, the view following something. Observers start here. */
	let focus = $state(untrack(() => entry.role !== 'edit'));
	if (untrack(() => focus)) follow = 'drawing';

	// --- Updates: reload into a new version at a quiet moment, and come back here ---

	const RESUME_KEY = 'conote:resume';
	type Resume = { id: string; at: number; scale: number; x: number; y: number; focus: boolean; follow: 'drawing' | null; tool: Tool; brush: Ink };
	(() => {
		let r: Resume | null = null;
		try {
			r = JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? 'null');
			sessionStorage.removeItem(RESUME_KEY);
		} catch {
			/* nothing to resume */
		}
		if (!r || r.id !== untrack(() => entry.id) || Date.now() - r.at > 120_000) return;
		viewport.scale = r.scale;
		viewport.offset = { x: r.x, y: r.y };
		focus = r.focus;
		follow = r.follow;
		if (TOOLS.some((t) => t.id === r.tool)) tool = r.tool;
		if (r.brush in inks) brush = r.brush;
	})();
	onMount(() => {
		const unblock = appUpdate.block(
			() => inking || pdfBusy !== '' || showSettings || customizing || pop === 'keep' || pop === 'zotero'
		);
		const unsave = appUpdate.beforeReload(() => {
			const r: Resume = {
				id: entry.id,
				at: Date.now(),
				scale: viewport.scale,
				x: viewport.offset.x,
				y: viewport.offset.y,
				focus,
				// A followed device has a new id after the reload; the whole note doesn't.
				follow: follow === 'drawing' ? 'drawing' : null,
				tool,
				brush
			};
			sessionStorage.setItem(RESUME_KEY, JSON.stringify(r));
		});
		return () => {
			unblock();
			unsave();
		};
	});
	/** The little bar at the bottom of focus mode, shown for a while after any movement. */
	let focusBar = $state(true);
	let focusBarTimer: ReturnType<typeof setTimeout> | undefined;
	let overFocusBar = false;
	/** Fullscreen that focus mode asked for (so leaving one leaves the other). */
	let fullscreenByFocus = false;

	function revealFocusBar() {
		focusBar = true;
		clearTimeout(focusBarTimer);
		if (!overFocusBar) focusBarTimer = setTimeout(() => (focusBar = false), 2600);
	}

	function setFocus(on: boolean) {
		if (on === focus) return;
		focus = on;
		pop = '';
		if (on) {
			follow ??= 'drawing';
			revealFocusBar();
			const el = document.documentElement;
			if (!document.fullscreenElement && el.requestFullscreen) {
				el.requestFullscreen()
					.then(() => (fullscreenByFocus = true))
					.catch(() => {
						/* not allowed here (iOS, iframe): focus without it */
					});
			}
		} else {
			clearTimeout(focusBarTimer);
			if (fullscreenByFocus && document.fullscreenElement) document.exitFullscreen().catch(() => {});
			fullscreenByFocus = false;
		}
	}

	function onFullscreenChange() {
		// Esc (or the system) ended the fullscreen focus mode started: end focus too.
		if (!document.fullscreenElement && fullscreenByFocus) {
			fullscreenByFocus = false;
			setFocus(false);
		}
	}

	onMount(() => {
		noteIndex.touch(entry.id);
		// How the others' screens label us: the name given on joining, else
		// role and a guess at the device.
		const role = owner ? 'Owner' : canEdit ? 'Editor' : 'Observer';
		const device = matchMedia('(pointer: coarse)').matches ? 'tablet' : 'computer';
		const label = myName() || `${role} · ${device}`;
		noteStore.connect(entry.id, { token: entry.token, label, owner: entry.ownerProof });
		// Owner devices from before pulls existed have the key but no proof yet.
		if (entry.ownerKey && !entry.ownerProof) {
			const id = entry.id;
			ownerSession(id, entry.ownerKey)
				.then((session) => {
					if (noteStore.id !== id) return;
					noteIndex.save(session);
					noteStore.renewToken(session.token, session.ownerProof);
				})
				.catch(() => {
					/* offline: try again next time the note opens */
				});
		}
		if (focus) revealFocusBar();
		document.addEventListener('fullscreenchange', onFullscreenChange);
		return () => {
			document.removeEventListener('fullscreenchange', onFullscreenChange);
			clearTimeout(focusBarTimer);
			if (fullscreenByFocus && document.fullscreenElement) document.exitFullscreen().catch(() => {});
			noteStore.disconnect();
		};
	});

	// --- Pulls: the owner brings everyone to their view --------------------------

	let canvasRef = $state<ReturnType<typeof DrawingCanvas>>();
	/** Lights the button briefly once sent. */
	let pullSent = $state(false);
	let pullSentTimer: ReturnType<typeof setTimeout> | undefined;

	function pullEveryone() {
		if (canvasWidth <= 0 || canvasHeight <= 0) return;
		noteStore.pullEveryone(viewport.visible(canvasWidth, canvasHeight));
		pullSent = true;
		clearTimeout(pullSentTimer);
		pullSentTimer = setTimeout(() => (pullSent = false), 1500);
	}

	/** Shown briefly after we were pulled, so the jump isn't a mystery. */
	let pulledBy = $state<{ label: string; color: string } | null>(null);
	let pulledTimer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		const p = noteStore.pulled;
		if (!p) return;
		untrack(() => {
			follow = null; // or the next redraw would frame something else again
			canvasRef?.showView(p.view);
			pulledBy = { label: p.label || 'The owner', color: p.color };
			clearTimeout(pulledTimer);
			pulledTimer = setTimeout(() => (pulledBy = null), 3000);
		});
	});

	/** 100%. With pages, the first one's corner sits just inside the screen
	 *  (room for its label) rather than flush against it. */
	function resetView() {
		follow = null;
		viewport.reset();
		const first = noteStore.pages[0];
		if (first) viewport.panBy(PAGE_GAP / 2 - first.x, PAGE_GAP - first.y);
	}

	function fit() {
		viewport.fit(noteStore.contentBounds(), canvasWidth, canvasHeight);
	}

	// Following: the canvas eases toward a target box every frame (and holds
	// still under a pen), so a growing drawing or someone panning reads as one
	// smooth camera rather than jumps. Following a device only *reads* its
	// presence — our viewport stays ours, and any pan or zoom here lets go.
	$effect(() => {
		const canvas = canvasRef;
		if (!canvas) return;
		const id = follow;
		if (id === 'drawing') {
			void noteStore.revision;
			const box = noteStore.contentBounds();
			if (box) canvas.follow(box, 32, MAX_FIT_SCALE);
			else untrack(() => viewport.reset()); // empty note: plain 100%
			return;
		}
		if (typeof id === 'number') {
			const who = noteStore.presence.find((p) => p.id === id);
			if (!who) {
				// They left: fall back to the whole drawing in focus, else stay put.
				untrack(() => (follow = focus ? 'drawing' : null));
				return;
			}
			const v = who.view;
			if (v) canvas.follow({ x0: v.x, y0: v.y, x1: v.x + v.w, y1: v.y + v.h });
			return;
		}
		canvas.follow(null);
	});

	function followWho(id: Follow) {
		follow = follow === id && !focus ? null : id;
	}

	const followed = $derived(typeof follow === 'number' ? noteStore.presence.find((p) => p.id === follow) : undefined);

	// --- PDF ------------------------------------------------------------------

	let pdfInput = $state<HTMLInputElement>();
	let pdfBusy = $state<'' | 'import' | 'export' | 'zotero-in' | 'zotero-out'>('');
	const BUSY_TEXT = {
		import: 'Importing PDF…',
		export: 'Exporting PDF…',
		'zotero-in': 'Fetching from Zotero…',
		'zotero-out': 'Saving to Zotero…'
	};
	let pdfError = $state('');

	async function importPdf(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // the same file can be picked again
		if (!file) return;
		pdfBusy = 'import';
		pdfError = '';
		const hadPages = noteStore.pages.length > 0;
		try {
			await noteStore.importPdf(file);
			// Show the new pages: the whole thing on a first import.
			if (!hadPages) {
				follow = null;
				fit();
			}
		} catch (err) {
			pdfError = err instanceof Error ? err.message : 'Import failed.';
		} finally {
			pdfBusy = '';
		}
	}

	async function exportPdf() {
		pop = '';
		pdfBusy = 'export';
		pdfError = '';
		try {
			const bytes = await noteStore.exportPdf();
			const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'application/pdf' }));
			const a = document.createElement('a');
			a.href = url;
			a.download = `${entry.name}.pdf`;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		} catch (err) {
			pdfError = err instanceof Error ? `Export failed: ${err.message}` : 'Export failed.';
		} finally {
			pdfBusy = '';
		}
	}

	// --- Zotero: papers in, annotated PDFs back out -------------------------------

	/** Setting up (or changing) the connection, rather than searching. */
	let zoteroSetup = $state(!zotero.settings);
	let zoteroQuery = $state('');
	let zoteroItems = $state<ZoteroItem[] | null>(null);
	/** An item opened to pick one of its several PDFs. */
	let zoteroOpen = $state<{ item: ZoteroItem; pdfs: ZoteroPdf[] } | null>(null);
	let zoteroError = $state('');
	let zoteroDone = $state('');
	let zoteroSearchTimer: ReturnType<typeof setTimeout> | undefined;

	async function openZotero(e: MouseEvent) {
		zoteroSetup = !zotero.settings;
		zoteroError = '';
		toggle('zotero', e);
		// Set up on another device: the account has it.
		if (!zotero.settings && account.vaultKey) {
			await account.pullVault();
			zoteroSetup = !zotero.settings;
		}
		if (zotero.settings && account.signedIn && !zoteroItems) void findInZotero();
	}

	async function findInZotero() {
		const z = zotero.settings;
		if (!z) return;
		zoteroError = '';
		try {
			zoteroItems = (await zoteroSearch(z, zoteroQuery.trim())).items;
		} catch (err) {
			zoteroError = err instanceof Error ? err.message : 'Search failed.';
		}
	}

	function onZoteroQuery() {
		clearTimeout(zoteroSearchTimer);
		zoteroSearchTimer = setTimeout(findInZotero, 300);
	}

	async function pickZoteroItem(item: ZoteroItem) {
		const z = zotero.settings;
		if (!z) return;
		zoteroError = '';
		try {
			const { pdfs } = await zoteroPdfs(z, item.key);
			if (pdfs.length === 0) zoteroError = `"${item.title}" has no PDF stored in Zotero.`;
			else if (pdfs.length === 1) await importFromZotero(item, pdfs[0]);
			else zoteroOpen = { item, pdfs };
		} catch (err) {
			zoteroError = err instanceof Error ? err.message : 'Something went wrong.';
		}
	}

	async function importFromZotero(item: ZoteroItem, pdf: ZoteroPdf) {
		const z = zotero.settings;
		if (!z) return;
		pop = '';
		zoteroOpen = null;
		pdfBusy = 'zotero-in';
		pdfError = '';
		const hadPages = noteStore.pages.length > 0;
		try {
			const bytes = await zoteroFile(z, pdf.key);
			const { conote } = await noteStore.importPdf(new Blob([bytes.slice()], { type: 'application/pdf' }));
			// Remember where it came from, so saving goes back to that item —
			// replacing this very attachment if it's one conote saved before.
			if (!noteStore.zotero || noteStore.zotero.library !== z.userId) {
				noteStore.setZoteroLink({
					library: z.userId,
					parent: pdf.parent ?? (item.key !== pdf.key ? item.key : null),
					saved: conote ? pdf.key : null,
					title: item.title.replace(/ \(conote\)$/, '') || pdf.title
				});
			}
			if (!hadPages) {
				follow = null;
				fit();
			}
		} catch (err) {
			pdfError = err instanceof Error ? err.message : 'Import failed.';
		} finally {
			pdfBusy = '';
		}
	}

	async function saveToZotero(e: MouseEvent) {
		const z = zotero.settings;
		if (!z || !account.signedIn) return openZotero(e);
		pop = '';
		pdfBusy = 'zotero-out';
		pdfError = '';
		try {
			const link = noteStore.zotero?.library === z.userId ? noteStore.zotero : null;
			const title = link?.title || entry.name;
			const bytes = await noteStore.exportPdf();
			const { key } = await zoteroSave(
				z,
				{
					key: link?.saved ?? undefined,
					parent: link?.parent ?? undefined,
					title: `${title} (conote)`,
					filename: `${title.slice(0, 80)} (conote).pdf`
				},
				bytes
			);
			if (canEdit) noteStore.setZoteroLink({ library: z.userId, parent: link?.parent ?? null, saved: key, title });
			zoteroDone = link?.saved === key ? 'Updated in Zotero' : link?.parent ? 'Saved to Zotero, attached to its paper' : 'Saved to Zotero';
			setTimeout(() => (zoteroDone = ''), 4000);
		} catch (err) {
			pdfError = err instanceof Error ? `Zotero: ${err.message}` : 'Saving to Zotero failed.';
		} finally {
			pdfBusy = '';
		}
	}

	function zoomBy(factor: number) {
		follow = null;
		viewport.zoomAt(canvasWidth / 2, canvasHeight / 2, factor);
	}

	// An observer cannot ink. This mirrors the server's decision in the UI; it is
	// NOT what enforces read-only (the server drops their writes). Focus mode
	// watches, so it doesn't ink either.
	const effectiveMode = $derived(canEdit && !focus ? mode : 'observe');
	const zoomPct = $derived(Math.round(viewport.scale * 100));
	const roleLabel = $derived(owner ? 'Owner' : canEdit ? 'Editor' : 'Observer');

	const shareLink = $derived(`${location.origin}/?join=${encodeURIComponent(entry.name)}`);
	let copied = $state(false);

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard blocked — the input is still there to select by hand */
		}
	}

	// --- Lost access: passcode changed or note deleted -------------------------

	let rejoinPasscode = $state('');
	let rejoinError = $state('');
	let rejoining = $state(false);

	async function rejoin(e?: SubmitEvent) {
		e?.preventDefault();
		rejoining = true;
		rejoinError = '';
		try {
			const session: NoteSession & { ownerProof?: string } = owner
				? await ownerSession(entry.id, entry.ownerKey)
				: await joinNote(entry.name, rejoinPasscode);
			// A different passcode can mean a different role, and a different
			// note if the old one was deleted and its name reused.
			if (session.id !== entry.id) throw new ApiError('That passcode belongs to a newer note with this name.');
			noteIndex.save(session);
			noteStore.renewToken(session.token, session.ownerProof);
			rejoinPasscode = '';
		} catch (err) {
			rejoinError = err instanceof ApiError ? err.message : 'Something went wrong.';
		} finally {
			rejoining = false;
		}
	}

	// The creator's device can always get back in by itself.
	$effect(() => {
		if (noteStore.access === 'revoked' && owner) untrack(() => rejoin());
	});

	// --- Keeping: an unsaved (or pre-account) note goes into the owner's account -----

	let keepForm = $state({ name: '', password: '', busy: false, error: '' });

	async function keepNote(signIn?: 'in' | 'create') {
		keepForm.busy = true;
		keepForm.error = '';
		try {
			if (signIn) {
				await account.signIn(keepForm.name, keepForm.password, signIn === 'create');
				keepForm.password = '';
			}
			noteIndex.save(await claimNote(entry.id, entry.ownerKey), { via: account.name });
			pop = '';
		} catch (err) {
			keepForm.error = err instanceof Error ? err.message : 'Something went wrong.';
		} finally {
			keepForm.busy = false;
		}
	}

	async function forgetDeleted() {
		noteIndex.remove(entry.id);
		onleave();
		await destroyNoteData(entry.id);
	}

	const statusWord = $derived(
		noteStore.status === 'connected' ? 'Live' : noteStore.status === 'connecting' ? 'Connecting' : 'Offline'
	);
	const syncDetail = $derived(
		`Server ${noteStore.status}` +
			(noteStore.direct > 0
				? ` · ${noteStore.direct} direct link${noteStore.direct > 1 ? 's' : ''}${noteStore.hub ? ' (hub)' : ''}`
				: ' · strokes via server')
	);

	// --- Keyboard ----------------------------------------------------------------

	function typing(e: KeyboardEvent) {
		const t = e.target as HTMLElement | null;
		return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
	}

	function onKey(e: KeyboardEvent) {
		if (typing(e) || showSettings) return;
		const mod = e.ctrlKey || e.metaKey;
		const k = e.key.toLowerCase();
		if (mod && canEdit && !focus && (k === 'z' || k === 'y')) {
			e.preventDefault();
			if (k === 'y' || e.shiftKey) noteStore.redo();
			else noteStore.undo();
			return;
		}
		if (mod || e.altKey) return;
		if (e.key === 'Escape') {
			if (customizing) setCustomizing(false);
			else if (pop) pop = '';
			else if (focus) setFocus(false);
			return;
		}
		if (k === 'f') return setFocus(!focus);
		if (k === '0') return resetView();
		if (k === '1') {
			follow = null;
			return fit();
		}
		if (e.key === '+' || e.key === '=') return zoomBy(1.25);
		if (e.key === '-') return zoomBy(0.8);
		if (canEdit && effectiveMode === 'draw') {
			const t = TOOLS.find((t) => t.key.toLowerCase() === k);
			if (t) pickTool(t.id);
		}
	}

	function onWindowPointerDown(e: PointerEvent) {
		if (focus) revealFocusBar();
		if (pop && !(e.target as Element | null)?.closest?.('[data-pop]')) pop = '';
	}

	const showRail = $derived(canEdit && effectiveMode === 'draw');

	// --- Bars: where each sits, merged or tucked away, per device --------------

	const bars = new Bars();
	const narrowQuery = matchMedia('(max-width: 600px)');
	bars.profile = narrowQuery.matches ? 'narrow' : 'wide';
	onMount(() => {
		const onChange = () => (bars.profile = narrowQuery.matches ? 'narrow' : 'wide');
		narrowQuery.addEventListener('change', onChange);
		return () => narrowQuery.removeEventListener('change', onChange);
	});

	/** The bars this device shows at an anchor (observers have no tools). */
	const shown = (a: Anchor) => bars.at(a).filter((id) => id !== 'tools' || canEdit);
	const present = (a: Anchor) => shown(a).length > 0 && !bars.isHidden(a);

	/** Which way each anchor's tuck button points: where the capsule goes. */
	const TUCK: Record<Anchor, IconName> = {
		'top-start': 'chevronLeft',
		'top-center': 'chevronUp',
		'top-end': 'chevronRight',
		left: 'chevronLeft',
		right: 'chevronRight',
		'bottom-start': 'chevronLeft',
		'bottom-center': 'chevronDown',
		'bottom-end': 'chevronRight'
	};
	function tuckFly(a: Anchor) {
		const x = a.endsWith('-start') || a === 'left' ? -40 : a.endsWith('-end') || a === 'right' ? 40 : 0;
		const y = a.startsWith('top') ? -24 : a.startsWith('bottom') ? 24 : 0;
		return { x, y, duration: 240 };
	}
	/** What a tucked-away capsule shows: the live dot for the title, else its first bar. */
	function stubIcon(a: Anchor): IconName | null {
		const first = shown(a)[0];
		if (shown(a).includes('title')) return null;
		if (first === 'tools') return TOOLS.find((t) => t.id === tool)?.icon ?? 'pen';
		return first === 'view' ? 'zoom' : 'users';
	}
	const groupLabel = (a: Anchor) => shown(a).map((id) => BAR_NAMES[id]).join(' + ');

	// Top and bottom rows are placed by hand rather than by flexbox: a centre
	// capsule stays truly centred, a row too full for one line puts the centre
	// on a line of its own (inward), and the title gives way first.
	const GAP = 12;
	const TITLE_MIN = 48;
	let rowWidth = $state(0);
	let groupW = $state<Partial<Record<Anchor, number>>>({});
	let groupH = $state<Partial<Record<Anchor, number>>>({});
	let segW = $state<Partial<Record<BarId, number>>>({});

	const rows = $derived.by(() => {
		const places: Partial<Record<Anchor, { x: number; y: number }>> = {};
		const W = rowWidth;
		const titleAt = bars.anchorOf('title');
		/** Room for the title's whole capsule. */
		let titleRoom = 0;
		const height = { top: 0, bottom: 0 };
		const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
		for (const edge of ['top', 'bottom'] as const) {
			const [s, c, e] = (['start', 'center', 'end'] as const).map((p) => `${edge}-${p}` as Anchor);
			const w = (a: Anchor) => (present(a) ? (groupW[a] ?? 0) : 0);
			const h = (a: Anchor) => (present(a) ? (groupH[a] ?? 0) : 0);
			// The narrowest each can get: the title shrinks down to TITLE_MIN.
			const min = (a: Anchor) => (a === titleAt && present(a) ? w(a) - (segW.title ?? 0) + TITLE_MIN : w(a));
			const beside = (x: number) => (x ? x + GAP : 0);
			const [S, C, E] = [w(s), w(c), w(e)];
			const [sm, cm, em] = [min(s), min(c), min(e)];
			if (cm > 0 && beside(sm) + cm + beside(em) > W) {
				const sides = Math.max(h(s), h(e));
				const mid = h(c);
				const sidesY = edge === 'top' ? 0 : mid + GAP;
				const midY = edge === 'top' ? beside(sides) : 0;
				places[s] = { x: 0, y: sidesY };
				places[e] = { x: W - E, y: sidesY };
				places[c] = { x: Math.max(0, (W - C) / 2), y: midY };
				height[edge] = Math.max(sidesY + sides, midY + mid);
				if (titleAt === s) titleRoom = W - beside(em);
				else if (titleAt === e) titleRoom = W - beside(sm);
				else if (titleAt === c) titleRoom = W;
			} else {
				places[s] = { x: 0, y: 0 };
				places[e] = { x: W - E, y: 0 };
				places[c] = { x: clamp((W - C) / 2, beside(S), W - C - beside(E)), y: 0 };
				height[edge] = Math.max(h(s), h(c), h(e));
				// Beside a centre capsule the title keeps it centred if it can.
				const side = (other: number) => (cm ? clamp((W - cm) / 2 - GAP, min(titleAt), W - cm - GAP - beside(other)) : W - beside(other));
				if (titleAt === s) titleRoom = side(em);
				else if (titleAt === e) titleRoom = side(sm);
				else if (titleAt === c) titleRoom = Math.max(cm, W - 2 * Math.max(beside(sm), beside(em)));
			}
		}
		const rest = (groupW[titleAt] ?? 0) - (segW.title ?? 0);
		return { places, height, titleMax: W > 0 ? Math.max(TITLE_MIN, titleRoom - rest) : 0 };
	});

	/** Where the open panel goes, from the button that opened it. */
	const popStyle = $derived.by(() => {
		if (!popFrom) return '';
		// Clear of the whole capsule on the side facing the screen, level with the button.
		const { r, g, a } = popFrom;
		const [W, H] = [canvasWidth, canvasHeight];
		const css: string[] = [];
		let v: string;
		let o: string;
		if (isColumn(a)) {
			css.push(a === 'left' ? `left: ${g.right + 10}px` : `right: ${W - g.left + 10}px`);
			o = a === 'left' ? 'left' : 'right';
			if (r.top + r.height / 2 < H / 2) {
				css.push(`top: ${r.top}px`, `max-height: calc(100% - ${r.top}px - var(--bottom))`);
				v = 'top';
			} else {
				css.push(`bottom: ${H - r.bottom}px`, `max-height: calc(${r.bottom}px - var(--top))`);
				v = 'bottom';
			}
		} else {
			if (a.startsWith('top')) {
				css.push(`top: ${g.bottom + 10}px`, `max-height: calc(100% - ${g.bottom + 10}px - var(--bottom))`);
				v = 'top';
			} else {
				css.push(`bottom: ${H - g.top + 10}px`, `max-height: calc(${g.top - 10}px - var(--top))`);
				v = 'bottom';
			}
			// Aligned with the button's outer side, kept on screen.
			if (r.left + r.width / 2 > W / 2) {
				css.push(`right: clamp(var(--right), ${W - r.right}px, calc(100% - var(--pw) - var(--left)))`);
				o = 'right';
			} else {
				css.push(`left: clamp(var(--left), ${r.left}px, calc(100% - var(--pw) - var(--right)))`);
				o = 'left';
			}
		}
		css.push(`transform-origin: ${v} ${o}`);
		return css.join('; ');
	});

	// --- Customising: drag a bar to an anchor, or into another capsule ---------

	let customizing = $state(false);
	type Drag = {
		id: BarId;
		x: number;
		y: number;
		to: Anchor | null;
		/** The bar it goes in front of there; null = at the end. */
		before: BarId | null;
		caret: { x: number; y: number; w: number; h: number } | null;
	};
	let drag = $state<Drag | null>(null);

	function setCustomizing(on: boolean) {
		customizing = on;
		drag = null;
		pop = '';
	}

	/** Over a capsule: that capsule (joining it). Else the screen in thirds:
	 *  corners and edge middles are anchors, the middle is "cancel". */
	function zoneAt(x: number, y: number): Anchor | null {
		const SLACK = 10;
		for (const el of document.querySelectorAll<HTMLElement>('.group[data-anchor]')) {
			const r = el.getBoundingClientRect();
			if (x > r.left - SLACK && x < r.right + SLACK && y > r.top - SLACK && y < r.bottom + SLACK) {
				return el.dataset.anchor as Anchor;
			}
		}
		const col = Math.min(2, Math.floor((3 * x) / canvasWidth));
		const row = Math.min(2, Math.floor((3 * y) / canvasHeight));
		if (row === 1) return col === 0 ? 'left' : col === 2 ? 'right' : null;
		return `${row === 0 ? 'top' : 'bottom'}-${(['start', 'center', 'end'] as const)[col]}`;
	}

	function startDrag(e: PointerEvent, id: BarId) {
		if (!customizing || e.button !== 0) return;
		e.preventDefault();
		drag = { id, x: e.clientX, y: e.clientY, to: null, before: null, caret: null };
		moveDrag(e);
	}

	function moveDrag(e: PointerEvent) {
		if (!drag) return;
		const { id } = drag;
		const zone = zoneAt(e.clientX, e.clientY);
		const to = zone && fits(id, zone) ? zone : null;
		let before: BarId | null = null;
		let caret: Drag['caret'] = null;
		if (to && present(to)) {
			// Between which of the capsule's bars it would land.
			const col = isColumn(to);
			const segs = [...document.querySelectorAll<HTMLElement>(`[data-anchor="${to}"] [data-bar]`)]
				.filter((el) => el.dataset.bar !== id)
				.map((el) => ({ id: el.dataset.bar as BarId, r: el.getBoundingClientRect() }));
			const at = (p: number) => (col ? e.clientY > p : e.clientX > p);
			const i = segs.filter((s) => at(col ? s.r.top + s.r.height / 2 : s.r.left + s.r.width / 2)).length;
			before = segs[i]?.id ?? null;
			const ref = segs[i]?.r ?? segs[i - 1]?.r;
			if (ref) {
				const edge = segs[i] ? (col ? ref.top : ref.left) - 3 : (col ? ref.bottom : ref.right) + 1;
				caret = col ? { x: ref.left, y: edge, w: ref.width, h: 3 } : { x: edge, y: ref.top, w: 3, h: ref.height };
			}
		}
		drag = { id, x: e.clientX, y: e.clientY, to, before, caret };
	}

	function endDrag() {
		if (!drag) return;
		const { id, to, before } = drag;
		drag = null;
		if (!to) return;
		const there = bars.at(to).filter((b) => b !== id);
		bars.move(id, to, before ? there.indexOf(before) : there.length);
	}

	// Ink preview in the size/colour panel: thickness at 100% zoom, like on paper.
	const previewWidth = $derived(Math.max(1.2, Math.min(strokeWidth, 44)));
</script>

<svelte:window
	onkeydown={onKey}
	onpointerdown={onWindowPointerDown}
	onpointermove={(e) => {
		if (focus) revealFocusBar();
		moveDrag(e);
	}}
	onpointerup={endDrag}
	onpointercancel={() => (drag = null)}
/>

<div class="app" class:inking class:focus class:customizing class:idle={focus && !focusBar}>
	<main class="stage">
		<DrawingCanvas
			bind:this={canvasRef}
			{viewport}
			mode={effectiveMode}
			{tool}
			{color}
			{strokeWidth}
			showPresence={showOthers}
			showViews={!focus}
			bind:width={canvasWidth}
			bind:height={canvasHeight}
			onnavigate={() => (follow = null)}
			onactive={(on) => {
				inking = on;
				if (on) pop = '';
			}}
			pageActions={canEdit && effectiveMode === 'draw'}
			{snap}
			{fingerInks}
			onpen={onPen}
			penButton={penButtonUse}
		/>
	</main>

	<!-- What each bar holds; where it sits is the layout's business. -->
	{#snippet barBody(id: BarId, col: boolean)}
		{#if id === 'title'}
			<!-- Back, the note's name, who we are, whether we're live. -->
			<button class="ibtn" onclick={onleave} title="All notes" aria-label="All notes"><Icon name="back" /></button>
			<div class="ident">
				<span class="name" title={entry.name}>{entry.name}</span>
				<span class="kicker meta">
					<span class="role" data-role={owner ? 'owner' : entry.role}>{roleLabel}</span>
					<span class="sep">/</span>
					<span class="dot" data-status={noteStore.status}></span>{statusWord}
					{#if entry.saved === false}<span class="sep">/</span><span class="unsaved" title="Not kept in an account: it ends when everyone leaves">unsaved</span>{/if}
				</span>
			</div>
		{:else if id === 'people'}
			<!-- People, share, bring everyone here, focus, more. -->
			<button
				class="people"
				class:on={pop === 'people'}
				data-pop
				onclick={(e) => toggle('people', e)}
				title="Who's here"
				aria-label="Who's here"
			>
				{#if noteStore.presence.length > 0}
					<span class="faces">
						{#each noteStore.presence.slice(0, 4) as p (p.id)}
							<span class="bead" style:background={p.color}></span>
						{/each}
					</span>
					<span class="count">{noteStore.presence.length + 1}</span>
				{:else}
					<Icon name="users" size={18} />
					<span class="count solo">1</span>
				{/if}
			</button>
			<span class={col ? 'hr' : 'vr'}></span>
			<button class="ibtn" class:on={pop === 'share'} data-pop onclick={(e) => toggle('share', e)} title="Share" aria-label="Share">
				<Icon name="link" />
			</button>
			{#if owner}
				<button
					class="ibtn"
					class:on={pullSent}
					disabled={noteStore.peers <= 1 || noteStore.access !== 'ok'}
					onclick={pullEveryone}
					title="Bring everyone here: move everyone else's view to what you see now"
					aria-label="Bring everyone here"
				>
					<Icon name={pullSent ? 'check' : 'gather'} />
				</button>
			{/if}
			<button class="ibtn" onclick={() => setFocus(true)} title="Focus mode (F): only the note, following along" aria-label="Focus mode">
				<Icon name="focus" />
			</button>
			<button class="ibtn" class:on={pop === 'more'} data-pop onclick={(e) => toggle('more', e)} title="More" aria-label="More">
				<Icon name="more" />
			</button>
		{:else if id === 'view'}
			<!-- Zoom, fit, follow. -->
			<button class="ibtn pm" onclick={() => zoomBy(0.8)} aria-label="Zoom out" title="Zoom out (−)"><Icon name="minus" size={18} /></button>
			<button class="pct" onclick={resetView} title="Back to 100% (0)">{zoomPct}<small>%</small></button>
			<button class="ibtn pm" onclick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in (+)"><Icon name="plus" size={18} /></button>
			<span class="pm {col ? 'hr' : 'vr'}"></span>
			<button
				class="word"
				onclick={() => {
					follow = null;
					fit();
				}}
				title="Frame the whole drawing (1)">Fit</button
			>
			<button
				class="word"
				class:on={follow !== null}
				onclick={() => followWho(follow === null ? 'drawing' : null)}
				title="Keep the whole drawing in view as it grows. Panning or zooming lets go."
			>
				{#if followed}
					<span class="pip" style:background={followed.color}></span>
				{/if}
				Follow
			</button>
		{:else if showRail}
			<!-- Tools: the pen case. -->
			{#each TOOLS as t (t.id)}
				<button
					class="tool"
					class:on={tool === t.id}
					onclick={() => pickTool(t.id)}
					title={`${t.label} (${t.key})${t.hint ? ` — ${t.hint}` : ''}`}
					aria-label={t.label}
					aria-pressed={tool === t.id}
				>
					<Icon name={t.icon} size={21} />
					{#if isBrush(t.id)}
						<span class="tip" style:background={inks[t.id].color}></span>
					{/if}
				</button>
			{/each}
			<span class={col ? 'hr' : 'vr'}></span>
			<button
				class="ink"
				class:on={pop === 'ink'}
				data-pop
				onclick={(e) => toggle('ink', e)}
				title={`${INKS[brush].label}: colour and size`}
				aria-label={`${INKS[brush].label} colour and size`}
			>
				<span class="dish"><span class="blob" style:background={color} style:--w="{Math.min(20, 4 + strokeWidth * 0.55)}px"></span></span>
			</button>
			{#if presets.length && bars.profile === 'wide'}
				{#each presets as p, i (i)}
					<button
						class="preset"
						class:on={isCurrent(p)}
						onclick={() => usePreset(p)}
						title={`${INKS[p.brush].label}, ${p.width} pt`}
						aria-label={`Saved ink: ${INKS[p.brush].label} ${p.color}, ${p.width} pt`}
					>
						{@render presetMark(p)}
					</button>
				{/each}
			{/if}
			<span class={col ? 'hr' : 'vr'}></span>
			<button class="tool" onclick={() => noteStore.undo()} disabled={!noteStore.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
				<Icon name="undo" size={20} />
			</button>
			<button class="tool" onclick={() => noteStore.redo()} disabled={!noteStore.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
				<Icon name="redo" size={20} />
			</button>
		{:else}
			<span class="kicker">Look only</span>
			<button class="mini lime" onclick={() => (mode = 'draw')}>Draw</button>
		{/if}
	{/snippet}

	<!-- One capsule per anchor: its bars side by side, and a tab that tucks it away. -->
	{#snippet group(a: Anchor)}
		{@const ids = shown(a)}
		{#if ids.length && !bars.isHidden(a)}
			{@const col = isColumn(a)}
			{@const p = rows.places[a]}
			{@const tuck = a.endsWith('-end')}
			<div
				class="chrome group {a}"
				class:col
				data-anchor={a}
				style:left={p && !col ? `${p.x}px` : undefined}
				style:top={p && a.startsWith('top') ? `${p.y}px` : undefined}
				style:bottom={p && a.startsWith('bottom') ? `${p.y}px` : undefined}
				bind:offsetWidth={groupW[a]}
				bind:offsetHeight={groupH[a]}
				transition:fly={tuckFly(a)}
			>
				{#if tuck}{@render tucker(a)}{/if}
				{#each ids as id, i (id)}
					{#if i}<span class="join {col ? 'hr' : 'vr'}"></span>{/if}
					<div
						class="bar {id === 'title' ? 'masthead' : id === 'people' ? 'corner' : id === 'view' ? 'zoombar' : showRail ? 'rail' : 'lookonly'}"
						class:col
						class:dragging={drag?.id === id}
						data-bar={id}
						role="toolbar"
						tabindex="-1"
						aria-label={BAR_NAMES[id]}
						style:max-width={id === 'title' && rows.titleMax ? `${rows.titleMax}px` : undefined}
						bind:offsetWidth={segW[id]}
						onpointerdown={(e) => startDrag(e, id)}
					>
						{@render barBody(id, col)}
					</div>
				{/each}
				{#if !tuck}{@render tucker(a)}{/if}
			</div>
		{/if}
	{/snippet}

	{#snippet presetMark(p: Preset)}
		<!-- The brush's icon in the saved colour, sized by thickness, on paper so any colour shows. -->
		<span class="dish" style:color={p.color}><Icon name={p.brush} size={presetSize(p)} stroke={2.25} /></span>
	{/snippet}

	{#snippet tucker(a: Anchor)}
		<button class="tuck" onclick={() => bars.setHidden(a, true)} title="Tuck away (tap the tab at the edge to bring it back)" aria-label={`Hide ${groupLabel(a)}`}>
			<Icon name={TUCK[a]} size={14} stroke={2.25} />
		</button>
	{/snippet}

	{#if !focus}
		<div class="edge top" bind:clientWidth={rowWidth} transition:fly={{ y: -16, duration: 260 }}>
			{@render group('top-start')}
			{@render group('top-center')}
			{@render group('top-end')}
		</div>
		<div class="edge bottom" transition:fly={{ y: 16, duration: 260 }}>
			{@render group('bottom-start')}
			{@render group('bottom-center')}
			{@render group('bottom-end')}
		</div>
		<div class="side left" transition:fly={{ x: -24, duration: 260 }}>{@render group('left')}</div>
		<div class="side right" transition:fly={{ x: 24, duration: 260 }}>{@render group('right')}</div>

		<!-- Tucked-away capsules: a quarter circle in a corner, a tab on an edge. -->
		{#each ANCHORS as a (a)}
			{#if shown(a).length && bars.isHidden(a)}
				{@const icon = stubIcon(a)}
				<button
					class="chrome tucked {a}"
					class:quarter={isCorner(a)}
					onclick={() => bars.setHidden(a, false)}
					title={`Show ${groupLabel(a)}`}
					aria-label={`Show ${groupLabel(a)}`}
					transition:scale={{ start: 0.3, duration: 220 }}
				>
					<span class="mark">
						{#if icon}<Icon name={icon} size={isCorner(a) ? 18 : 14} />{:else}<span class="dot" data-status={noteStore.status}></span>{/if}
					</span>
				</button>
			{/if}
		{/each}

		{#if pop === 'ink' && showRail}
			<div class="pop inkpop" style={popStyle} data-pop transition:scale={{ start: 0.96, duration: 160 }}>
				<div class="pophead">
					<span class="serif">{INKS[brush].label}</span>
					<span class="kicker">{strokeWidth.toFixed(1)} pt</span>
				</div>
				<svg class="preview" viewBox="0 0 240 70" aria-hidden="true">
					{#if brush === 'text'}
						<text x="14" y="46" fill={color} font-family={TEXT_FONT} font-size={Math.min(strokeWidth * 1.4, 44)}>Text Aa</text>
					{:else}
						<path
							d="M14 48 C 46 10, 78 12, 104 34 S 168 62, 226 22"
							fill="none"
							stroke={color}
							stroke-width={previewWidth}
							stroke-linecap={brush === 'marker' ? 'butt' : 'round'}
							opacity={brush === 'marker' ? MARKER_ALPHA + 0.25 : 1}
						/>
					{/if}
				</svg>
				<input
					class="size"
					type="range"
					min={INKS[brush].min}
					max={INKS[brush].max}
					step="0.5"
					bind:value={inks[brush].width}
					aria-label={`${INKS[brush].label} size`}
				/>
				<div class="swatches">
					{#each palette as c (c)}
						<button
							class="swatch"
							class:on={color === c}
							style:--c={c}
							aria-label={`Colour ${c}`}
							onclick={() => pickColor(c)}
						></button>
					{/each}
				</div>
				<div class="saved">
					{#each presets as p, i (i)}
						<span class="chip">
							<button
								class="preset"
								class:on={isCurrent(p)}
								onclick={() => usePreset(p)}
								title={`${INKS[p.brush].label}, ${p.width} pt`}
								aria-label={`Saved ink: ${INKS[p.brush].label} ${p.color}, ${p.width} pt`}
							>
								{@render presetMark(p)}
							</button>
							<button class="unsave" onclick={() => removePreset(i)} title="Forget this ink" aria-label="Forget this saved ink">
								<Icon name="x" size={10} stroke={3} />
							</button>
						</span>
					{/each}
					{#if presets.length < MAX_PRESETS}
						<button class="mini save" onclick={addPreset} disabled={presetSaved} title="Keep this brush, colour and size one tap away">
							{presetSaved ? 'Saved' : presets.length ? '+ Save' : '+ Save this ink'}
						</button>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Panels from the top-right corner. -->
		{#if pop === 'people'}
			<div style={popStyle} class="pop corner-pop" data-pop transition:scale={{ start: 0.96, duration: 160 }}>
				<div class="pophead">
					<span class="serif">On this note</span>
					<span class="kicker">{noteStore.presence.length + 1} here</span>
				</div>
				<ul class="who">
					<li>
						<span class="face me">{roleLabel.charAt(0)}</span>
						<span class="wl">You <span class="kicker">{roleLabel}</span></span>
					</li>
					{#each noteStore.presence as p (p.id)}
						<li>
							<span class="face" style:background={p.color}>{p.label.charAt(0)}</span>
							<span class="wl">{p.label || 'Someone'}</span>
							<button class="mini" class:lime={follow === p.id} onclick={() => followWho(p.id)} disabled={!p.view}>
								{follow === p.id ? 'Following' : 'Follow'}
							</button>
						</li>
					{/each}
				</ul>
				<label class="switch">
					<input type="checkbox" bind:checked={showOthers} />
					<span class="track"></span>
					<span>Show their cursors &amp; views</span>
				</label>
				{#if owner}
					<button
						class="btn lime wide"
						disabled={noteStore.peers <= 1 || noteStore.access !== 'ok'}
						onclick={pullEveryone}
						title="Move everyone else's view to what you see now"
					>
						<Icon name={pullSent ? 'check' : 'gather'} size={18} />
						{pullSent ? 'Sent' : 'Bring everyone here'}
					</button>
				{/if}
				<p class="fine kicker">{syncDetail}</p>
			</div>
		{:else if pop === 'share'}
			<div style={popStyle} class="pop corner-pop ticketwrap" data-pop transition:scale={{ start: 0.96, duration: 160 }}>
				<div class="ticket">
					<div class="stub">
						<span class="kicker">Admit · join link</span>
						<span class="serif big">{entry.name}</span>
					</div>
					<div class="perf"></div>
					<div class="row">
						<input class="input mono" readonly value={shareLink} onfocus={(e) => e.currentTarget.select()} />
						<button class="btn primary" onclick={() => copy(shareLink)}>
							<Icon name={copied ? 'check' : 'copy'} size={16} />{copied ? 'Copied' : 'Copy'}
						</button>
					</div>
					<p class="fine">
						{#if entry.viewAccess === 'open'}
							Anyone with the link can watch. Send the editor passcode separately to people who should draw.
						{:else if entry.viewAccess === 'none'}
							Only editors can join. Send the editor passcode separately.
						{:else}
							Send a passcode separately: the editor one to draw, the observer one to watch.
						{/if}
					</p>
				</div>
			</div>
		{:else if pop === 'zotero'}
			<div style={popStyle} class="pop corner-pop zotero" data-pop transition:scale={{ start: 0.96, duration: 160 }}>
				<div class="pophead">
					<span class="serif">Zotero</span>
					{#if zotero.settings && !zoteroSetup}
						<button class="mini" onclick={() => (zoteroSetup = true)} title="Change the API key or file storage">{zotero.settings.username || 'Library'} · {zotero.settings.webdav ? 'WebDAV' : 'Zotero storage'}</button>
					{/if}
				</div>
				{#if !account.signedIn}
					<p class="fine">Zotero goes through this server (your browser can't reach Zotero's files directly), so it needs an account: just a name and a password.</p>
					<form
						class="stack"
						onsubmit={async (e) => {
							e.preventDefault();
							keepForm.busy = true;
							keepForm.error = '';
							try {
								await account.signIn(keepForm.name, keepForm.password, false);
								if (zotero.settings) void findInZotero();
							} catch (err) {
								keepForm.error = err instanceof Error ? err.message : 'Something went wrong.';
							} finally {
								keepForm.busy = false;
							}
						}}
					>
						<input class="input" bind:value={keepForm.name} placeholder="Name" autocomplete="username" autocapitalize="none" spellcheck="false" required />
						<input class="input" type="password" bind:value={keepForm.password} placeholder="Password" autocomplete="current-password" required />
						{#if keepForm.error}<p class="err-dark">{keepForm.error}</p>{/if}
						<button class="btn primary" disabled={keepForm.busy}>Sign in</button>
					</form>
				{:else if zoteroSetup}
					<ZoteroConnect
						oncancel={() => (zoteroSetup = false)}
						onconnected={() => {
							zoteroSetup = false;
							zoteroItems = null;
							void findInZotero();
						}}
						ondisconnect={() => (zoteroItems = null)}
					/>
				{:else if zoteroOpen}
					<button class="mini back" onclick={() => (zoteroOpen = null)}>← {zoteroOpen.item.title}</button>
					<ul class="zlist">
						{#each zoteroOpen.pdfs as p (p.key)}
							<li><button onclick={() => importFromZotero(zoteroOpen!.item, p)}><span class="zt">{p.title || p.filename}</span><span class="kicker">{p.filename}</span></button></li>
						{/each}
					</ul>
				{:else}
					<input class="input" bind:value={zoteroQuery} oninput={onZoteroQuery} placeholder="Search title, author, year" autocomplete="off" spellcheck="false" />
					{#if zoteroItems === null}
						<p class="fine">Searching…</p>
					{:else if zoteroItems.length === 0}
						<p class="fine">Nothing found.</p>
					{:else}
						<ul class="zlist">
							{#each zoteroItems as it (it.key)}
								<li>
									<button onclick={() => pickZoteroItem(it)} disabled={it.children === 0}>
										<span class="zt">{it.title || 'Untitled'}</span>
										<span class="kicker">{[it.creators, it.year].filter(Boolean).join(' · ') || ' '}</span>
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
				{#if zoteroError}<p class="err-dark">{zoteroError}</p>{/if}
			</div>
		{:else if pop === 'keep'}
			<form
				style={popStyle}
				class="pop corner-pop keep"
				data-pop
				transition:scale={{ start: 0.96, duration: 160 }}
				onsubmit={(e) => {
					e.preventDefault();
					void keepNote('in');
				}}
			>
				<div class="pophead">
					<span class="serif">Keep this note</span>
				</div>
				<p class="fine">Sign in, or make an account (just a name and a password), and this note is kept in it: it stays after everyone leaves, and you can open it from any device.</p>
				<input class="input" bind:value={keepForm.name} placeholder="Name" autocomplete="username" autocapitalize="none" spellcheck="false" required />
				<input class="input" type="password" bind:value={keepForm.password} placeholder="Password" autocomplete="current-password" required />
				{#if keepForm.error}<p class="err-dark">{keepForm.error}</p>{/if}
				<div class="row2">
					<button class="btn primary" disabled={keepForm.busy}>Sign in &amp; keep</button>
					<button type="button" class="btn" disabled={keepForm.busy || !keepForm.name || !keepForm.password} onclick={() => keepNote('create')}
						>New account</button
					>
				</div>
			</form>
		{:else if pop === 'more'}
			<div style={popStyle} class="pop corner-pop menu" data-pop transition:scale={{ start: 0.96, duration: 160 }}>
				<span class="kicker sect">Document</span>
				{#if owner && !entry.owned}
					<button
						class="item"
						data-pop
						onclick={(e) => (account.signedIn ? keepNote() : toggle('keep', e))}
						title="Keep this note in your account: it stays after everyone leaves, and you can open and manage it from any device"
					>
						<Icon name="check" size={18} /><span>Keep in my account</span><span class="kicker" class:warnlit={entry.saved === false}
							>{entry.saved === false ? 'unsaved' : 'this device only'}</span
						>
					</button>
				{:else if entry.saved === false}
					<div class="item static" title="Whoever created it didn't keep it in an account">
						<Icon name="x" size={18} /><span>Not kept</span><span class="kicker warnlit">ends when all leave</span>
					</div>
				{/if}
				{#if canEdit}
					<button
						class="item"
						disabled={pdfBusy !== ''}
						onclick={() => {
							pop = '';
							pdfInput?.click();
						}}
					>
						<Icon name="fileUp" size={18} /><span>Import PDF</span><span class="kicker">adds pages</span>
					</button>
				{/if}
				<button class="item" disabled={pdfBusy !== ''} onclick={exportPdf}>
					<Icon name="fileDown" size={18} /><span>Export PDF</span><span class="kicker">with ink</span>
				</button>
				{#if canEdit}
					<button class="item" data-pop disabled={pdfBusy !== ''} onclick={openZotero}>
						<Icon name="book" size={18} /><span>From Zotero</span><span class="kicker">open a paper</span>
					</button>
				{/if}
				<button
					class="item"
					data-pop
					disabled={pdfBusy !== ''}
					onclick={saveToZotero}
					title="Save the note as a PDF in your Zotero library, editable again when opened here"
				>
					<Icon name="bookUp" size={18} /><span>Save to Zotero</span><span class="kicker"
						>{noteStore.zotero?.saved && noteStore.zotero.library === zotero.settings?.userId ? 'update' : noteStore.zotero?.parent ? 'attach' : 'new'}</span
					>
				</button>
				{#if noteStore.pages.length > 0}
					<span class="kicker sect">Pages</span>
					{#if canEdit}
						<button
							class="item"
							onclick={() => noteStore.setLayout(noteStore.layout === 'vertical' ? 'horizontal' : 'vertical')}
							title="Which way pages run, for everyone on this note. Added pages sit beside their page."
						>
							<Icon name={noteStore.layout === 'vertical' ? 'rows' : 'columns'} size={18} /><span>Layout</span><span
								class="kicker">{noteStore.layout === 'vertical' ? 'top to bottom' : 'side by side'}</span
							>
						</button>
					{/if}
					<button class="item" onclick={toggleSnap} title="When scrolling stops, glide to the nearest page edge (this device only)">
						<Icon name="magnet" size={18} /><span>Snap to pages</span><span class="kicker" class:lit={snap}>{snap ? 'on' : 'off'}</span>
					</button>
				{/if}
				<span class="kicker sect">Screen</span>
				<button class="item" onclick={() => setCustomizing(true)} title="Move the bars to other edges and corners, join them, tuck them away (this device)">
					<Icon name="layout" size={18} /><span>Customize bars</span><span class="kicker">move · join</span>
				</button>
				{#if canEdit}
					<span class="kicker sect">Ink</span>
					<button
						class="item"
						onclick={toggleFinger}
						title="One finger draws with the tool (phones), or moves the page (tablets with a pen). Two fingers always move and zoom."
					>
						<Icon name="hand" size={18} /><span>One finger</span><span class="kicker" class:lit={fingerInks}
							>{fingerInks ? 'draws' : 'moves'}</span
						>
					</button>
					<div class="item static" title="What a pen does while its side button is held as it touches the screen (this device). The eraser end of a pen always erases.">
						<Icon name="pen" size={18} /><span>Pen button</span>
						<span class="choice" role="radiogroup" aria-label="Pen button">
							{#each PEN_BUTTON as b (b.id)}
								<button
									role="radio"
									aria-checked={penButton === b.id}
									aria-label={b.label}
									title={b.label}
									class:on={penButton === b.id}
									onclick={() => setPenButton(b.id)}
								>
									<Icon name={b.icon} size={15} />
								</button>
							{/each}
						</span>
					</div>
					<button class="item" onclick={() => (mode = mode === 'draw' ? 'observe' : 'draw')} title="Look only: pen and mouse move the view instead of drawing">
						<Icon name="eye" size={18} /><span>Look only</span><span class="kicker" class:lit={mode === 'observe'}
							>{mode === 'observe' ? 'on' : 'off'}</span
						>
					</button>
					<button
						class="item"
						disabled={noteStore.strokeCount + noteStore.textCount === 0}
						onclick={() => {
							noteStore.clear();
							pop = '';
						}}
					>
						<Icon name="trash" size={18} /><span>Clear all ink</span><span class="kicker">undo-able</span>
					</button>
				{/if}
				{#if owner}
					<span class="kicker sect">Owner</span>
					<button
						class="item"
						onclick={() => {
							showSettings = true;
							pop = '';
						}}
					>
						<Icon name="sliders" size={18} /><span>Passcodes &amp; access</span>
					</button>
				{/if}
				<p class="fine kicker keys">
					{#if canEdit}<span>P B M E L H — tools · Ctrl Z — undo</span>{/if}
					<span>F — focus · 1 — fit · 0 — 100% · ± — zoom</span>
				</p>
				<p class="fine kicker build">conote · build {__BUILD_ID__}</p>
			</div>
		{/if}
	{/if}

	{#if canEdit}
		<input type="file" accept="application/pdf,.pdf" hidden bind:this={pdfInput} onchange={importPdf} />
	{/if}

	<!-- Customising the bars: where a dragged bar would land. -->
	{#if customizing && !focus}
		<div class="zones" class:dragging={drag !== null}>
			{#each ANCHORS as a (a)}
				<div class="zone {a}" class:hot={drag?.to === a} class:off={drag !== null && !fits(drag.id, a)}>
					<span class="kicker">{ANCHOR_NAMES[a]}</span>
				</div>
			{/each}
		</div>
		{#if drag}
			{#if drag.caret}
				<div class="caret" style:left="{drag.caret.x}px" style:top="{drag.caret.y}px" style:width="{drag.caret.w}px" style:height="{drag.caret.h}px"></div>
			{/if}
			<div class="ghost kicker" style:left="{drag.x}px" style:top="{drag.y}px">
				{BAR_NAMES[drag.id]}{drag.to ? ` → ${ANCHOR_NAMES[drag.to]}` : ''}
			</div>
		{/if}
	{/if}

	<!-- Focus mode: one quiet bar that comes and goes with movement. -->
	{#if focus && focusBar}
		<div
			class="chrome focusbar"
			role="toolbar"
			tabindex="-1"
			aria-label="Focus mode"
			transition:fly={{ y: 20, duration: 240 }}
			onpointerenter={() => {
				overFocusBar = true;
				clearTimeout(focusBarTimer);
			}}
			onpointerleave={() => {
				overFocusBar = false;
				revealFocusBar();
			}}
		>
			<span class="fname">
				<span class="dot" data-status={noteStore.status}></span>
				<span class="serif">{entry.name}</span>
			</span>
			<span class="vr"></span>
			<span class="kicker dim">Follow</span>
			<div class="chips">
				<button class="chip" class:on={follow === 'drawing'} onclick={() => followWho('drawing')}>Whole note</button>
				{#each noteStore.presence as p (p.id)}
					<button class="chip" class:on={follow === p.id} onclick={() => followWho(p.id)} disabled={!p.view}>
						<span class="pip" style:background={p.color}></span>{p.label || 'Someone'}
					</button>
				{/each}
			</div>
			<span class="vr"></span>
			<button class="exit" onclick={() => setFocus(false)} title="Leave focus mode (Esc)">
				<span class="kicker">Exit</span><Icon name="x" size={16} />
			</button>
		</div>
	{/if}

	<!-- Notices, top centre. -->
	<div class="notices" aria-live="polite" style:--toprow="{focus ? 0 : rows.height.top}px">
		{#if customizing && !focus}
			<div class="notice custom" role="status" transition:fly={{ y: -12, duration: 220 }}>
				<span class="kicker lime">Bars</span>
				<span>Drag a bar to an edge or corner, or onto another bar to join them. The little arrow on each tucks it away.</span>
				<span class="row">
					<button class="mini" onclick={() => bars.reset()}>Reset</button>
					<button class="mini lime" onclick={() => setCustomizing(false)}>Done</button>
				</span>
			</div>
		{/if}
		{#if pulledBy}
			<div class="notice" role="status" transition:fly={{ y: -12, duration: 220 }}>
				<span class="pip" style:background={pulledBy.color}></span>
				<span><b>{pulledBy.label}</b> brought you to their view</span>
			</div>
		{/if}
		{#if penNotice}
			<div class="notice" role="status" transition:fly={{ y: -12, duration: 220 }}>
				<span class="kicker lime">Pen</span>
				<span>Pen found: it draws, one finger now moves the page.</span>
				<button class="mini" onclick={toggleFinger}>Fingers draw</button>
			</div>
		{/if}
		{#if pdfBusy}
			<div class="notice" role="status" transition:fly={{ y: -12, duration: 220 }}>
				<span class="spinner"></span>
				<span>{BUSY_TEXT[pdfBusy]}</span>
			</div>
		{/if}
		{#if zoteroDone}
			<div class="notice" role="status" transition:fly={{ y: -12, duration: 220 }}>
				<span class="kicker lime">Zotero</span>
				<span>{zoteroDone}</span>
			</div>
		{/if}
		{#if pdfError}
			<div class="notice warn" transition:fly={{ y: -12, duration: 220 }}>
				<span class="kicker">PDF</span>
				<span>{pdfError}</span>
				<button class="mini" onclick={() => (pdfError = '')}>OK</button>
			</div>
		{/if}
		{#if noteStore.access === 'ended'}
			<div class="notice warn" transition:fly={{ y: -12, duration: 220 }}>
				<span class="kicker">Ended</span>
				<span>This note wasn't kept in an account, so it ended when everyone had left. You're looking at this device's last copy.</span>
				<button class="mini" disabled={pdfBusy !== ''} onclick={exportPdf}>Export PDF</button>
				<button class="mini" onclick={forgetDeleted}>Forget it</button>
			</div>
		{:else if noteStore.access === 'gone'}
			<div class="notice warn" transition:fly={{ y: -12, duration: 220 }}>
				<span class="kicker">Deleted</span>
				<span>The owner deleted this note. You're looking at this device's last copy.</span>
				<button class="mini" onclick={forgetDeleted}>Forget it</button>
			</div>
		{:else if noteStore.access === 'revoked' && !owner}
			<form class="notice warn rejoin" onsubmit={rejoin} transition:fly={{ y: -12, duration: 220 }}>
				<span class="kicker">Locked</span>
				<span>The passcodes changed. Enter the new one to reconnect.</span>
				<span class="row">
					<input class="input" type="password" bind:value={rejoinPasscode} placeholder="Passcode" autocomplete="off" />
					<button class="mini lime" disabled={rejoining}>Reconnect</button>
				</span>
				{#if rejoinError}<span class="err">{rejoinError}</span>{/if}
			</form>
		{/if}
	</div>
</div>

{#if showSettings && owner}
	<NoteSettings {entry} onclose={() => (showSettings = false)} ondeleted={onleave} />
{/if}

<style>
	.app {
		--gap: 12px;
		--top: max(var(--gap), env(safe-area-inset-top));
		--left: max(var(--gap), env(safe-area-inset-left));
		--right: max(var(--gap), env(safe-area-inset-right));
		--bottom: max(var(--gap), env(safe-area-inset-bottom));
		position: relative;
		height: 100%;
		overflow: hidden;
	}
	.stage {
		position: absolute;
		inset: 0;
	}
	.app.idle .stage :global(canvas) {
		cursor: none !important;
	}

	/* --- Floating chrome: ink capsules over the paper ---------------------- */

	.chrome {
		position: absolute;
		z-index: 3;
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 4px;
		background: var(--ink);
		color: var(--chalk);
		border-radius: var(--r-chip);
		box-shadow: var(--shadow-float);
		/* coming back after a stroke: wait a moment, then ease in */
		transition: opacity 0.45s var(--ease-out) 0.55s;
	}
	/* While the pen is down the chrome steps back (and lets the pen through). */
	.app.inking .chrome:not(.focusbar) {
		opacity: 0.1;
		pointer-events: none;
		transition: opacity 0.2s ease 0.15s;
	}

	.ibtn,
	.tool,
	.ink,
	.preset,
	.pct,
	.word,
	.people,
	.exit {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		height: 40px;
		min-width: 40px;
		padding: 0 0.6rem;
		border: none;
		border-radius: 12px;
		background: transparent;
		color: inherit;
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s,
			transform 0.12s var(--ease-out);
	}
	.ibtn {
		padding: 0;
	}
	:is(.ibtn, .tool, .ink, .pct, .word, .people, .exit):hover:not(:disabled),
	.rail .preset:hover {
		background: var(--ink-3);
	}
	:is(.ibtn, .tool, .ink, .preset, .pct, .word, .people, .exit):active:not(:disabled) {
		transform: scale(0.94);
	}
	:is(.ibtn, .tool, .word, .people).on,
	:is(.ibtn, .tool, .word, .people).on:hover {
		background: var(--lime);
		color: var(--ink);
	}
	button:disabled {
		opacity: 0.32;
		cursor: default;
	}
	.vr {
		width: 1px;
		align-self: stretch;
		margin: 8px 4px;
		background: rgb(244 240 231 / 0.14);
	}
	.hr {
		height: 1px;
		align-self: stretch;
		margin: 4px 8px;
		background: rgb(244 240 231 / 0.14);
	}
	.serif {
		font-family: var(--f-serif);
		font-style: italic;
		font-weight: 400;
		letter-spacing: 0.005em;
	}

	/* --- Bars: rows along the top and bottom, columns on the sides ------------ */

	/* Rows are placed by hand (see \`rows\`); a row itself takes no input. */
	.edge {
		position: absolute;
		z-index: 3;
		left: var(--left);
		right: var(--right);
		height: 0;
		pointer-events: none;
	}
	.edge.top {
		top: var(--top);
	}
	.edge.bottom {
		bottom: var(--bottom);
	}
	.edge > .group {
		width: max-content;
	}
	.side {
		position: absolute;
		z-index: 3;
		top: var(--top);
		bottom: var(--bottom);
		display: flex;
		flex-direction: column;
		justify-content: center;
		pointer-events: none;
	}
	.side.left {
		left: var(--left);
	}
	.side.right {
		right: var(--right);
	}
	.side > .group {
		position: relative;
	}
	.group {
		pointer-events: auto;
	}
	.app.inking .group {
		pointer-events: none;
	}
	.group.col {
		flex-direction: column;
		border-radius: 20px;
	}
	/* The bars inside a capsule (not app.css's .seg). */
	.bar {
		display: flex;
		align-items: center;
		gap: 2px;
		min-width: 0;
	}
	.bar.col {
		flex-direction: column;
	}
	.join.vr {
		margin: 6px 5px;
		background: rgb(244 240 231 / 0.24);
	}
	.join.hr {
		margin: 5px 6px;
		background: rgb(244 240 231 / 0.24);
	}
	/* The tab that tucks a capsule away: slim, out of the way. */
	.tuck {
		display: grid;
		place-items: center;
		flex: none;
		width: 18px;
		height: 40px;
		padding: 0;
		border: none;
		border-radius: 10px;
		background: transparent;
		color: var(--graphite);
		cursor: pointer;
		transition:
			color 0.15s,
			background 0.15s;
	}
	.group.col .tuck {
		width: 40px;
		height: 18px;
	}
	.tuck:hover {
		color: var(--chalk);
		background: var(--ink-3);
	}

	/* A tucked-away capsule: a quarter circle in its corner, a tab on its edge. */
	.tucked {
		padding: 0;
		border: none;
		border-radius: 0;
		cursor: pointer;
		--sl: env(safe-area-inset-left);
		--sr: env(safe-area-inset-right);
		--st: env(safe-area-inset-top);
		--sb: env(safe-area-inset-bottom);
	}
	.mark {
		position: absolute;
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
	}
	.mark .dot {
		width: 10px;
		height: 10px;
	}
	.tucked.quarter {
		width: 54px;
		height: 54px;
	}
	.tucked.top-start {
		top: 0;
		left: 0;
		width: calc(54px + var(--sl));
		height: calc(54px + var(--st));
		border-bottom-right-radius: 100%;
		transform-origin: top left;
	}
	.tucked.top-end {
		top: 0;
		right: 0;
		width: calc(54px + var(--sr));
		height: calc(54px + var(--st));
		border-bottom-left-radius: 100%;
		transform-origin: top right;
	}
	.tucked.bottom-start {
		bottom: 0;
		left: 0;
		width: calc(54px + var(--sl));
		height: calc(54px + var(--sb));
		border-top-right-radius: 100%;
		transform-origin: bottom left;
	}
	.tucked.bottom-end {
		bottom: 0;
		right: 0;
		width: calc(54px + var(--sr));
		height: calc(54px + var(--sb));
		border-top-left-radius: 100%;
		transform-origin: bottom right;
	}
	.tucked.top-start .mark {
		top: calc(var(--st) + 13px);
		left: calc(var(--sl) + 13px);
	}
	.tucked.top-end .mark {
		top: calc(var(--st) + 13px);
		right: calc(var(--sr) + 13px);
	}
	.tucked.bottom-start .mark {
		bottom: calc(var(--sb) + 13px);
		left: calc(var(--sl) + 13px);
	}
	.tucked.bottom-end .mark {
		bottom: calc(var(--sb) + 13px);
		right: calc(var(--sr) + 13px);
	}
	.tucked.top-center,
	.tucked.bottom-center {
		left: 50%;
		translate: -50% 0;
		width: 60px;
	}
	.tucked.top-center {
		top: 0;
		height: calc(24px + var(--st));
		border-radius: 0 0 14px 14px;
		transform-origin: top center;
	}
	.tucked.bottom-center {
		bottom: 0;
		height: calc(24px + var(--sb));
		border-radius: 14px 14px 0 0;
		transform-origin: bottom center;
	}
	.tucked.top-center .mark {
		bottom: 3px;
		left: calc(50% - 9px);
	}
	.tucked.bottom-center .mark {
		top: 3px;
		left: calc(50% - 9px);
	}
	.tucked.left,
	.tucked.right {
		top: 50%;
		translate: 0 -50%;
		height: 60px;
	}
	.tucked.left {
		left: 0;
		width: calc(24px + var(--sl));
		border-radius: 0 14px 14px 0;
		transform-origin: center left;
	}
	.tucked.right {
		right: 0;
		width: calc(24px + var(--sr));
		border-radius: 14px 0 0 14px;
		transform-origin: center right;
	}
	.tucked.left .mark {
		right: 3px;
		top: calc(50% - 9px);
	}
	.tucked.right .mark {
		left: 3px;
		top: calc(50% - 9px);
	}
	.tucked:hover {
		background: var(--ink-2);
	}

	/* Customising: every bar is a handle; the screen shows where it can go. */
	.app.customizing .bar {
		cursor: grab;
		border-radius: 12px;
		outline: 1.5px dashed rgb(214 242 75 / 0.55);
		outline-offset: -1px;
		touch-action: none;
	}
	.app.customizing .bar > * {
		pointer-events: none;
	}
	.bar.dragging {
		opacity: 0.35;
	}
	.zones {
		position: absolute;
		inset: 0;
		z-index: 2;
		display: grid;
		grid-template: repeat(3, 1fr) / repeat(3, 1fr);
		gap: 6px;
		padding: 6px;
		background: rgb(25 24 20 / 0.08);
	}
	.zones.dragging {
		cursor: grabbing;
	}
	.zone {
		display: grid;
		place-items: center;
		border: 1.5px dashed rgb(25 24 20 / 0.18);
		border-radius: 18px;
		color: var(--graphite);
		transition:
			background 0.15s,
			border-color 0.15s,
			opacity 0.15s;
	}
	.zone .kicker {
		opacity: 0;
		transition: opacity 0.15s;
	}
	.zones.dragging .zone .kicker {
		opacity: 0.8;
	}
	.zone.top-start {
		grid-area: 1 / 1;
	}
	.zone.top-center {
		grid-area: 1 / 2;
	}
	.zone.top-end {
		grid-area: 1 / 3;
	}
	.zone.left {
		grid-area: 2 / 1;
	}
	.zone.right {
		grid-area: 2 / 3;
	}
	.zone.bottom-start {
		grid-area: 3 / 1;
	}
	.zone.bottom-center {
		grid-area: 3 / 2;
	}
	.zone.bottom-end {
		grid-area: 3 / 3;
	}
	.zone.hot {
		background: rgb(214 242 75 / 0.28);
		border-color: var(--lime-deep);
		color: var(--ink);
	}
	.zone.off {
		opacity: 0.3;
	}
	.caret {
		position: absolute;
		z-index: 6;
		border-radius: 2px;
		background: var(--lime);
		box-shadow: 0 0 0 1px var(--ink);
		pointer-events: none;
	}
	.ghost {
		position: absolute;
		z-index: 6;
		translate: 14px 14px;
		padding: 0.45rem 0.75rem;
		border-radius: 999px;
		background: var(--lime);
		color: var(--ink);
		box-shadow: var(--shadow-float);
		white-space: nowrap;
		pointer-events: none;
	}

	.masthead {
		padding-right: 0.6rem;
		gap: 0.35rem;
		min-width: 48px;
		max-width: 24rem;
	}
	.ident {
		display: flex;
		flex-direction: column;
		min-width: 0;
		overflow: hidden;
		line-height: 1.05;
	}
	.name {
		font-family: var(--f-serif);
		font-style: italic;
		font-size: 1.4rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.6rem;
		color: var(--smoke);
		margin-top: 0.15rem;
	}
	.role[data-role='owner'] {
		color: var(--lime);
	}
	.sep {
		opacity: 0.4;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--smoke);
		flex: none;
	}
	.dot[data-status='connected'] {
		background: var(--lime);
		box-shadow: 0 0 0 3px rgb(214 242 75 / 0.18);
	}
	.dot[data-status='connecting'] {
		background: var(--amber);
		animation: pulse 1.2s ease-in-out infinite;
	}
	.dot[data-status='disconnected'] {
		background: var(--vermilion);
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}

	.people {
		padding: 0 0.6rem 0 0.55rem;
	}
	.faces {
		display: flex;
	}
	.bead {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		box-shadow: 0 0 0 2px var(--ink);
	}
	.bead + .bead {
		margin-left: -4px;
	}
	.people.on .bead {
		box-shadow: 0 0 0 2px var(--lime);
	}
	.face {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		font-family: var(--f-mono);
		font-size: 0.68rem;
		font-weight: 500;
		color: #fff;
		flex: none;
	}
	.count {
		font-family: var(--f-mono);
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
	}

	/* Tools */
	.tool {
		position: relative;
		width: 44px;
		height: 44px;
		padding: 0;
		border-radius: 14px;
	}
	.tip {
		position: absolute;
		right: 7px;
		bottom: 7px;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		box-shadow: 0 0 0 1.5px var(--ink);
	}
	.tool.on .tip {
		box-shadow: 0 0 0 1.5px var(--lime);
	}
	.ink {
		width: 44px;
		height: 44px;
		padding: 0;
		border-radius: 14px;
	}
	.ink.on {
		background: var(--ink-3);
	}
	/* The current ink on a little dish of paper, so any colour shows. */
	.dish {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		background: var(--paper);
	}
	.blob {
		width: var(--w);
		height: var(--w);
		border-radius: 50%;
		box-shadow: inset 0 0 0 1px rgb(25 24 20 / 0.18);
		transition:
			width 0.15s,
			height 0.15s;
	}
	@media (max-height: 560px) {
		.rail.col :is(.tool, .ink) {
			width: 36px;
			height: 34px;
		}
	}
	/* Phones: a row of tools narrows to fit 360px; the zoom bar drops ±
	   (that's what pinching is for). */
	@media (max-width: 600px) {
		.rail:not(.col) {
			gap: 1px;
		}
		/* ten buttons share what's left of the width */
		.rail:not(.col) :is(.tool, .ink) {
			width: clamp(24px, calc((100vw - 92px) / 10), 36px);
			min-width: 0;
			height: 42px;
			border-radius: 12px;
		}
		.rail:not(.col) .vr {
			margin: 8px 3px;
		}
		.zoombar .pm {
			display: none;
		}
		.group:not(.col) .tuck {
			width: 14px;
		}
	}
	@media (max-width: 380px) {
		.rail:not(.col) .vr {
			margin-inline: 1px;
		}
		.group:not(.col) :is(.ibtn, .people) {
			min-width: 34px;
		}
		.group:not(.col) .tuck {
			width: 12px;
		}
	}
	.lookonly {
		gap: 0.6rem;
		padding-left: 0.6rem;
		color: var(--smoke);
	}

	/* Zoom bar */
	.pct {
		min-width: 3.6rem;
		padding: 0 0.3rem;
		font-family: var(--f-mono);
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}
	.pct small {
		font-size: 0.65rem;
		opacity: 0.55;
		margin-left: 1px;
	}
	.word {
		font-family: var(--f-mono);
		font-size: 0.72rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		padding: 0 0.75rem;
	}
	.zoombar.col .word {
		padding: 0 0.5rem;
		font-size: 0.64rem;
	}
	.pip {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: none;
	}

	/* Saved inks: on the rail, and in the ink panel with a way to forget them */
	.preset {
		display: grid;
		width: 40px;
		height: 40px;
		padding: 0;
		border-radius: 14px;
	}
	.preset .dish {
		width: 28px;
		height: 28px;
		/* white ink on paper needs an edge */
		filter: drop-shadow(0 0 0.6px rgb(25 24 20 / 0.55));
	}
	.preset.on .dish {
		box-shadow: 0 0 0 2px var(--lime);
	}
	@media (max-height: 700px) {
		.rail.col .preset {
			width: 34px;
			height: 32px;
		}
	}
	.saved {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
	}
	.chip {
		position: relative;
	}
	.saved .preset .dish {
		width: 34px;
		height: 34px;
		background: var(--paper-2);
	}
	.saved .preset.on .dish {
		box-shadow:
			0 0 0 2px var(--sheet),
			0 0 0 4px var(--ink);
	}
	.unsave {
		position: absolute;
		top: -3px;
		right: -3px;
		display: grid;
		place-items: center;
		width: 16px;
		height: 16px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: var(--sheet);
		color: var(--ink);
		box-shadow: 0 0 0 1px rgb(25 24 20 / 0.25);
		cursor: pointer;
	}
	.save:disabled {
		opacity: 0.5;
		cursor: default;
	}

	/* Small text buttons inside panels and notices */
	.mini {
		font-family: var(--f-mono);
		font-size: 0.68rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		border: none;
		border-radius: 999px;
		padding: 0.4rem 0.75rem;
		background: rgb(127 120 105 / 0.18);
		color: inherit;
		cursor: pointer;
		white-space: nowrap;
	}
	.mini.lime {
		background: var(--lime);
		color: var(--ink);
	}

	/* --- Panels -------------------------------------------------------------- */

	.pop {
		position: absolute;
		z-index: 4;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		background: var(--sheet);
		color: var(--ink);
		border-radius: 22px;
		box-shadow: var(--shadow-card), 0 0 0 1px var(--rule);
		cursor: default;
		/* placed by popStyle, off the button that opened it */
		width: var(--pw);
		overflow-y: auto;
		touch-action: pan-y;
	}
	.corner-pop {
		--pw: min(22rem, calc(100% - 2 * var(--gap)));
	}
	.pophead {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}
	.pophead .serif {
		font-size: 1.6rem;
		line-height: 1;
	}
	.pophead .kicker {
		color: var(--graphite);
	}
	.fine {
		margin: 0;
		color: var(--graphite);
		font-size: 0.8rem;
		line-height: 1.4;
	}
	.fine.kicker {
		font-size: 0.6rem;
		line-height: 1.6;
	}

	.inkpop {
		--pw: min(15.5rem, calc(100% - 2 * var(--gap)));
	}
	@media (max-width: 600px) {
		.inkpop {
			--pw: min(19rem, calc(100% - 2 * var(--gap)));
		}
	}
	.preview {
		width: 100%;
		height: 70px;
		background:
			radial-gradient(circle, rgb(52 44 28 / 0.2) 1px, transparent 1.3px) 0 0 / 14px 14px,
			var(--paper);
		border-radius: 14px;
	}
	.size {
		-webkit-appearance: none;
		appearance: none;
		width: 100%;
		height: 28px;
		background: transparent;
		cursor: pointer;
	}
	.size::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 2px;
		background: var(--paper-2);
	}
	.size::-moz-range-track {
		height: 4px;
		border-radius: 2px;
		background: var(--paper-2);
	}
	.size::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 22px;
		height: 22px;
		margin-top: -9px;
		border-radius: 50%;
		background: var(--ink);
		border: 3px solid var(--lime);
	}
	.size::-moz-range-thumb {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--ink);
		border: 3px solid var(--lime);
	}
	.swatches {
		display: grid;
		grid-template-columns: repeat(9, 1fr);
		gap: 4px;
	}
	.swatch {
		aspect-ratio: 1;
		border: none;
		border-radius: 50%;
		background: var(--c);
		box-shadow: inset 0 0 0 1px rgb(25 24 20 / 0.15);
		cursor: pointer;
		transition: transform 0.15s var(--ease-out);
	}
	.swatch:hover {
		transform: scale(1.12);
	}
	.swatch.on {
		box-shadow:
			inset 0 0 0 1px rgb(25 24 20 / 0.15),
			0 0 0 2px var(--sheet),
			0 0 0 4px var(--ink);
	}

	.who {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.who li {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0.5rem 0;
		border-top: 1px dashed var(--rule);
	}
	.who li:first-child {
		border-top: none;
	}
	.who .face {
		box-shadow: none;
		width: 28px;
		height: 28px;
	}
	.face.me {
		background: var(--ink);
		color: var(--lime);
	}
	.wl {
		flex: 1;
		min-width: 0;
		font-size: 0.92rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.wl .kicker {
		color: var(--graphite);
		margin-left: 0.3rem;
	}
	.switch {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		font-size: 0.9rem;
		cursor: pointer;
	}
	.switch input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.track {
		position: relative;
		flex: none;
		width: 38px;
		height: 22px;
		border-radius: 11px;
		background: var(--paper-2);
		transition: background 0.2s;
	}
	.track::after {
		content: '';
		position: absolute;
		top: 3px;
		left: 3px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--sheet);
		box-shadow: 0 1px 3px rgb(25 24 20 / 0.3);
		transition: transform 0.2s var(--ease-out);
	}
	.switch input:checked + .track {
		background: var(--ink);
	}
	.switch input:checked + .track::after {
		transform: translateX(16px);
		background: var(--lime);
	}
	.switch input:focus-visible + .track {
		outline: 2px solid var(--lime-deep);
		outline-offset: 2px;
	}
	.wide {
		width: 100%;
	}

	/* Share: a ticket stub */
	.ticketwrap {
		padding: 0;
		background: none;
		box-shadow: none;
		overflow: visible;
		filter: drop-shadow(0 18px 22px rgb(52 44 28 / 0.25)) drop-shadow(0 1px 2px rgb(52 44 28 / 0.25));
	}
	/* Two half-moon notches where the stub tears off. */
	.ticket {
		display: flex;
		flex-direction: column;
		background: var(--sheet);
		border-radius: 22px;
		overflow: hidden;
		-webkit-mask:
			radial-gradient(circle at 0 93px, transparent 9px, #000 9.5px) left / 51% 100% no-repeat,
			radial-gradient(circle at 100% 93px, transparent 9px, #000 9.5px) right / 51% 100% no-repeat;
		mask:
			radial-gradient(circle at 0 93px, transparent 9px, #000 9.5px) left / 51% 100% no-repeat,
			radial-gradient(circle at 100% 93px, transparent 9px, #000 9.5px) right / 51% 100% no-repeat;
	}
	.stub {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		height: 93px;
		justify-content: center;
		padding: 0 1.25rem;
		background: var(--lime);
		margin: 0;
	}
	.stub .kicker {
		color: rgb(25 24 20 / 0.6);
	}
	.stub .big {
		font-size: 2rem;
		line-height: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.perf {
		height: 0;
		margin: 0 16px;
		border-top: 2px dashed var(--rule);
	}
	.ticket .row {
		display: flex;
		gap: 0.5rem;
		padding: 1rem 1.25rem 0.6rem;
	}
	.ticket .row .btn {
		padding: 0.6rem 1rem;
		font-size: 0.85rem;
	}
	.ticket .fine {
		padding: 0 1.25rem 1.2rem;
	}

	/* More menu */
	.menu {
		gap: 2px;
		padding: 0.6rem;
	}
	.sect {
		color: var(--graphite);
		font-size: 0.6rem;
		padding: 0.75rem 0.6rem 0.3rem;
	}
	.sect:first-child {
		padding-top: 0.3rem;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.65rem 0.6rem;
		border: none;
		border-radius: 12px;
		background: transparent;
		text-align: left;
		font-size: 0.95rem;
		cursor: pointer;
		color: var(--ink);
	}
	.item:hover:not(:disabled) {
		background: var(--paper);
	}
	.item > span:nth-of-type(1) {
		flex: 1;
	}
	.item .kicker {
		color: var(--graphite);
		font-size: 0.6rem;
	}
	.item.static {
		cursor: default;
	}
	.item.static:hover {
		background: transparent;
	}
	/* A row of small icon choices at the end of a menu item. */
	.choice {
		display: flex;
		gap: 2px;
		padding: 2px;
		border-radius: 999px;
		background: var(--paper-2);
	}
	.choice button {
		display: grid;
		place-items: center;
		width: 28px;
		height: 26px;
		padding: 0;
		border: none;
		border-radius: 999px;
		background: transparent;
		color: var(--graphite);
		cursor: pointer;
	}
	.choice button:hover {
		color: var(--ink);
	}
	.choice button.on {
		background: var(--lime);
		color: var(--ink);
	}
	.item .kicker.warnlit {
		color: var(--ink);
		background: var(--amber);
		padding: 0.15rem 0.45rem;
		border-radius: 999px;
	}
	.unsaved {
		color: var(--amber);
	}
	.stack {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.zotero .seg {
		background: var(--paper-2);
	}
	.mono {
		font-family: var(--f-mono);
		font-size: 0.85em;
	}
	.zotero .back {
		align-self: flex-start;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.zlist {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		max-height: 22rem;
		overflow-y: auto;
		touch-action: pan-y;
	}
	.zlist button {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.2rem;
		width: 100%;
		padding: 0.55rem 0.5rem;
		border: none;
		border-top: 1px dashed var(--rule);
		background: none;
		text-align: left;
		cursor: pointer;
		border-radius: 8px;
	}
	.zlist li:first-child button {
		border-top: none;
	}
	.zlist button:hover:not(:disabled) {
		background: var(--paper);
	}
	.zt {
		font-size: 0.9rem;
		line-height: 1.25;
	}
	.zlist .kicker {
		color: var(--graphite);
		font-size: 0.58rem;
	}
	.zotero .row2,
	.keep .row2 {
		display: flex;
		gap: 0.5rem;
	}
	.keep .row2 .btn {
		flex: 1;
		padding: 0.65rem 0.8rem;
		font-size: 0.88rem;
	}
	.keep .input {
		padding: 0.55rem 0.75rem;
		font-size: 0.95rem;
	}
	.err-dark {
		margin: 0;
		color: #c2381a;
		font-size: 0.82rem;
	}
	.item .kicker.lit {
		color: var(--ink);
		background: var(--lime);
		padding: 0.15rem 0.45rem;
		border-radius: 999px;
	}
	.build {
		padding: 0.4rem 0.6rem 0.1rem;
		color: var(--smoke);
	}
	.keys {
		display: flex;
		flex-direction: column;
		padding: 0.6rem 0.6rem 0.2rem;
		border-top: 1px dashed var(--rule);
		margin-top: 0.4rem;
	}
	@media (pointer: coarse) {
		.keys {
			display: none;
		}
	}

	/* --- Focus mode ------------------------------------------------------------ */

	.focusbar {
		left: 50%;
		bottom: var(--bottom);
		transform: translateX(-50%);
		max-width: calc(100% - 2 * var(--gap));
		padding: 4px 4px 4px 0.9rem;
		gap: 0.5rem;
		border-radius: 999px;
	}
	.fname {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		flex: none;
		max-width: 12rem;
	}
	.fname .serif {
		font-size: 1.15rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dim {
		color: var(--smoke);
		flex: none;
	}
	.chips {
		display: flex;
		gap: 4px;
		overflow-x: auto;
		scrollbar-width: none;
		touch-action: pan-x;
		min-width: 0;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		height: 32px;
		padding: 0 0.8rem;
		border: 1px solid rgb(244 240 231 / 0.16);
		border-radius: 999px;
		background: transparent;
		color: inherit;
		font-size: 0.82rem;
		white-space: nowrap;
		cursor: pointer;
	}
	.chip.on {
		background: var(--lime);
		border-color: var(--lime);
		color: var(--ink);
	}
	.exit {
		border-radius: 999px;
		padding: 0 0.8rem;
		flex: none;
	}
	.exit .kicker {
		font-size: 0.62rem;
	}
	@media (max-width: 560px) {
		.fname {
			display: none;
		}
		.focusbar {
			padding-left: 0.8rem;
		}
		.focusbar > .vr:first-of-type {
			display: none;
		}
	}

	/* --- Notices --------------------------------------------------------------- */

	.notices {
		position: absolute;
		z-index: 5;
		top: calc(var(--top) + var(--toprow, 48px) + 12px);
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		width: min(34rem, calc(100% - 2 * var(--gap)));
		pointer-events: none;
	}
	.notice {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.7rem;
		padding: 0.55rem 0.6rem 0.55rem 1rem;
		border-radius: 18px;
		background: var(--ink);
		color: var(--chalk);
		box-shadow: var(--shadow-float);
		font-size: 0.85rem;
		pointer-events: auto;
	}
	.notice:has(> .pip, > .spinner) {
		padding-right: 1rem;
		border-radius: 999px;
	}
	.notice b {
		font-weight: 600;
	}
	.notice .kicker.lime {
		color: var(--ink);
		background: var(--lime);
		padding: 0.2rem 0.5rem;
		border-radius: 999px;
	}
	.notice.warn .kicker {
		color: var(--ink);
		background: var(--vermilion);
		padding: 0.2rem 0.5rem;
		border-radius: 999px;
	}
	.notice > span:not(.kicker, .pip, .spinner, .row, .err) {
		flex: 1 1 12rem;
	}
	.rejoin .row {
		display: flex;
		gap: 0.5rem;
		width: 100%;
	}
	.rejoin .input {
		padding: 0.45rem 0.7rem;
		font-size: 0.9rem;
		border-radius: 10px;
	}
	.err {
		color: #ffb4a2;
		font-size: 0.8rem;
	}
	.spinner {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 2px solid rgb(244 240 231 / 0.25);
		border-top-color: var(--lime);
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}

	/* Phones: the masthead gives way to the corner. */
	@media (max-width: 520px) {
		.masthead {
			padding-right: 0.7rem;
		}
		.corner .vr {
			display: none;
		}
		.name {
			font-size: 1.15rem;
		}
		.meta .sep,
		.meta .role {
			display: none;
		}
	}
</style>

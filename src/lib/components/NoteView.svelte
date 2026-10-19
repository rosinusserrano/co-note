<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { fly, scale } from 'svelte/transition';
	import DrawingCanvas from './DrawingCanvas.svelte';
	import NoteSettings from './NoteSettings.svelte';
	import Icon, { type IconName } from './Icon.svelte';
	import { noteStore, destroyNoteData } from '$lib/notes/noteStore.svelte';
	import { noteIndex, myName, type NoteEntry } from '$lib/notes/noteIndex.svelte';
	import { joinNote, ownerSession, ApiError, type NoteSession } from '$lib/notes/api';
	import { Viewport, MAX_FIT_SCALE } from '$lib/notes/viewport.svelte';
	import { PAGE_GAP } from '$lib/notes/pages';
	import { BRUSHES, MARKER_ALPHA } from '$lib/notes/ink';
	import type { Brush } from '$lib/notes/model';

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
	// Each ink type keeps its own colour and size; the palette and slider edit
	// the current one (the last one used, while the eraser, laser or hand is active).
	let inks = $state<Record<Brush, { color: string; width: number }>>({
		pen: { color: '#191814', width: BRUSHES.pen.size },
		brush: { color: '#191814', width: BRUSHES.brush.size },
		marker: { color: '#f2c230', width: BRUSHES.marker.size }
	});
	let brush = $state<Brush>('pen');
	const color = $derived(inks[brush].color);
	const strokeWidth = $derived(inks[brush].width);

	type Tool = Brush | 'eraser' | 'laser' | 'hand';
	const TOOLS: { id: Tool; icon: IconName; label: string; key: string; hint?: string }[] = [
		{ id: 'pen', icon: 'pen', label: 'Pen', key: 'P' },
		{ id: 'brush', icon: 'brush', label: 'Brush', key: 'B' },
		{ id: 'marker', icon: 'marker', label: 'Marker', key: 'M' },
		{ id: 'eraser', icon: 'eraser', label: 'Eraser', key: 'E' },
		{ id: 'laser', icon: 'laser', label: 'Laser', key: 'L', hint: 'hold to point, everyone sees a fading trail' },
		{ id: 'hand', icon: 'hand', label: 'Hand', key: 'H', hint: 'drag to move around (or hold Space)' }
	];

	function pickColor(c: string) {
		inks[brush].color = c;
		if (!isBrush(tool)) tool = brush; // picking a colour means "draw with it"
	}
	const isBrush = (t: Tool): t is Brush => t === 'pen' || t === 'brush' || t === 'marker';
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

	/** Which floating panel is open. One at a time; a tap elsewhere closes it. */
	let pop = $state<'' | 'people' | 'share' | 'more' | 'ink'>('');
	const toggle = (p: typeof pop) => (pop = pop === p ? '' : p);
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
		const role = entry.ownerKey ? 'Owner' : canEdit ? 'Editor' : 'Observer';
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
	let pdfBusy = $state<'' | 'import' | 'export'>('');
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

	function zoomBy(factor: number) {
		follow = null;
		viewport.zoomAt(canvasWidth / 2, canvasHeight / 2, factor);
	}

	// An observer cannot ink. This mirrors the server's decision in the UI; it is
	// NOT what enforces read-only (the server drops their writes). Focus mode
	// watches, so it doesn't ink either.
	const effectiveMode = $derived(canEdit && !focus ? mode : 'observe');
	const zoomPct = $derived(Math.round(viewport.scale * 100));
	const roleLabel = $derived(entry.ownerKey ? 'Owner' : canEdit ? 'Editor' : 'Observer');

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
			const session: NoteSession & { ownerProof?: string } = entry.ownerKey
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
		if (noteStore.access === 'revoked' && entry.ownerKey) untrack(() => rejoin());
	});

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
			if (pop) pop = '';
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

	// Ink preview in the size/colour panel: thickness at 100% zoom, like on paper.
	const previewWidth = $derived(Math.max(1.2, Math.min(strokeWidth, 44)));
</script>

<svelte:window
	onkeydown={onKey}
	onpointerdown={onWindowPointerDown}
	onpointermove={() => focus && revealFocusBar()}
/>

<div class="app" class:inking class:focus class:idle={focus && !focusBar} class:dock={!focus && showRail}>
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

	{#if !focus}
		<div class="topbar" transition:fly={{ y: -16, duration: 260 }}>
			<!-- Masthead: back, the note's name, who we are, whether we're live. -->
			<div class="chrome masthead">
				<button class="ibtn" onclick={onleave} title="All notes" aria-label="All notes"><Icon name="back" /></button>
				<div class="ident">
					<span class="name" title={entry.name}>{entry.name}</span>
					<span class="kicker meta">
						<span class="role" data-role={entry.ownerKey ? 'owner' : entry.role}>{roleLabel}</span>
						<span class="sep">/</span>
						<span class="dot" data-status={noteStore.status}></span>{statusWord}
					</span>
				</div>
			</div>

			<!-- Top right: people, share, focus, more. -->
			<div class="chrome corner">
				<button
					class="people"
					class:on={pop === 'people'}
					data-pop
					onclick={() => toggle('people')}
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
				<span class="vr"></span>
				<button class="ibtn" class:on={pop === 'share'} data-pop onclick={() => toggle('share')} title="Share" aria-label="Share">
					<Icon name="link" />
				</button>
				{#if entry.ownerKey}
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
				<button class="ibtn" class:on={pop === 'more'} data-pop onclick={() => toggle('more')} title="More" aria-label="More">
					<Icon name="more" />
				</button>
			</div>
		</div>

		<!-- Tools: the pen case on the left edge. -->
		{#if showRail}
			<nav class="chrome rail" aria-label="Tools" transition:fly|global={{ x: -24, duration: 260 }}>
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
				<span class="hr"></span>
				<button
					class="ink"
					class:on={pop === 'ink'}
					data-pop
					onclick={() => toggle('ink')}
					title={`${BRUSHES[brush].label}: colour and size`}
					aria-label={`${BRUSHES[brush].label} colour and size`}
				>
					<span class="dish"><span class="blob" style:background={color} style:--w="{Math.min(20, 4 + strokeWidth * 0.55)}px"></span></span>
				</button>
				<span class="hr"></span>
				<button class="tool" onclick={() => noteStore.undo()} disabled={!noteStore.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
					<Icon name="undo" size={20} />
				</button>
				<button class="tool" onclick={() => noteStore.redo()} disabled={!noteStore.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
					<Icon name="redo" size={20} />
				</button>
			</nav>
		{:else if canEdit}
			<div class="chrome lookonly" transition:fly|global={{ x: -24, duration: 260 }}>
				<span class="kicker">Look only</span>
				<button class="mini lime" onclick={() => (mode = 'draw')}>Draw</button>
			</div>
		{/if}

		{#if pop === 'ink' && showRail}
			<div class="pop inkpop" data-pop transition:scale={{ start: 0.96, duration: 160 }}>
				<div class="pophead">
					<span class="serif">{BRUSHES[brush].label}</span>
					<span class="kicker">{strokeWidth.toFixed(1)} pt</span>
				</div>
				<svg class="preview" viewBox="0 0 240 70" aria-hidden="true">
					<path
						d="M14 48 C 46 10, 78 12, 104 34 S 168 62, 226 22"
						fill="none"
						stroke={color}
						stroke-width={previewWidth}
						stroke-linecap={brush === 'marker' ? 'butt' : 'round'}
						opacity={brush === 'marker' ? MARKER_ALPHA + 0.25 : 1}
					/>
				</svg>
				<input
					class="size"
					type="range"
					min={BRUSHES[brush].min}
					max={BRUSHES[brush].max}
					step="0.5"
					bind:value={inks[brush].width}
					aria-label={`${BRUSHES[brush].label} size`}
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
			</div>
		{/if}

		<!-- View: zoom, fit, follow. -->
		<div class="chrome zoombar" transition:fly={{ y: 16, duration: 260 }}>
			<button class="ibtn" onclick={() => zoomBy(0.8)} aria-label="Zoom out" title="Zoom out (−)"><Icon name="minus" size={18} /></button>
			<button class="pct" onclick={resetView} title="Back to 100% (0)">{zoomPct}<small>%</small></button>
			<button class="ibtn" onclick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in (+)"><Icon name="plus" size={18} /></button>
			<span class="vr"></span>
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
		</div>

		<!-- Panels from the top-right corner. -->
		{#if pop === 'people'}
			<div class="pop corner-pop" data-pop transition:scale={{ start: 0.96, duration: 160 }}>
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
				{#if entry.ownerKey}
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
			<div class="pop corner-pop ticketwrap" data-pop transition:scale={{ start: 0.96, duration: 160 }}>
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
		{:else if pop === 'more'}
			<div class="pop corner-pop menu" data-pop transition:scale={{ start: 0.96, duration: 160 }}>
				<span class="kicker sect">Document</span>
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
						disabled={noteStore.strokeCount === 0}
						onclick={() => {
							noteStore.clear();
							pop = '';
						}}
					>
						<Icon name="trash" size={18} /><span>Clear all ink</span><span class="kicker">undo-able</span>
					</button>
				{/if}
				{#if entry.ownerKey}
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
			</div>
		{/if}
	{/if}

	{#if canEdit}
		<input type="file" accept="application/pdf,.pdf" hidden bind:this={pdfInput} onchange={importPdf} />
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
	<div class="notices" aria-live="polite">
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
				<span>{pdfBusy === 'import' ? 'Importing PDF…' : 'Exporting PDF…'}</span>
			</div>
		{/if}
		{#if pdfError}
			<div class="notice warn" transition:fly={{ y: -12, duration: 220 }}>
				<span class="kicker">PDF</span>
				<span>{pdfError}</span>
				<button class="mini" onclick={() => (pdfError = '')}>OK</button>
			</div>
		{/if}
		{#if noteStore.access === 'gone'}
			<div class="notice warn" transition:fly={{ y: -12, duration: 220 }}>
				<span class="kicker">Deleted</span>
				<span>The owner deleted this note. You're looking at this device's last copy.</span>
				<button class="mini" onclick={forgetDeleted}>Forget it</button>
			</div>
		{:else if noteStore.access === 'revoked' && !entry.ownerKey}
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

{#if showSettings && entry.ownerKey}
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
	:is(.ibtn, .tool, .ink, .pct, .word, .people, .exit):hover:not(:disabled) {
		background: var(--ink-3);
	}
	:is(.ibtn, .tool, .ink, .pct, .word, .people, .exit):active:not(:disabled) {
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

	/* Top: masthead left, corner right; one row so they can't overlap. */
	.topbar {
		position: absolute;
		z-index: 3;
		top: var(--top);
		left: var(--left);
		right: var(--right);
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--gap);
		pointer-events: none;
	}
	.topbar > .chrome {
		position: relative;
		pointer-events: auto;
	}
	.app.inking .topbar > .chrome {
		pointer-events: none;
	}
	.masthead {
		padding-right: 1rem;
		gap: 0.35rem;
		min-width: 0;
		max-width: 24rem;
	}
	.ident {
		display: flex;
		flex-direction: column;
		min-width: 0;
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

	/* Corner */
	.corner {
		flex: none;
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

	/* Rail */
	.rail {
		left: var(--left);
		top: 50%;
		transform: translateY(-50%);
		flex-direction: column;
		padding: 5px;
		border-radius: 20px;
	}
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
		.tool,
		.ink {
			width: 36px;
			height: 34px;
		}
		.rail {
			padding: 3px;
		}
	}
	/* Phones: the tools become a dock along the bottom, in thumb reach; the
	   zoom bar sits above it, without ± (that's what pinching is for). */
	@media (max-width: 600px) {
		.rail {
			top: auto;
			left: 50%;
			bottom: var(--bottom);
			transform: translateX(-50%);
			flex-direction: row;
			padding: 4px;
			border-radius: 18px;
		}
		.rail .hr {
			width: 1px;
			height: auto;
			margin: 8px 3px;
		}
		.tool,
		.ink {
			width: 36px;
			min-width: 0;
			height: 42px;
			border-radius: 12px;
		}
		.app.dock .zoombar {
			bottom: calc(var(--bottom) + 62px);
		}
		.zoombar .ibtn,
		.zoombar .vr {
			display: none;
		}
		/* (.app: outranks the wide-screen .inkpop rule further down) */
		.app .inkpop {
			left: 50%;
			top: auto;
			bottom: calc(var(--bottom) + 62px);
			transform: translateX(-50%);
			transform-origin: bottom center;
			width: min(19rem, calc(100% - 2 * var(--gap)));
		}
	}
	@media (max-width: 380px) {
		.tool,
		.ink {
			width: 32px;
		}
		.rail .hr {
			margin-inline: 1px;
		}
	}
	.lookonly {
		left: var(--left);
		bottom: var(--bottom);
		gap: 0.6rem;
		padding-left: 0.9rem;
		color: var(--smoke);
	}

	/* Zoom bar */
	.zoombar {
		right: var(--right);
		bottom: var(--bottom);
	}
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
	.pip {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: none;
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
		transform-origin: top right;
		cursor: default;
	}
	.corner-pop {
		top: calc(var(--top) + 58px);
		right: var(--right);
		width: min(22rem, calc(100% - 2 * var(--gap)));
		max-height: calc(100% - var(--top) - 70px - var(--bottom));
		overflow-y: auto;
		touch-action: pan-y;
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

	/* Beside the rail on wide screens; above the dock on phones. */
	.inkpop {
		position: absolute;
		left: calc(var(--left) + 70px);
		top: 50%;
		transform: translateY(-50%);
		transform-origin: left center;
		width: 15.5rem;
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
	.item .kicker.lit {
		color: var(--ink);
		background: var(--lime);
		padding: 0.15rem 0.45rem;
		border-radius: 999px;
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
		top: calc(var(--top) + 60px);
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		width: min(34rem, calc(100% - 2 * var(--gap)));
		pointer-events: none;
	}
	.app.focus .notices {
		top: var(--top);
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

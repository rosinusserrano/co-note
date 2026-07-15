<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import DrawingCanvas from '$lib/components/DrawingCanvas.svelte';
	import { noteStore, destroyNoteData } from '$lib/notes/noteStore.svelte';
	import { noteIndex } from '$lib/notes/noteIndex.svelte';
	import { broadcastLinks, noteIdForBroadcast } from '$lib/notes/broadcast';
	import { Viewport } from '$lib/notes/viewport.svelte';

	// One viewport per session. This is what stays independent across devices —
	// including across note switches, where we reset it rather than carry a
	// previous note's zoom into an unrelated drawing.
	const viewport = new Viewport();

	const palette = ['#f9fafb', '#111827', '#ef4444', '#3b82f6', '#22c55e', '#eab308'];
	let color = $state('#f9fafb');
	let strokeWidth = $state(2.5);
	let mode = $state<'draw' | 'observe'>('draw');
	let tool = $state<'pen' | 'eraser'>('pen');

	let innerWidth = $state(0);
	let innerHeight = $state(0);

	const title = $derived(noteIndex.get(noteStore.id)?.title ?? 'Untitled note');

	onMount(() => {
		noteIndex.load();
		const params = new URLSearchParams(location.search);

		// ?b=<id> joins a broadcast read-only; &t=<token> asks the host for edit.
		const bid = params.get('b');
		if (bid) {
			noteIndex.ensure(noteIdForBroadcast(bid)).id;
			noteIndex.rename(noteIdForBroadcast(bid), `Broadcast ${bid}`);
			noteStore.joinBroadcast(bid, params.get('t') ?? '');
			return () => noteStore.disconnect();
		}

		// ?note=<id> opens a specific note — this is how a second device reaches
		// the same drawing, since the note list itself is local to each device.
		const requested = params.get('note');
		const id = requested ? noteIndex.ensure(requested).id : noteIndex.notes[0].id;
		// No URL write on mount: replaceState before the router has initialised
		// throws, and there is nothing to correct — either ?note= already names
		// this note, or its absence just means "the first one".
		openNote(id, { updateUrl: false });
		return () => noteStore.disconnect();
	});

	let links = $state<{ view: string; edit: string } | null>(null);

	function toggleBroadcast() {
		if (noteStore.role === 'host') {
			noteStore.stopBroadcast();
			links = null;
			return;
		}
		const started = noteStore.startBroadcast();
		if (started) links = broadcastLinks(started.id, started.token);
	}

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			/* clipboard blocked (insecure origin / no permission) — the input is
			   still there to select by hand */
		}
	}

	// A viewer cannot ink. This mirrors the host's decision in the UI; it is NOT
	// what enforces read-only (the host drops their writes — see webrtcStar.ts).
	const effectiveMode = $derived(noteStore.role === 'view' ? 'observe' : mode);

	function openNote(id: string, opts: { updateUrl?: boolean } = {}) {
		if (noteStore.id !== id) viewport.reset();
		noteStore.connect(id); // no-op if this note is already open
		if (opts.updateUrl !== false) {
			const url = new URL(location.href); // keep ?sync= and friends
			url.searchParams.set('note', id);
			replaceState(url, {});
		}
	}

	function newNote() {
		openNote(noteIndex.create().id);
	}

	function renameNote() {
		const next = prompt('Note name', title);
		if (next !== null) noteIndex.rename(noteStore.id, next);
	}

	async function deleteNote() {
		const id = noteStore.id;
		if (noteIndex.notes.length <= 1) return;
		if (!confirm(`Delete "${title}"? This erases its drawing on this device.`)) return;
		const next = noteIndex.notes.find((n) => n.id !== id);
		if (!next || !noteIndex.remove(id)) return;
		openNote(next.id); // disconnects the doomed doc before we delete its data
		await destroyNoteData(id);
	}

	const zoomPct = $derived(Math.round(viewport.scale * 100));

	// Status is checked BEFORE role: a joiner keeps its role for the whole
	// session, so testing role first would mean 'Joined · read-only' could never
	// give way to 'Broadcast ended' once the host went away.
	const broadcastLabel = $derived(
		noteStore.role === 'host'
			? `Broadcasting · ${noteStore.broadcastPeers} joined${
					noteStore.broadcastEditors ? ` · ${noteStore.broadcastEditors} editing` : ''
				}`
			: noteStore.guestStatus === 'ended'
				? 'Broadcast ended'
				: noteStore.guestStatus === 'error'
					? `Can't join: ${noteStore.guestError}`
					: noteStore.role === 'edit'
						? 'Joined · can edit'
						: noteStore.role === 'view'
							? 'Joined · read-only'
							: 'Connecting to broadcast…'
	);

	const syncLabel = $derived(
		noteStore.status === 'connected'
			? noteStore.peers > 1
				? `Synced · ${noteStore.peers} devices`
				: 'Synced'
			: noteStore.status === 'connecting'
				? 'Connecting…'
				: 'Offline'
	);
</script>

<div class="app">
	<header class="toolbar">
		<div class="group">
			<select
				class="notes"
				aria-label="Current note"
				value={noteStore.id}
				onchange={(e) => openNote(e.currentTarget.value)}
			>
				{#each noteIndex.notes as n (n.id)}
					<option value={n.id}>{n.title}</option>
				{/each}
			</select>
			<button onclick={newNote} title="New note">New</button>
			<button onclick={renameNote} title="Rename this note">Rename</button>
			<button
				onclick={deleteNote}
				disabled={noteIndex.notes.length <= 1}
				title="Delete this note on this device"
			>
				Delete
			</button>
		</div>

		<div class="group">
			{#each palette as c (c)}
				<button
					class="swatch"
					class:active={color === c}
					style:background={c}
					aria-label={`Color ${c}`}
					onclick={() => (color = c)}
				></button>
			{/each}
		</div>

		<div class="group">
			<button class:active={tool === 'pen'} onclick={() => (tool = 'pen')}>Pen</button>
			<button class:active={tool === 'eraser'} onclick={() => (tool = 'eraser')}>Eraser</button>
			<label class="width">
				<input type="range" min="1" max="12" step="0.5" bind:value={strokeWidth} />
			</label>
		</div>

		<div class="group">
			<button onclick={() => noteStore.undo()} disabled={!noteStore.canUndo}> Undo </button>
			<button onclick={() => noteStore.redo()} disabled={!noteStore.canRedo}> Redo </button>
			<button onclick={() => noteStore.clear()} disabled={noteStore.strokeCount === 0}>
				Clear
			</button>
		</div>

		<div class="group">
			<button aria-label="Zoom in" onclick={() => viewport.zoomAt(innerWidth / 2, innerHeight / 2, 1.25)}>
				+
			</button>
			<span class="zoom">{zoomPct}%</span>
			<button aria-label="Zoom out" onclick={() => viewport.zoomAt(innerWidth / 2, innerHeight / 2, 0.8)}>
				−
			</button>
			<button onclick={() => viewport.reset()}>Reset</button>
		</div>

		<div class="group">
			<button
				class:active={effectiveMode === 'observe'}
				disabled={noteStore.role === 'view'}
				onclick={() => (mode = mode === 'draw' ? 'observe' : 'draw')}
				title={noteStore.role === 'view'
					? 'You joined this broadcast read-only'
					: 'Observer sessions view only — no inking'}
			>
				{effectiveMode === 'draw' ? 'Drawing' : 'Observing'}
			</button>
			<button
				class:active={noteStore.role === 'host'}
				disabled={noteStore.role === 'view' || noteStore.role === 'edit'}
				onclick={toggleBroadcast}
				title="Share this note peer-to-peer"
			>
				{noteStore.role === 'host' ? 'Stop broadcast' : 'Broadcast'}
			</button>
		</div>

		{#if noteStore.role || noteStore.guestStatus}
			<div class="group sync" title={`Broadcast ${noteStore.broadcastId}`}>
				<span
					class="dot"
					data-status={noteStore.role === 'host' ? 'connected' : (noteStore.guestStatus ?? '')}
				></span>
				<span class="p2p-label">{broadcastLabel}</span>
				{#if noteStore.rejectedWrites > 0}
					<span class="rejected" title="Writes refused from read-only peers">
						{noteStore.rejectedWrites} blocked
					</span>
				{/if}
			</div>
		{:else}
			<div class="group sync" title={`Sync relay: ${noteStore.status}`}>
				<span class="dot" data-status={noteStore.status}></span>
				<span class="sync-label">{syncLabel}</span>
			</div>
		{/if}
	</header>

	{#if links}
		<div class="share">
			<label>
				<span>View link (read-only)</span>
				<input readonly value={links.view} onfocus={(e) => e.currentTarget.select()} />
				<button onclick={() => copy(links!.view)}>Copy</button>
			</label>
			<label>
				<span class="warn">Edit link — grants drawing</span>
				<input readonly value={links.edit} onfocus={(e) => e.currentTarget.select()} />
				<button onclick={() => copy(links!.edit)}>Copy</button>
			</label>
		</div>
	{/if}

	<main class="stage">
		<DrawingCanvas {viewport} mode={effectiveMode} {tool} {color} {strokeWidth} />
	</main>
</div>

<svelte:window bind:innerWidth bind:innerHeight />

<style>
	.app {
		display: flex;
		flex-direction: column;
		height: 100%;
	}
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: center;
		padding: 0.5rem 0.75rem;
		background: var(--panel);
		border-bottom: 1px solid #000;
		z-index: 2;
	}
	.group {
		display: flex;
		gap: 0.35rem;
		align-items: center;
		padding-right: 0.75rem;
		border-right: 1px solid var(--panel-2);
	}
	.group:last-child {
		border-right: none;
	}
	button {
		background: var(--panel-2);
		color: var(--text);
		border: 1px solid transparent;
		border-radius: 0.4rem;
		padding: 0.35rem 0.6rem;
		font-size: 0.85rem;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	button.active {
		border-color: var(--accent);
		background: var(--accent);
	}
	.notes {
		background: var(--panel-2);
		color: var(--text);
		border: 1px solid transparent;
		border-radius: 0.4rem;
		padding: 0.35rem 0.6rem;
		font-size: 0.85rem;
		max-width: 10rem;
		cursor: pointer;
	}
	.swatch {
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
		border-radius: 50%;
		border: 2px solid var(--panel-2);
	}
	.swatch.active {
		border-color: var(--accent);
		outline: 2px solid var(--accent);
	}
	.width {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
	}
	.zoom {
		min-width: 3.2rem;
		text-align: center;
		font-variant-numeric: tabular-nums;
		font-size: 0.85rem;
	}
	.sync {
		border-right: none;
		margin-left: auto;
		font-size: 0.8rem;
		color: #cbd5e1;
	}
	.dot {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 50%;
		background: #6b7280;
	}
	.dot[data-status='connected'] {
		background: #22c55e;
	}
	.dot[data-status='connecting'] {
		background: #eab308;
	}
	.dot[data-status='disconnected'] {
		background: #ef4444;
	}
	.dot[data-status='ended'],
	.dot[data-status='error'] {
		background: #ef4444;
	}
	.rejected {
		margin-left: 0.4rem;
		padding: 0.05rem 0.35rem;
		border-radius: 0.3rem;
		background: #7f1d1d;
		color: #fecaca;
		font-size: 0.72rem;
	}
	.share {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		padding: 0.5rem 0.75rem;
		background: var(--panel-2);
		border-bottom: 1px solid #000;
		z-index: 2;
	}
	.share label {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.78rem;
	}
	.share input {
		width: min(22rem, 42vw);
		background: var(--panel);
		color: var(--text);
		border: 1px solid #000;
		border-radius: 0.3rem;
		padding: 0.25rem 0.4rem;
		font-size: 0.75rem;
	}
	.share .warn {
		color: #fca5a5;
	}
	.stage {
		position: relative;
		flex: 1;
		min-height: 0;
	}
</style>

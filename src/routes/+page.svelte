<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import DrawingCanvas from '$lib/components/DrawingCanvas.svelte';
	import { noteStore, destroyNoteData } from '$lib/notes/noteStore.svelte';
	import { noteIndex } from '$lib/notes/noteIndex.svelte';
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
		// ?note=<id> opens a specific note — this is how a second device reaches
		// the same drawing, since the note list itself is local to each device.
		const requested = new URLSearchParams(location.search).get('note');
		const id = requested ? noteIndex.ensure(requested).id : noteIndex.notes[0].id;
		// No URL write on mount: replaceState before the router has initialised
		// throws, and there is nothing to correct — either ?note= already names
		// this note, or its absence just means "the first one".
		openNote(id, { updateUrl: false });
		return () => noteStore.disconnect();
	});

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
				class:active={mode === 'observe'}
				onclick={() => (mode = mode === 'draw' ? 'observe' : 'draw')}
				title="Observer sessions view only — no inking"
			>
				{mode === 'draw' ? 'Drawing' : 'Observing'}
			</button>
		</div>

		<div class="group sync" title={`Sync relay: ${noteStore.status}`}>
			<span class="dot" data-status={noteStore.status}></span>
			<span class="sync-label">{syncLabel}</span>
		</div>
	</header>

	<main class="stage">
		<DrawingCanvas {viewport} {mode} {tool} {color} {strokeWidth} />
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
	.stage {
		position: relative;
		flex: 1;
		min-height: 0;
	}
</style>

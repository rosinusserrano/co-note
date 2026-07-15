<script lang="ts">
	import DrawingCanvas from '$lib/components/DrawingCanvas.svelte';
	import { noteStore } from '$lib/notes/noteStore.svelte';
	import { Viewport } from '$lib/notes/viewport.svelte';

	// One viewport per session. This is what stays independent across devices.
	const viewport = new Viewport();

	const palette = ['#f9fafb', '#111827', '#ef4444', '#3b82f6', '#22c55e', '#eab308'];
	let color = $state('#f9fafb');
	let strokeWidth = $state(2.5);
	let mode = $state<'draw' | 'observe'>('draw');
	let tool = $state<'pen' | 'eraser'>('pen');

	let innerWidth = $state(0);
	let innerHeight = $state(0);

	$effect(() => {
		noteStore.connect('default');
	});

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
			<button onclick={() => viewport.zoomAt(innerWidth / 2, innerHeight / 2, 1.25)}>+</button>
			<span class="zoom">{zoomPct}%</span>
			<button onclick={() => viewport.zoomAt(innerWidth / 2, innerHeight / 2, 0.8)}>−</button>
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

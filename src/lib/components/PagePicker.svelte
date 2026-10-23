<script lang="ts">
	import { untrack } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import type { PdfChapter } from '$lib/notes/pdf';
	import type { PageRange } from '$lib/notes/noteStore.svelte';

	interface Props {
		count: number;
		chapters: PdfChapter[];
		/** The chosen pages (0-based, inclusive), or null to cancel. */
		ondone: (range: PageRange | null) => void;
	}
	let { count, chapters, ondone }: Props = $props();

	// The fields count from 1, like the PDF's page numbers.
	let from = $state(1);
	let to = $state(untrack(() => count));
	let picked = $state(-1);

	const valid = $derived(Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to <= count && from <= to);
	const all = $derived(valid && from === 1 && to === count);
	const span = (c: PdfChapter) => (c.from === c.to ? `p. ${c.from + 1}` : `pp. ${c.from + 1}–${c.to + 1}`);

	function pick(i: number) {
		picked = i;
		from = chapters[i].from + 1;
		to = chapters[i].to + 1;
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		if (valid) ondone({ from: from - 1, to: to - 1 });
	}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && ondone(null)} />

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && ondone(null)} transition:fade={{ duration: 160 }}>
	<form class="dialog" onsubmit={submit} transition:fly={{ y: 24, duration: 260 }}>
		<header>
			<span class="kicker">Import PDF</span>
			<h2>{count} pages</h2>
		</header>
		<p class="hint">That's a long one. Take all of it, or just the part you're working on: a chapter, or a few pages.</p>
		{#if chapters.length > 0}
			<div class="field">
				<span class="kicker">Chapters</span>
				<ol class="chapters">
					{#each chapters as c, i (i)}
						<li>
							<button type="button" class:on={picked === i} class:sub={c.depth > 0} onclick={() => pick(i)}>
								<span class="t">{c.title}</span><span class="kicker">{span(c)}</span>
							</button>
						</li>
					{/each}
				</ol>
			</div>
		{/if}
		<div class="field">
			<span class="kicker">Pages</span>
			<div class="range">
				<input class="input" type="number" min="1" max={count} bind:value={from} oninput={() => (picked = -1)} aria-label="First page" />
				<span>to</span>
				<input class="input" type="number" min="1" max={count} bind:value={to} oninput={() => (picked = -1)} aria-label="Last page" />
				<span class="kicker">of {count}</span>
			</div>
		</div>
		<div class="actions">
			<button type="button" class="btn" onclick={() => ondone(null)}>Cancel</button>
			<span class="spacer"></span>
			{#if !all}
				<button type="button" class="btn" onclick={() => ondone({ from: 0, to: count - 1 })}>All {count}</button>
			{/if}
			<button class="btn primary" disabled={!valid}>
				{all ? `Import all ${count}` : valid ? `Import ${to - from + 1} page${to === from ? '' : 's'}` : 'Import'}
			</button>
		</div>
	</form>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgb(25 24 20 / 0.45);
		backdrop-filter: blur(3px);
		display: grid;
		place-items: center;
		padding: 1rem;
		z-index: 10;
	}
	.dialog {
		width: min(30rem, 100%);
		max-height: 100%;
		overflow-y: auto;
		touch-action: pan-y;
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
		background: var(--sheet);
		border-radius: 24px;
		padding: 1.5rem;
		box-shadow: var(--shadow-card);
	}
	header .kicker {
		color: var(--graphite);
	}
	h2 {
		margin: 0.35rem 0 0;
		font-family: var(--f-serif);
		font-style: italic;
		font-weight: 400;
		font-size: 2.2rem;
		line-height: 1;
	}
	.hint {
		margin: 0;
		padding: 0.7rem 0.9rem;
		border-radius: 12px;
		background: rgb(214 242 75 / 0.35);
		font-size: 0.85rem;
		line-height: 1.4;
	}
	.chapters {
		list-style: none;
		margin: 0;
		padding: 0.25rem;
		max-height: 15rem;
		overflow-y: auto;
		touch-action: pan-y;
		border: 1.5px solid var(--rule);
		border-radius: 12px;
	}
	.chapters button {
		width: 100%;
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		padding: 0.45rem 0.6rem;
		border: 0;
		border-radius: 8px;
		background: none;
		color: var(--ink);
		font: inherit;
		font-size: 0.92rem;
		text-align: left;
		cursor: pointer;
	}
	.chapters button.sub {
		padding-left: 1.6rem;
		font-size: 0.85rem;
	}
	.chapters button:hover {
		background: rgb(25 24 20 / 0.06);
	}
	.chapters button.on {
		background: var(--lime);
	}
	.chapters .t {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chapters .kicker {
		flex: none;
		color: var(--graphite);
	}
	.range {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.range .input {
		width: 6rem;
	}
	.range .kicker {
		color: var(--graphite);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		margin-top: 0.3rem;
	}
	.spacer {
		flex: 1;
	}
</style>

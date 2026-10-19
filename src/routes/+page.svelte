<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Home from '$lib/components/Home.svelte';
	import NoteView from '$lib/components/NoteView.svelte';
	import { noteIndex } from '$lib/notes/noteIndex.svelte';
	import { account } from '$lib/notes/account.svelte';

	// `?note=<id>` opens one of this device's notes; anything else is the start
	// screen. `?join=<name>` (a shared link) prefills the join form.
	let ready = $state(false);
	onMount(() => {
		noteIndex.load();
		account.load();
		ready = true;
	});

	const noteId = $derived(page.url.searchParams.get('note'));
	const entry = $derived(noteId ? noteIndex.get(noteId) : undefined);

	const open = (id: string) => goto(`?note=${encodeURIComponent(id)}`);
	const home = () => goto('/');
</script>

{#if ready}
	{#if entry}
		<!-- Keyed: a different note is a fresh session (new viewport, new doc). -->
		{#key entry.id}
			<NoteView {entry} onleave={home} />
		{/key}
	{:else}
		<Home joinName={page.url.searchParams.get('join') ?? ''} onopen={open} />
	{/if}
{/if}

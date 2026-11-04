<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Home from '$lib/components/Home.svelte';
	import NoteView from '$lib/components/NoteView.svelte';
	import { noteIndex } from '$lib/notes/noteIndex.svelte';
	import { account } from '$lib/notes/account.svelte';
	import { tabs } from '$lib/notes/tabs.svelte';

	// `?note=<id>` opens one of this device's notes; anything else is the start
	// screen. `?join=<name>` (a shared link) prefills the join form.
	let ready = $state(false);
	onMount(() => {
		noteIndex.load();
		account.load();
		tabs.load();
		ready = true;
		// "Open with conote" (a PDF from the system, see file_handlers in
		// vite.config.ts): it becomes a new note, like a PDF dropped on the
		// start page. Chromium only; elsewhere there's the start page's picker.
		const lq = (window as { launchQueue?: LaunchQueue }).launchQueue;
		lq?.setConsumer(async (params) => {
			const handle = params.files?.find((f) => f.kind === 'file') as FileSystemFileHandle | undefined;
			if (!handle) return;
			try {
				launched = await handle.getFile();
			} catch {
				return; /* gone or unreadable */
			}
			goto('/', { replaceState: !noteId });
		});
	});

	interface LaunchQueue {
		setConsumer(consumer: (params: { files?: FileSystemHandle[] }) => void): void;
	}
	/** A PDF the system opened us with, waiting for the start page. */
	let launched = $state<File | null>(null);

	const noteId = $derived(page.url.searchParams.get('note'));
	const entry = $derived(noteId ? noteIndex.get(noteId) : undefined);

	// Every note opened gets a tab.
	$effect(() => {
		const id = entry?.id;
		// Only on opening: closing a tab mustn't bring it back.
		if (id) untrack(() => tabs.add(id));
	});

	const open = (id: string) => goto(`?note=${encodeURIComponent(id)}`);
	const home = () => goto('/');
</script>

{#if ready}
	{#if entry}
		<!-- Keyed: a different note is a fresh session (new viewport, new doc). -->
		{#key entry.id}
			<NoteView {entry} onleave={home} onopen={open} />
		{/key}
	{:else}
		<Home joinName={page.url.searchParams.get('join') ?? ''} onopen={open} openFile={launched} onfile={() => (launched = null)} />
	{/if}
{/if}

<script lang="ts">
	import { untrack } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import {
		updateSettings,
		renameNote,
		deleteNote,
		normalizeName,
		ApiError,
		VIEW_ACCESS as ACCESS,
		type ViewAccess
	} from '$lib/notes/api';
	import { noteIndex, type NoteEntry } from '$lib/notes/noteIndex.svelte';
	import { noteStore, destroyNoteData } from '$lib/notes/noteStore.svelte';

	interface Props {
		/** Owner rights: an ownerKey on this device, or owned by the account. */
		entry: NoteEntry;
		onclose: () => void;
		ondeleted: () => void;
	}
	let { entry, onclose, ondeleted }: Props = $props();

	let name = $state(untrack(() => entry.name));
	/** Who can draw: whoever has the editor passcode, or only the account
	 *  the note belongs to (no passcode at all). */
	let drawAccess = $state<'passcode' | 'private'>(untrack(() => (entry.private ? 'private' : 'passcode')));
	let editPasscode = $state('');
	let viewAccess = $state<ViewAccess>(untrack(() => entry.viewAccess));
	let viewPasscode = $state('');
	let busy = $state(false);
	let error = $state('');

	// Blank passcode fields mean "keep the current one", except when switching
	// observers to passcode mode, where there is no current one to keep.
	const needsViewPasscode = $derived(viewAccess === 'passcode' && entry.viewAccess !== 'passcode');
	// Likewise opening a private note to editors.
	const needsEditPasscode = $derived(drawAccess === 'passcode' && !!entry.private);
	const renaming = $derived(!!name.trim() && normalizeName(name) !== entry.name);

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			if (renaming) noteIndex.save(await renameNote(entry.id, name, entry.ownerKey));
			const session = await updateSettings({
				id: entry.id,
				ownerKey: entry.ownerKey,
				editPasscode: drawAccess === 'passcode' && editPasscode ? editPasscode : undefined,
				private: drawAccess === 'private' && !entry.private ? true : undefined,
				viewAccess,
				viewPasscode: viewAccess === 'passcode' && viewPasscode ? viewPasscode : undefined
			});
			noteIndex.save(session);
			// A new editor passcode revoked our own token as well.
			noteStore.renewToken(session.token);
			onclose();
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Something went wrong.';
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!confirm(`Delete "${entry.name}" for everyone? This can't be undone.`)) return;
		busy = true;
		error = '';
		try {
			await deleteNote(entry.id, entry.ownerKey);
			noteIndex.remove(entry.id);
			ondeleted(); // leaves the note, which disconnects it
			await destroyNoteData(entry.id);
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Something went wrong.';
			busy = false;
		}
	}
</script>

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()} transition:fade={{ duration: 160 }}>
	<form class="dialog" onsubmit={save} transition:fly={{ y: 24, duration: 260 }}>
		<header>
			<span class="kicker">Owner · name, passcodes &amp; access</span>
			<h2>{entry.name}</h2>
		</header>
		<p class="hint">Changing a passcode disconnects everyone who joined with the old one. They'll need the new one.</p>
		<label class="field">
			<span class="kicker">Name</span>
			<input class="input" bind:value={name} autocomplete="off" autocapitalize="none" spellcheck="false" required />
			{#if renaming}
				<small>People join with <b class="mono">{normalizeName(name)}</b> from now on; <b class="mono">{entry.name}</b> stops working.</small>
			{/if}
		</label>
		{#if entry.owned || entry.private}
			<div class="field" role="radiogroup" aria-label="Editors">
				<span class="kicker">Who can draw</span>
				<div class="seg">
					<label><input type="radio" name="settings-draw" value="passcode" bind:group={drawAccess} />Passcode</label>
					<label><input type="radio" name="settings-draw" value="private" bind:group={drawAccess} />Only my account</label>
				</div>
				<small>
					{drawAccess === 'private'
						? 'No editor passcode: only your account opens it to draw, on any device you sign in on.'
						: 'Anyone with the editor passcode can draw.'}
				</small>
			</div>
		{/if}
		{#if drawAccess === 'passcode'}
			<label class="field">
				<span class="kicker">{needsEditPasscode ? 'Editor passcode' : 'New editor passcode'}</span>
				<input
					class="input"
					type="password"
					bind:value={editPasscode}
					placeholder={needsEditPasscode ? '' : 'Keep current'}
					required={needsEditPasscode}
					autocomplete="new-password"
				/>
			</label>
		{/if}
		<div class="field" role="radiogroup" aria-label="Observers">
			<span class="kicker">Who can watch</span>
			<div class="seg">
				{#each ACCESS as a (a.value)}
					<label><input type="radio" name="settings-access" value={a.value} bind:group={viewAccess} />{a.label}</label>
				{/each}
			</div>
			<small>{ACCESS.find((a) => a.value === viewAccess)?.hint}</small>
		</div>
		{#if viewAccess === 'passcode'}
			<label class="field">
				<span class="kicker">{needsViewPasscode ? 'Observer passcode' : 'New observer passcode'}</span>
				<input
					class="input"
					type="password"
					bind:value={viewPasscode}
					placeholder={needsViewPasscode ? '' : 'Keep current'}
					required={needsViewPasscode}
					autocomplete="new-password"
				/>
			</label>
		{/if}
		{#if error}<p class="error-text">{error}</p>{/if}
		<div class="actions">
			<button type="button" class="btn danger" disabled={busy} onclick={remove}>Delete note</button>
			<span class="spacer"></span>
			<button type="button" class="btn" disabled={busy} onclick={onclose}>Cancel</button>
			<button class="btn primary" disabled={busy}>Save</button>
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
		width: min(28rem, 100%);
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
		overflow-wrap: anywhere;
	}
	.hint {
		margin: 0;
		padding: 0.7rem 0.9rem;
		border-radius: 12px;
		background: rgb(214 242 75 / 0.35);
		font-size: 0.85rem;
		line-height: 1.4;
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

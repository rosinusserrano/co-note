<script lang="ts">
	// Setting up (or changing) this device's Zotero connection: the API key, and
	// where the library keeps its files. Used in a note's Zotero panel and on the
	// start page's Account tab.
	import { untrack } from 'svelte';
	import { zoteroVerify } from '$lib/notes/api';
	import { zotero } from '$lib/notes/zotero.svelte';
	import { account } from '$lib/notes/account.svelte';
	import { vaultAvailable } from '$lib/notes/vault';

	interface Props {
		/** Shown as Cancel once a connection exists (leave the form unchanged). */
		oncancel?: () => void;
		/** After a successful Connect. */
		onconnected?: () => void;
		/** After Disconnect. */
		ondisconnect?: () => void;
	}
	let { oncancel, onconnected, ondisconnect }: Props = $props();

	const z = untrack(() => zotero.settings);
	let form = $state({
		apiKey: '',
		storage: (z?.webdav ? 'webdav' : 'zotero') as 'zotero' | 'webdav',
		url: z?.webdav?.url ?? '',
		user: z?.webdav?.user ?? '',
		password: '',
		busy: false,
		error: ''
	});

	// Signed in from before the vault existed, this device can't open the
	// account's copy of the connection: the password once more derives the key,
	// then pulls the connection another device put there, or pushes this one.
	const locked = $derived(account.signedIn && !account.vaultKey && vaultAvailable());
	const had = untrack(() => !!zotero.settings);
	let unlock = $state({ password: '', busy: false, error: '' });

	async function bringHere(e: SubmitEvent) {
		e.preventDefault();
		unlock.busy = true;
		unlock.error = '';
		try {
			await account.unlock(unlock.password);
			unlock.password = '';
			if (had) return;
			if (zotero.settings) onconnected?.();
			else unlock.error = 'Your account has no Zotero connection yet. Connect below, and your other devices get it too.';
		} catch (err) {
			unlock.error = err instanceof Error ? err.message : 'Something went wrong.';
		} finally {
			unlock.busy = false;
		}
	}

	async function connect(e: SubmitEvent) {
		e.preventDefault();
		form.busy = true;
		form.error = '';
		try {
			const key = form.apiKey.trim() || zotero.settings?.apiKey || '';
			const who = await zoteroVerify(key);
			if (!who.write) throw new Error('That key can only read. Give it write access too, so annotated PDFs can be saved back.');
			const webdav =
				form.storage === 'webdav'
					? {
							url: form.url.trim(),
							user: form.user.trim(),
							// unchanged if left empty while editing the same WebDAV login
							password: form.password || zotero.settings?.webdav?.password || ''
						}
					: undefined;
			zotero.save({ apiKey: key, userId: who.userId, username: who.username, webdav });
			form.apiKey = '';
			form.password = '';
			onconnected?.();
		} catch (err) {
			form.error = err instanceof Error ? err.message : 'Something went wrong.';
		} finally {
			form.busy = false;
		}
	}
</script>

{#if locked || unlock.error}
	<form class="stack unlock" onsubmit={bringHere}>
		<p class="fine">
			{had
				? 'This connection is only on this device. Enter your password to keep it in your account, for your other devices.'
				: 'Connected on another device? Enter your password to bring it here.'}
		</p>
		<div class="row">
			<input
				class="input grow"
				type="password"
				bind:value={unlock.password}
				placeholder="Account password"
				autocomplete="current-password"
				required
			/>
			<button class="btn" disabled={unlock.busy}>{unlock.busy ? '…' : had ? 'Keep in account' : 'Bring here'}</button>
		</div>
		{#if unlock.error}<p class="err">{unlock.error}</p>{/if}
	</form>
{/if}

<form class="stack" onsubmit={connect}>
	<p class="fine">
		Make an API key at <a href="https://www.zotero.org/settings/keys/new" target="_blank" rel="noreferrer">zotero.org/settings/keys</a>
		with <b>library access</b> and <b>write access</b>.
		{account.vaultKey ? 'It is kept in your account (encrypted), so your other devices have it too.' : 'It stays on this device.'}
	</p>
	<input
		class="input mono"
		bind:value={form.apiKey}
		placeholder={zotero.settings ? 'API key (unchanged if empty)' : 'API key'}
		autocomplete="off"
		spellcheck="false"
		required={!zotero.settings}
	/>
	<div class="seg" role="radiogroup" aria-label="Where Zotero keeps the files">
		<label><input type="radio" value="zotero" bind:group={form.storage} />Zotero storage</label>
		<label><input type="radio" value="webdav" bind:group={form.storage} />WebDAV</label>
	</div>
	{#if form.storage === 'webdav'}
		<p class="fine">As in Zotero's Sync settings. Koofr: <span class="mono">app.koofr.net/dav/Koofr</span>, your Koofr e-mail, and an app password (Koofr → Preferences → Password).</p>
		<input class="input" bind:value={form.url} placeholder="WebDAV URL" autocomplete="off" autocapitalize="none" spellcheck="false" required />
		<input class="input" bind:value={form.user} placeholder="User name" autocomplete="off" autocapitalize="none" spellcheck="false" />
		<input
			class="input"
			type="password"
			bind:value={form.password}
			placeholder={zotero.settings?.webdav ? 'Password (unchanged if empty)' : 'Password'}
			autocomplete="off"
			required={!zotero.settings?.webdav}
		/>
	{/if}
	{#if form.error}<p class="err">{form.error}</p>{/if}
	<div class="row">
		<button class="btn primary" disabled={form.busy}>{form.busy ? 'Checking…' : 'Connect'}</button>
		{#if zotero.settings}
			{#if oncancel}<button type="button" class="btn" onclick={oncancel}>Cancel</button>{/if}
			<button
				type="button"
				class="btn"
				onclick={() => {
					zotero.clear();
					ondisconnect?.();
				}}>Disconnect</button
			>
		{/if}
	</div>
</form>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.fine {
		margin: 0;
		color: var(--graphite);
		font-size: 0.8rem;
		line-height: 1.4;
	}
	a {
		color: inherit;
		text-decoration-color: var(--lime-deep);
		text-decoration-thickness: 2px;
	}
	.mono {
		font-family: var(--f-mono);
		font-size: 0.85em;
	}
	.seg {
		background: var(--paper-2);
	}
	.err {
		margin: 0;
		color: #c2381a;
		font-size: 0.82rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.unlock {
		padding-bottom: 0.9rem;
		margin-bottom: 0.9rem;
		border-bottom: 1px solid var(--rule);
	}
	.grow {
		flex: 1;
		min-width: 0;
	}
</style>

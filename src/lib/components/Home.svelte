<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { fly } from 'svelte/transition';
	import Icon from './Icon.svelte';
	import {
		createNote,
		joinNote,
		forgetInAccount,
		setNoteFolder,
		normalizeName,
		ApiError,
		VIEW_ACCESS as ACCESS,
		type ViewAccess
	} from '$lib/notes/api';
	import { noteIndex, myName, setMyName, isOwner, NAME_MAX, type NoteEntry } from '$lib/notes/noteIndex.svelte';
	import { account } from '$lib/notes/account.svelte';
	import { zotero } from '$lib/notes/zotero.svelte';
	import { vaultAvailable } from '$lib/notes/vault';
	import ZoteroConnect from './ZoteroConnect.svelte';
	import { appUpdate } from '$lib/appUpdate.svelte';
	import { destroyNoteData } from '$lib/notes/noteStore.svelte';

	interface Props {
		/** Prefill for the join form, from a shared `?join=<name>` link. */
		joinName?: string;
		onopen: (id: string) => void;
	}
	let { joinName = '', onopen }: Props = $props();

	// A shared link lands on Join; a bare visit most likely wants a new note.
	let tab = $state<'join' | 'create' | 'account'>(untrack(() => (joinName ? 'join' : 'create')));

	// This device's list is the account's (fresh tokens too): on arrival, on
	// coming back to the app, and now and then while it's open, so a note
	// made on another device shows up here.
	const SYNC_EVERY_MS = 60_000;
	onMount(() => {
		let last = 0;
		const sync = () => {
			if (document.hidden || Date.now() - last < 10_000) return;
			last = Date.now();
			void account.sync();
		};
		sync();
		const timer = setInterval(sync, SYNC_EVERY_MS);
		document.addEventListener('visibilitychange', sync);
		window.addEventListener('focus', sync);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', sync);
			window.removeEventListener('focus', sync);
		};
	});
	// A new version doesn't reload over a half-filled form.
	onMount(() =>
		appUpdate.block(
			() =>
				joinForm.busy ||
				createForm.busy ||
				accountForm.busy ||
				zoteroEditing ||
				!!(unlockForm.password ||
				joinForm.passcode || createForm.name || createForm.editPasscode || createForm.viewPasscode || accountForm.password)
		)
	);

	let accountForm = $state({ name: '', password: '', busy: false, error: '' });

	async function signIn(create: boolean) {
		accountForm.busy = true;
		accountForm.error = '';
		try {
			await account.signIn(accountForm.name, accountForm.password, create);
			accountForm.password = '';
			if (!me) me = account.name; // how the others see you, unless already set
			setMyName(me);
			tab = 'create';
		} catch (err) {
			accountForm.error = errorText(err);
		} finally {
			accountForm.busy = false;
		}
	}

	/** Changing the Zotero connection (the form is open). */
	let zoteroEditing = $state(false);
	let unlockForm = $state({ password: '', busy: false, error: '' });

	async function unlock(e: SubmitEvent) {
		e.preventDefault();
		unlockForm.busy = true;
		unlockForm.error = '';
		try {
			await account.unlock(unlockForm.password);
			unlockForm.password = '';
		} catch (err) {
			unlockForm.error = errorText(err);
		} finally {
			unlockForm.busy = false;
		}
	}

	async function signOut() {
		const held = noteIndex.notes.filter((n) => n.via === account.name).length;
		if (held && !confirm(`Sign out? The ${held} note${held > 1 ? 's' : ''} from your account will be removed from this device (they stay in your account).`)) return;
		await account.signOut();
	}

	/** Saved to the account when signed in: it then shows up on every device. */
	const via = () => (account.signedIn ? { via: account.name } : {});

	// Seeded once from the link; after that the field is the user's.
	let joinForm = $state({ name: untrack(() => joinName), passcode: '', busy: false, error: '' });
	// Who you are to the others, shared by both forms and remembered on this device.
	let me = $state(myName());
	let createForm = $state({
		name: '',
		/** Signed in: no passcodes, only this account opens it (the default:
		 *  passcodes can be added later, to share it). */
		private: true,
		editPasscode: '',
		viewAccess: 'passcode' as ViewAccess,
		viewPasscode: '',
		busy: false,
		error: ''
	});

	const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');

	async function join(e: SubmitEvent) {
		e.preventDefault();
		joinForm.busy = true;
		joinForm.error = '';
		try {
			// Already on this device (from the account, say): no passcode needed.
			const known = !joinForm.passcode && noteIndex.notes.find((n) => n.name === normalizeName(joinForm.name) && n.token);
			if (known) {
				setMyName(me);
				return onopen(known.id);
			}
			const session = await joinNote(joinForm.name, joinForm.passcode);
			setMyName(me);
			opened(noteIndex.save(session, via()));
		} catch (err) {
			joinForm.error = errorText(err);
		} finally {
			joinForm.busy = false;
		}
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		createForm.busy = true;
		createForm.error = '';
		try {
			const { name, editPasscode, viewAccess, viewPasscode } = createForm;
			const only = createForm.private && account.signedIn;
			const session = await createNote(
				only
					? { name, private: true, viewAccess: 'none' }
					: { name, editPasscode, viewAccess, viewPasscode: viewAccess === 'passcode' ? viewPasscode : undefined }
			);
			setMyName(me);
			opened(noteIndex.save(session, via()));
		} catch (err) {
			createForm.error = errorText(err);
		} finally {
			createForm.busy = false;
		}
	}

	async function forget(n: NoteEntry) {
		if (n.owned) {
			alert(`"${n.name}" belongs to your account. To get rid of it, delete it in its settings (⋯ → Name, passcodes & access).`);
			return;
		}
		const inAccount = !!n.via && n.via === account.name;
		const warning = inAccount
			? `Remove "${n.name}" from your account? You can join again with the passcode.`
			: n.ownerKey
				? `Forget "${n.name}" on this device? You created it — this device is the only one that can change its passcodes or delete it, and that is lost too.`
				: `Forget "${n.name}" on this device? You can join again with the passcode.`;
		if (!confirm(warning)) return;
		if (inAccount) {
			try {
				await forgetInAccount(n.id);
			} catch {
				alert("Couldn't reach the server, so it stays in your account. Try again when you're online.");
				return;
			}
		}
		noteIndex.remove(n.id);
		await destroyNoteData(n.id);
	}

	/** With notes on this device, they take the illustration's place. */
	const returning = $derived(noteIndex.notes.length > 0);

	// --- Folders: labels on notes, kept in the account for its notes -----------

	const FOLDER_KEY = 'conote:folder';
	/** The folder the list shows (null: everything), remembered on this device. */
	let folderPick = $state<string | null>(
		(() => {
			try {
				return localStorage.getItem(FOLDER_KEY);
			} catch {
				return null;
			}
		})()
	);
	/** A folder that emptied (its last note moved out) shows everything again. */
	const folder = $derived(folderPick && noteIndex.folders.includes(folderPick) ? folderPick : null);
	function showFolder(f: string | null) {
		folderPick = f;
		try {
			if (f) localStorage.setItem(FOLDER_KEY, f);
			else localStorage.removeItem(FOLDER_KEY);
		} catch {
			/* not remembered */
		}
	}
	const listed = $derived(noteIndex.recent.filter((n) => !folder || n.folder === folder));
	const unfiled = $derived(noteIndex.notes.filter((n) => !n.folder).length);

	/** The note whose folder is being picked (its row opens a strip of folders). */
	let filing = $state<string | null>(null);
	let newFolder = $state('');

	/** File a note into `to` ('' = no folder): here, and in the account if it's there. */
	async function fileNote(n: NoteEntry, to: string) {
		const clean = to.replace(/\s+/g, ' ').trim().slice(0, 40);
		filing = null;
		newFolder = '';
		const before = n.folder ?? '';
		if (clean === before) return;
		noteIndex.setFolder(n.id, clean);
		if (account.signedIn && n.via === account.name) {
			try {
				await setNoteFolder(n.id, clean);
			} catch {
				noteIndex.setFolder(n.id, before);
				alert("Couldn't reach the server, so the folder didn't change. Try again when you're online.");
			}
		}
	}

	/** A note made or joined while a folder is shown goes into that folder. */
	function opened(entry: NoteEntry) {
		if (folder && !entry.folder) void fileNote(entry, folder);
		onopen(entry.id);
	}

	const roleLabel = (n: NoteEntry) => (isOwner(n) ? 'Owner' : n.role === 'edit' ? 'Editor' : 'Observer');

	function ago(t: number) {
		const m = Math.round((Date.now() - t) / 60_000);
		if (m < 1) return 'now';
		if (m < 60) return `${m}m`;
		const h = Math.round(m / 60);
		if (h < 24) return `${h}h`;
		const d = Math.round(h / 24);
		if (d < 14) return `${d}d`;
		return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
	}
</script>

<!-- The same handful of marks on both screens: the tablet shows them zoomed. -->
{#snippet scribble()}
	<path class="draw d1" pathLength="1" d="M58 162 C 74 112, 104 104, 118 140 S 150 190, 172 140 S 214 92, 240 132 S 280 170, 306 120" />
	<path class="draw d2" pathLength="1" d="M186 92 c -18 -14 -2 -40 26 -38 c 34 2 46 30 22 42 c -20 10 -52 4 -48 -8" />
	<path class="draw d3" pathLength="1" d="M66 196 C 120 188, 200 190, 296 184" />
	<path class="draw d4" pathLength="1" d="M226 150 l 10 14 l 18 -30" />
{/snippet}

<div class="home">
	<header class="top" in:fly={{ y: -8, duration: 400 }}>
		<span class="wordmark">co<em>note</em></span>
		{#if account.signedIn}
			<span class="acct kicker">
				<button class="who" onclick={() => (tab = 'account')} title="Your account">{account.name}</button>
			</span>
		{:else}
			<span class="kicker tag">Shared ink · private zoom</span>
		{/if}
	</header>

	<section class="hero" class:returning>
		<div class="pitch">
			<p class="kicker eyebrow">Nº 01 — a notebook for two screens</p>
			<h1>
				Shared<br />
				<em><span class="hl">live</span> notes</em>
			</h1>
			<p class="lede"><span>Pen &amp; PDF</span> · <span>in sync on every device</span> · <span>each screen its own zoom</span></p>

			{#if returning}
				<section class="index">
					<div class="indexhead">
						<h2>{folder ?? 'My notes'}</h2>
						<span class="kicker">{folder ? `${listed.length} of ${noteIndex.notes.length}` : `${noteIndex.notes.length} on this device`}</span>
					</div>
					{#if noteIndex.folders.length > 0}
						<div class="folders" role="tablist" aria-label="Folders">
							<button role="tab" class="fchip" class:on={!folder} aria-selected={!folder} onclick={() => showFolder(null)}>
								All <span class="kicker">{noteIndex.notes.length}</span>
							</button>
							{#each noteIndex.folders as f (f)}
								<button role="tab" class="fchip" class:on={folder === f} aria-selected={folder === f} onclick={() => showFolder(f)}>
									<Icon name="folder" size={15} />{f}
									<span class="kicker">{noteIndex.notes.filter((n) => n.folder === f).length}</span>
								</button>
							{/each}
							{#if unfiled && !folder}<span class="kicker loose">{unfiled} in no folder</span>{/if}
						</div>
					{/if}
					<ol>
						{#each listed as n, i (n.id)}
							<li class:filing={filing === n.id}>
								<button class="open" onclick={() => onopen(n.id)}>
									<span class="no kicker">{String(i + 1).padStart(2, '0')}</span>
									<span class="nm">{n.name}</span>
									<span class="leader"></span>
									{#if n.saved === false}<span class="unsaved kicker" title="Not in anyone's account: it ends when everyone leaves">unsaved</span>{/if}
									{#if n.private}<span class="private kicker" title="No passcode: only your account opens it">private</span>{/if}
									<span class="role kicker" data-role={isOwner(n) ? 'owner' : n.role}>{roleLabel(n)}</span>
									<span class="when kicker">{ago(n.openedAt)}</span>
								</button>
								<button
									class="forget"
									class:on={filing === n.id}
									aria-label={`Folder for ${n.name}`}
									title={n.folder ? `In “${n.folder}” — move to another folder` : 'Put in a folder'}
									onclick={() => {
										filing = filing === n.id ? null : n.id;
										newFolder = '';
									}}
								>
									<Icon name={n.folder ? 'folder' : 'folderPlus'} size={16} />
								</button>
								<button class="forget" aria-label={`Forget ${n.name}`} title="Forget on this device" onclick={() => forget(n)}>
									<Icon name="x" size={16} />
								</button>
								{#if filing === n.id}
									<form
										class="filebar"
										transition:fly={{ y: -6, duration: 160 }}
										onsubmit={(e) => {
											e.preventDefault();
											if (newFolder.trim()) void fileNote(n, newFolder);
										}}
									>
										<span class="kicker">Folder</span>
										{#each noteIndex.folders as f (f)}
											<button type="button" class="fchip" class:on={n.folder === f} onclick={() => fileNote(n, f)}>{f}</button>
										{/each}
										{#if n.folder}
											<button type="button" class="fchip" onclick={() => fileNote(n, '')}>No folder</button>
										{/if}
										<input class="input" bind:value={newFolder} maxlength="40" placeholder="New folder" aria-label="New folder name" />
										<button class="btn" disabled={!newFolder.trim()}>Move</button>
									</form>
								{/if}
							</li>
						{/each}
					</ol>
				</section>
			{:else}
				<svg class="duo" viewBox="0 0 520 330" role="img" aria-label="A laptop showing a whole page and a tablet showing a zoomed-in part of it">
					<defs>
						<clipPath id="tablet-screen"><rect x="306" y="134" width="186" height="130" rx="8" /></clipPath>
						<clipPath id="laptop-screen"><rect x="20" y="22" width="330" height="208" rx="10" /></clipPath>
					</defs>
					<!-- laptop -->
					<rect x="14" y="16" width="342" height="220" rx="16" class="frame" />
					<g clip-path="url(#laptop-screen)">
						<rect x="20" y="22" width="330" height="208" class="screen" />
						<g class="ink">{@render scribble()}</g>
						<rect x="150" y="96" width="112" height="78" rx="6" class="viewbox" />
					</g>
					<path d="M0 244 h370 l-10 14 a6 6 0 0 1 -5 3 H15 a6 6 0 0 1 -5 -3 Z" class="base" />
					<!-- tablet -->
					<g class="tablet">
						<rect x="296" y="124" width="206" height="150" rx="18" class="frame" />
						<g clip-path="url(#tablet-screen)">
							<rect x="306" y="134" width="186" height="130" class="screen" />
							<g class="ink zoomed" transform="translate(306 134) scale(1.6607) translate(-150 -96)">{@render scribble()}</g>
						</g>
						<!-- stylus -->
						<g transform="translate(452 236) rotate(-38)">
							<rect x="0" y="-5" width="96" height="10" rx="5" class="stylus" />
							<path d="M0 -5 L -14 0 L 0 5 Z" class="stylus-tip" />
						</g>
					</g>
					<text x="20" y="300" class="caption">LAPTOP · THE WHOLE PAGE</text>
					<text x="306" y="300" class="caption">TABLET · ZOOMED IN</text>
				</svg>
			{/if}
		</div>

		<div class="desk" in:fly={{ y: 16, duration: 500, delay: 120 }}>
			<div class="tabs" role="tablist">
				<button role="tab" aria-selected={tab === 'create'} class:on={tab === 'create'} onclick={() => (tab = 'create')}>
					<span class="kicker">01</span> New note
				</button>
				<button role="tab" aria-selected={tab === 'join'} class:on={tab === 'join'} onclick={() => (tab = 'join')}>
					<span class="kicker">02</span> Join
				</button>
				<button role="tab" aria-selected={tab === 'account'} class:on={tab === 'account'} onclick={() => (tab = 'account')}>
					<span class="kicker">03</span> {account.signedIn ? 'Account' : 'Sign in'}
				</button>
			</div>

			{#snippet yourName()}
				<label class="field">
					<span class="kicker">Your name <em class="opt">optional</em></span>
					<input class="input" bind:value={me} maxlength={NAME_MAX} autocomplete="nickname" placeholder="How the others see you" />
				</label>
			{/snippet}

			{#if tab === 'account'}
				{#if account.signedIn}
					<div class="card">
						<h2>Signed in as <em>{account.name}</em></h2>
						<p class="note">
							Notes you create are kept in your account, and every note you join stays open to you on any device you sign in
							on, until its owner changes that passcode.
						</p>
						<button class="btn" onclick={signOut}>Sign out</button>
					</div>
					<div class="card zotero">
						<h2>Zotero</h2>
						{#if zotero.settings && !zoteroEditing}
							<p class="note">
								Connected to <b>{zotero.settings.username || 'your library'}</b>, files in
								{zotero.settings.webdav ? 'WebDAV' : 'Zotero storage'}. In a note: ⋯ → From Zotero / Save to Zotero.
							</p>
							{#if account.vaultKey}
								<p class="note">Kept in your account (encrypted): your other devices have it once you sign in there.</p>
							{:else if vaultAvailable()}
								<form class="unlock" onsubmit={unlock}>
									<p class="note">Only on this device. Enter your password once to keep it in your account, for your other devices.</p>
									<div class="pair">
										<input class="input" type="password" bind:value={unlockForm.password} placeholder="Password" autocomplete="current-password" required />
										<button class="btn" disabled={unlockForm.busy}>{unlockForm.busy ? '…' : 'Keep in account'}</button>
									</div>
									{#if unlockForm.error}<p class="error-text">{unlockForm.error}</p>{/if}
								</form>
							{/if}
							<div class="pair">
								<button class="btn" onclick={() => (zoteroEditing = true)}>Change</button>
								<button class="btn" onclick={() => zotero.clear()}>Disconnect</button>
							</div>
						{:else}
							<p class="note">Open papers from your Zotero library in a note, and save the annotated PDF back next to them.</p>
							<ZoteroConnect
								oncancel={zoteroEditing ? () => (zoteroEditing = false) : undefined}
								onconnected={() => (zoteroEditing = false)}
								ondisconnect={() => (zoteroEditing = false)}
							/>
						{/if}
					</div>
				{:else}
					<form
						class="card"
						onsubmit={(e) => {
							e.preventDefault();
							void signIn(false);
						}}
					>
						<h2>Your account <em class="opt">optional</em></h2>
						<p class="note">
							Without one, a note you create isn't kept: it ends when the last person leaves. With one, your notes are kept,
							and the notes you join stay on your list everywhere you sign in.
						</p>
						<label class="field">
							<span class="kicker">Name</span>
							<input class="input" bind:value={accountForm.name} autocomplete="username" autocapitalize="none" spellcheck="false" required />
						</label>
						<label class="field">
							<span class="kicker">Password</span>
							<input class="input" type="password" bind:value={accountForm.password} autocomplete="current-password" required />
							<small>New account: at least 8 characters.</small>
						</label>
						{#if accountForm.error}<p class="error-text">{accountForm.error}</p>{/if}
						<div class="pair">
							<button class="btn primary go" disabled={accountForm.busy}>Sign in<span class="arrow">→</span></button>
							<button
								type="button"
								class="btn"
								disabled={accountForm.busy || !accountForm.name || !accountForm.password}
								onclick={() => signIn(true)}>Create account</button
							>
						</div>
					</form>
				{/if}
			{:else if tab === 'join'}
				<form class="card" onsubmit={join}>
					<h2>Join a note</h2>
					<label class="field">
						<span class="kicker">Note name</span>
						<input class="input" bind:value={joinForm.name} autocomplete="off" autocapitalize="none" spellcheck="false" required />
					</label>
					<label class="field">
						<span class="kicker">Passcode</span>
						<input class="input" type="password" bind:value={joinForm.passcode} autocomplete="off" />
						<small>
							The editor or observer passcode you were given. Leave it empty if the note lets anyone watch{account.signedIn
								? ', or if your account already has it'
								: ''}.
						</small>
					</label>
					{@render yourName()}
					{#if joinForm.error}<p class="error-text">{joinForm.error}</p>{/if}
					<button class="btn primary go" disabled={joinForm.busy}>
						{joinForm.busy ? 'Joining…' : 'Join note'}<span class="arrow">→</span>
					</button>
				</form>
			{:else}
				<form class="card" onsubmit={create}>
					<h2>Start a new note</h2>
					<label class="field">
						<span class="kicker">Note name</span>
						<input class="input" bind:value={createForm.name} autocomplete="off" autocapitalize="none" spellcheck="false" required />
						{#if createForm.name && normalizeName(createForm.name) !== createForm.name}
							<small>People join with <b class="mono">{normalizeName(createForm.name)}</b></small>
						{/if}
					</label>
					{#if account.signedIn}
						<div class="field" role="radiogroup" aria-label="Who can open it">
							<span class="kicker">Who can open it</span>
							<div class="seg">
								<label><input type="radio" name="who" value={true} bind:group={createForm.private} />Only my account</label>
								<label><input type="radio" name="who" value={false} bind:group={createForm.private} />With a passcode</label>
							</div>
							<small>
								{createForm.private
									? `No passcodes: it opens on any device signed in as ${account.name}. You can add passcodes later to share it.`
									: 'Others join with the name and a passcode.'}
							</small>
						</div>
					{/if}
					{#if !(createForm.private && account.signedIn)}
						<label class="field">
							<span class="kicker">Editor passcode</span>
							<input class="input" type="password" bind:value={createForm.editPasscode} autocomplete="new-password" required />
							<small>Anyone with this can draw.</small>
						</label>
						<div class="field" role="radiogroup" aria-label="Observers">
							<span class="kicker">Who can watch</span>
							<div class="seg">
								{#each ACCESS as a (a.value)}
									<label><input type="radio" name="access" value={a.value} bind:group={createForm.viewAccess} />{a.label}</label>
								{/each}
							</div>
							<small>{ACCESS.find((a) => a.value === createForm.viewAccess)?.hint}</small>
						</div>
						{#if createForm.viewAccess === 'passcode'}
							<label class="field">
								<span class="kicker">Observer passcode</span>
								<input class="input" type="password" bind:value={createForm.viewPasscode} autocomplete="new-password" required />
								<small>Anyone with this can watch, not draw.</small>
							</label>
						{/if}
					{/if}
					{@render yourName()}
					{#if createForm.error}<p class="error-text">{createForm.error}</p>{/if}
					{#if !account.signedIn}
						<p class="note warn">
							Not signed in: this note won't be kept. It ends a couple of minutes after the last person leaves.
							<button type="button" class="link" onclick={() => (tab = 'account')}>Sign in to keep it</button>
						</p>
					{/if}
					<button class="btn primary go" disabled={createForm.busy}>
						{createForm.busy ? 'Creating…' : 'Create note'}<span class="arrow">→</span>
					</button>
				</form>
			{/if}
		</div>
	</section>

	<footer class="kicker">
		<span title="This build">conote · {__BUILD_ID__}</span>
		<span>Pen · brush · marker · laser · PDF</span>
		<span>Install it from your browser menu</span>
	</footer>
</div>

<style>
	.home {
		height: 100%;
		overflow-y: auto;
		touch-action: pan-y;
		padding: max(1.5rem, env(safe-area-inset-top)) clamp(1rem, 4vw, 3.5rem) 2.5rem;
		background:
			radial-gradient(circle, rgb(52 44 28 / 0.16) 1px, transparent 1.4px) 0 0 / 24px 24px,
			var(--paper);
		background-attachment: local;
	}
	.home > * {
		max-width: 76rem;
		margin-inline: auto;
	}

	.top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		padding-bottom: 1rem;
		border-bottom: 1.5px solid var(--ink);
	}
	.wordmark {
		font-family: var(--f-serif);
		font-size: 2rem;
		line-height: 1;
		letter-spacing: -0.01em;
	}
	.wordmark em {
		font-style: italic;
	}
	.tag {
		color: var(--graphite);
	}

	/* --- Hero ------------------------------------------------------------------ */

	.hero {
		display: grid;
		grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
		gap: clamp(2rem, 5vw, 5rem);
		padding-top: clamp(2rem, 5vw, 4rem);
		align-items: start;
	}
	.eyebrow {
		margin: 0 0 1.25rem;
		color: var(--graphite);
	}
	h1 {
		margin: 0;
		font-family: var(--f-serif);
		font-weight: 400;
		font-size: clamp(3rem, 7.4vw, 6.4rem);
		line-height: 0.92;
		letter-spacing: -0.02em;
	}
	h1 em {
		font-style: italic;
	}
	/* A highlighter swipe that draws itself in. */
	.hl {
		position: relative;
		white-space: nowrap;
		z-index: 0;
	}
	.hl::before {
		content: '';
		position: absolute;
		z-index: -1;
		left: -0.08em;
		right: -0.12em;
		top: 0.5em;
		bottom: 0.02em;
		background: var(--lime);
		border-radius: 0.12em 0.4em 0.18em 0.5em;
		transform: rotate(-1.2deg) scaleX(0);
		transform-origin: left center;
		animation: swipe 0.9s var(--ease-out) 0.5s forwards;
	}
	@keyframes swipe {
		to {
			transform: rotate(-1.2deg) scaleX(1);
		}
	}
	.lede {
		max-width: 34rem;
		margin: 1.75rem 0 0;
		font-size: clamp(1.05rem, 1.5vw, 1.2rem);
		line-height: 1.5;
		color: var(--ink-3);
	}

	/* The two-screen illustration */
	.duo {
		display: block;
		width: min(100%, 34rem);
		margin-top: 2.5rem;
		overflow: visible;
	}
	.frame {
		fill: var(--ink);
	}
	.screen {
		fill: var(--sheet);
	}
	.base {
		fill: var(--ink-3);
	}
	.tablet {
		filter: drop-shadow(0 18px 20px rgb(52 44 28 / 0.3));
	}
	.ink :global(.draw) {
		fill: none;
		stroke: var(--ink);
		stroke-width: 3.2;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-dasharray: 1;
		stroke-dashoffset: 1;
		animation: draw 1.1s cubic-bezier(0.55, 0, 0.3, 1) forwards;
	}
	.ink :global(.d1) {
		animation-delay: 0.5s;
		animation-duration: 1.6s;
	}
	.ink :global(.d2) {
		stroke: #e5484d;
		animation-delay: 1.9s;
	}
	.ink :global(.d3) {
		stroke: #2f6fed;
		stroke-width: 2.4;
		animation-delay: 2.8s;
	}
	.ink :global(.d4) {
		stroke: #2f9e5b;
		animation-delay: 3.5s;
		animation-duration: 0.5s;
	}
	@keyframes draw {
		to {
			stroke-dashoffset: 0;
		}
	}
	.viewbox {
		fill: rgb(214 242 75 / 0.28);
		stroke: var(--ink);
		stroke-width: 1.5;
		stroke-dasharray: 2 5;
		stroke-linecap: round;
	}
	.stylus {
		fill: var(--ink-3);
		stroke: var(--paper);
		stroke-width: 2;
	}
	.stylus-tip {
		fill: var(--ink);
	}
	.caption {
		font-family: var(--f-mono);
		font-size: 11px;
		letter-spacing: 0.12em;
		fill: var(--graphite);
	}
	@media (prefers-reduced-motion: reduce) {
		.ink :global(.draw),
		.hl::before {
			animation-duration: 0s;
			animation-delay: 0s;
		}
	}

	/* --- The form card, with folder tabs ----------------------------------------- */

	.desk {
		position: relative;
		padding-top: 0.5rem;
	}
	.tabs {
		display: flex;
		gap: 4px;
		padding-left: 1.25rem;
	}
	.tabs button {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.7rem 1.2rem 0.8rem;
		margin-bottom: -6px;
		border: none;
		border-radius: 14px 14px 0 0;
		background: var(--paper-2);
		color: var(--graphite);
		font-weight: 600;
		font-size: 0.95rem;
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s;
	}
	.tabs button.on {
		background: var(--sheet);
		color: var(--ink);
		box-shadow: 0 -6px 14px -10px rgb(52 44 28 / 0.4);
	}
	.tabs .kicker {
		font-size: 0.6rem;
	}
	.tabs button {
		white-space: nowrap;
	}
	@media (max-width: 480px) {
		.tabs {
			padding-left: 0.75rem;
		}
		.tabs button {
			padding: 0.65rem 0.85rem 0.75rem;
			font-size: 0.9rem;
		}
		.tabs .kicker {
			display: none;
		}
	}
	/* Fragments wrap at the dots, not inside. */
	.lede span {
		white-space: nowrap;
	}
	.tabs button.on .kicker {
		color: var(--lime-deep);
	}
	.card {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
		padding: 1.6rem 1.5rem 1.5rem;
		background: var(--sheet);
		border-radius: 22px;
		box-shadow: var(--shadow-card);
	}
	.card h2 {
		margin: 0 0 0.2rem;
		font-family: var(--f-serif);
		font-style: italic;
		font-weight: 400;
		font-size: 2.1rem;
		line-height: 1;
	}
	.go {
		margin-top: 0.3rem;
		justify-content: space-between;
		padding: 0.9rem 1.3rem;
		font-size: 1rem;
	}
	.mono {
		font-family: var(--f-mono);
		font-weight: 500;
	}
	.note {
		margin: 0;
		color: var(--graphite);
		font-size: 0.88rem;
		line-height: 1.45;
	}
	.note.warn {
		padding: 0.6rem 0.8rem;
		border-radius: 12px;
		background: rgb(242 179 61 / 0.16);
		color: var(--ink-3);
	}
	.link {
		padding: 0;
		border: none;
		background: none;
		color: var(--ink);
		font: inherit;
		font-weight: 600;
		text-decoration: underline;
		text-decoration-color: var(--lime-deep);
		text-decoration-thickness: 2px;
		cursor: pointer;
	}
	.card + .card {
		margin-top: 1rem;
	}
	.unlock {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.unlock .input {
		flex: 1;
		min-width: 10rem;
	}
	.pair {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
	}
	.pair .go {
		flex: 1;
	}
	.pair .btn:not(.go) {
		margin-top: 0.3rem;
		padding: 0.9rem 1.2rem;
	}
	.acct .who {
		padding: 0.35rem 0.7rem;
		border: none;
		border-radius: 999px;
		background: var(--ink);
		color: var(--lime);
		font: inherit;
		letter-spacing: inherit;
		text-transform: none;
		cursor: pointer;
	}
	.unsaved {
		flex: none;
		color: #9a5b12;
	}
	.private {
		flex: none;
		color: var(--graphite);
	}

	/* --- My notes: a table of contents ------------------------------------------ */

	.returning h1 {
		font-size: clamp(2.8rem, 5.6vw, 5rem);
	}
	.index {
		margin-top: clamp(2.25rem, 4vw, 3.25rem);
	}
	.indexhead {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		padding-bottom: 0.75rem;
		border-bottom: 1.5px solid var(--ink);
	}
	.indexhead h2 {
		margin: 0;
		font-family: var(--f-serif);
		font-weight: 400;
		font-size: clamp(1.8rem, 3vw, 2.4rem);
		line-height: 1;
	}
	.indexhead .kicker {
		color: var(--graphite);
	}
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		border-bottom: 1px solid var(--rule);
	}
	.open {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 0.9rem;
		padding: 1rem 0.5rem;
		border: none;
		background: transparent;
		text-align: left;
		cursor: pointer;
		border-radius: 10px;
		transition: background 0.15s;
	}
	.open:hover {
		background: rgb(214 242 75 / 0.35);
	}
	.no {
		color: var(--smoke);
		flex: none;
	}
	.nm {
		font-family: var(--f-serif);
		font-style: italic;
		font-size: clamp(1.4rem, 2.6vw, 1.85rem);
		line-height: 1.1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.leader {
		flex: 1;
		min-width: 1.5rem;
		border-bottom: 2px dotted rgb(25 24 20 / 0.25);
		transform: translateY(-0.3em);
	}
	.role {
		flex: none;
		color: var(--graphite);
	}
	.role[data-role='owner'] {
		color: var(--ink);
		background: var(--lime);
		padding: 0.15rem 0.45rem;
		border-radius: 999px;
	}
	.when {
		flex: none;
		width: 3.2rem;
		text-align: right;
		color: var(--smoke);
	}
	.forget {
		flex: none;
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		margin-left: 0.25rem;
		border: none;
		border-radius: 50%;
		background: transparent;
		color: var(--smoke);
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s;
	}
	.forget:hover,
	.forget.on {
		background: var(--ink);
		color: var(--chalk);
	}
	.forget + .forget {
		margin-left: 0;
	}

	/* Folders: chips over the list, and a strip under a note to file it. */
	.folders {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		padding: 0.8rem 0 0.4rem;
	}
	.fchip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.3rem 0.75rem;
		border: 1px solid var(--rule);
		border-radius: 999px;
		background: var(--chalk);
		color: var(--ink);
		font: 500 0.85rem var(--f-sans);
		cursor: pointer;
	}
	.fchip .kicker {
		color: var(--smoke);
	}
	.fchip:hover {
		border-color: var(--ink);
	}
	.fchip.on {
		background: var(--ink);
		border-color: var(--ink);
		color: var(--chalk);
	}
	.fchip.on .kicker {
		color: var(--lime);
	}
	.loose {
		color: var(--smoke);
		margin-left: 0.3rem;
	}
	.filebar {
		flex-basis: 100%;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		padding: 0 0.5rem 0.9rem;
	}
	.filebar > .kicker {
		color: var(--graphite);
		margin-right: 0.2rem;
	}
	.filebar .input {
		width: 10rem;
		padding-block: 0.35rem;
	}
	.filebar .btn {
		padding-block: 0.35rem;
	}

	footer {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.5rem 1.5rem;
		margin-top: 4rem;
		padding-top: 1rem;
		border-top: 1px solid var(--rule);
		color: var(--smoke);
	}

	@media (max-width: 860px) {
		.hero {
			grid-template-columns: minmax(0, 1fr);
		}
		.duo {
			margin-top: 2rem;
		}
	}
	@media (max-width: 520px) {
		.tag {
			display: none;
		}
		.when {
			display: none;
		}
		.open {
			gap: 0.6rem;
		}
		.card {
			padding: 1.3rem 1.1rem 1.2rem;
		}
	}
	/* "optional" beside a field's label: a quieter, handwritten aside. */
	.opt {
		margin-left: 0.4em;
		font-family: var(--f-serif);
		font-size: 0.95rem;
		letter-spacing: 0;
		text-transform: none;
		color: var(--smoke);
	}
</style>

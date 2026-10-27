// The optional account: name + password. Signed in, this device's notes
// list is the account's: everything the account holds (fetched from the
// server, with fresh tokens), whatever is created or joined is kept in it,
// notes this device had before signing in move into it, and notes deleted or
// removed from it on another device leave this one too.
// Without one, everything works as before, but notes created here end when
// everyone leaves them.
//
// The session lives in localStorage on this device. Signing out forgets the
// account's notes here too (tokens and local copies), and a Zotero connection
// that came from the account: a borrowed laptop keeps nothing.
//
// The vault (vault.ts) carries the Zotero connection between devices, sealed
// with a key derived from the password at sign-in. A device signed in before
// the vault existed has no key until `unlock` (the password once more).

import {
	login,
	register,
	accountNotes,
	addToAccount,
	getVault,
	setVault,
	setAccountSession,
	SignedOutError,
	type AccountSession
} from './api';
import { noteIndex } from './noteIndex.svelte';
import { destroyNoteData, noteStore } from './noteStore.svelte';
import { zotero, validZotero, type ZoteroSettings } from './zotero.svelte';
import { deriveVaultKey, open, seal, vaultAvailable } from './vault';

const KEY = 'conote:account';

class Account {
	name = $state('');
	session = $state('');
	/** Opens the account's vault; '' until derived from the password here. */
	vaultKey = $state('');

	get signedIn() {
		return this.session !== '';
	}

	/** Hydrate from localStorage. */
	load() {
		try {
			const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
			if (v && typeof v.name === 'string' && typeof v.session === 'string') {
				this.#set(v);
				if (typeof v.vault === 'string') this.vaultKey = v.vault;
			}
		} catch {
			/* nothing stored, or unreadable: signed out */
		}
		zotero.load();
		zotero.onchange = () => void this.#pushVault();
	}

	async signIn(name: string, password: string, create: boolean) {
		this.#set(create ? await register(name, password) : await login(name, password));
		this.vaultKey = vaultAvailable() ? await deriveVaultKey(this.name, password) : '';
		this.#store();
		await this.sync();
	}

	/** Signed in already, but without the vault key (from before it existed). */
	async unlock(password: string) {
		await this.signIn(this.name, password, false);
	}

	#store() {
		try {
			localStorage.setItem(KEY, JSON.stringify({ name: this.name, session: this.session, vault: this.vaultKey }));
		} catch {
			/* signed in for this session only */
		}
	}

	/** Make this device's list the account's: push what only this device has,
	 *  pull everything the account holds, drop what it no longer does. */
	async sync() {
		if (!this.signedIn) return;
		const name = this.name;
		try {
			const mine = noteIndex.notes.filter((n) => !n.via && n.token);
			for (let i = 0; i < mine.length; i += 50) {
				const batch = mine.slice(i, i + 50).map((n) => ({ id: n.id, token: n.token, ownerKey: n.ownerKey, folder: n.folder }));
				await addToAccount(batch);
			}
			const { notes } = await accountNotes();
			if (name !== this.name) return; // signed out or in as someone else meanwhile
			const held = new Set(notes.map((n) => n.id));
			for (const n of notes) {
				const prev = noteIndex.get(n.id);
				noteIndex.save(n, { via: name, openedAt: prev?.openedAt ?? n.at ?? Date.now() });
			}
			// Deleted, or removed from the account elsewhere. A note that ended
			// (unsaved) stays: its last copy is only here.
			for (const n of noteIndex.notes.filter((n) => n.via === name && !held.has(n.id) && n.saved !== false && n.id !== noteStore.id)) {
				noteIndex.remove(n.id);
				await destroyNoteData(n.id);
			}
		} catch (e) {
			if (e instanceof SignedOutError) return await this.signOut();
			// offline: the list is what this device had
		}
		await this.pullVault();
	}

	/** The newer of the account's Zotero connection and this device's wins. */
	async pullVault() {
		const key = this.vaultKey;
		if (!key) return;
		let held: { zotero: ZoteroSettings | null; at: number } | undefined;
		try {
			const { vault } = await getVault();
			if (vault) {
				const v = (await open(key, vault)) as typeof held;
				if (v && typeof v.at === 'number' && (v.zotero === null || validZotero(v.zotero))) held = v;
			}
		} catch {
			return; // offline: try again next time
		}
		if (key !== this.vaultKey) return; // signed out or in as someone else meanwhile
		if (held && held.at >= zotero.at) {
			if (held.at > zotero.at) zotero.adopt(held.zotero, held.at);
		} else if (zotero.settings || held) await this.#pushVault();
	}

	async #pushVault() {
		const key = this.vaultKey;
		if (!key || !this.signedIn) return;
		try {
			await setVault(await seal(key, { zotero: zotero.settings, at: zotero.at }));
		} catch {
			/* offline: the next sync pushes it (this device's copy is newer) */
		}
	}

	/** Forget the account on this device, and the notes that came with it. */
	async signOut() {
		const name = this.name;
		// The Zotero connection goes too if the account had it (it can bring it back).
		if (this.vaultKey && zotero.settings) zotero.adopt(null, 0);
		this.vaultKey = '';
		this.#set({ name: '', session: '' });
		try {
			localStorage.removeItem(KEY);
		} catch {
			/* nothing to remove */
		}
		for (const n of noteIndex.notes.filter((n) => n.via === name)) {
			noteIndex.remove(n.id);
			await destroyNoteData(n.id);
		}
	}

	#set(a: AccountSession) {
		this.name = a.name;
		this.session = a.session;
		setAccountSession(a.session);
	}
}

export const account = new Account();

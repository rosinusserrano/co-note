// The optional account: name + password. Signed in, this device's notes
// list also holds everything the account holds (fetched from the server, with
// fresh tokens), and whatever is created or joined is kept in the account.
// Without one, everything works as before, but notes created here end when
// everyone leaves them.
//
// The session lives in localStorage on this device. Signing out forgets the
// account's notes here too (tokens and local copies): a borrowed laptop keeps
// nothing.

import {
	login,
	register,
	accountNotes,
	setAccountSession,
	SignedOutError,
	type AccountSession
} from './api';
import { noteIndex } from './noteIndex.svelte';
import { destroyNoteData } from './noteStore.svelte';

const KEY = 'conote:account';

class Account {
	name = $state('');
	session = $state('');

	get signedIn() {
		return this.session !== '';
	}

	/** Hydrate from localStorage. */
	load() {
		try {
			const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
			if (v && typeof v.name === 'string' && typeof v.session === 'string') this.#set(v);
		} catch {
			/* nothing stored, or unreadable: signed out */
		}
	}

	async signIn(name: string, password: string, create: boolean) {
		this.#set(create ? await register(name, password) : await login(name, password));
		try {
			localStorage.setItem(KEY, JSON.stringify({ name: this.name, session: this.session }));
		} catch {
			/* signed in for this session only */
		}
		await this.sync();
	}

	/** Pull the account's notes into this device's list. */
	async sync() {
		if (!this.signedIn) return;
		try {
			const { notes } = await accountNotes();
			for (const n of notes) {
				const prev = noteIndex.get(n.id);
				noteIndex.save(n, { via: this.name, openedAt: prev?.openedAt ?? n.at ?? Date.now() });
			}
		} catch (e) {
			if (e instanceof SignedOutError) await this.signOut();
			// offline: the list is what this device had
		}
	}

	/** Forget the account on this device, and the notes that came with it. */
	async signOut() {
		const name = this.name;
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

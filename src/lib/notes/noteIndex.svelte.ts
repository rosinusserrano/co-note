// The notes *this device* has created or joined ("My notes").
//
// Local-only (localStorage), not synced: it's this device's keyring. Each entry
// holds the token the server issued for it, so reopening a note doesn't ask for
// the passcode again — the passcode itself is never stored. A creator's entry
// also keeps the owner key, which is what unlocks the note's settings.
//
// Only metadata lives here. The strokes are in noteStore (the Yjs doc); the two
// are joined by `id`, the server's note id (see roomFor()).

import type { NoteRole, NoteSession, ViewAccess } from './api';

const STORAGE_KEY = 'conote:notes';

export interface NoteEntry {
	id: string;
	name: string;
	role: NoteRole;
	viewAccess: ViewAccess;
	token: string;
	/** Only on the device that created the note. */
	ownerKey?: string;
	/** With the owner key: marks this device's connection as the owner's, which
	 *  lets it pull the others' views. Fetched with the key if missing. */
	ownerProof?: string;
	openedAt: number;
}

class NoteIndex {
	notes = $state<NoteEntry[]>([]);

	/** Hydrate from localStorage. Safe to call more than once. */
	load() {
		if (typeof localStorage === 'undefined') return;
		try {
			const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
			this.notes = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
		} catch {
			this.notes = [];
		}
	}

	get(id: string): NoteEntry | undefined {
		return this.notes.find((n) => n.id === id);
	}

	/** Most recently opened first. */
	get recent(): NoteEntry[] {
		return [...this.notes].sort((a, b) => b.openedAt - a.openedAt);
	}

	/** Record a session from the server — a create, a join, or a renewed token.
	 *  Keeps an existing owner key / proof unless a new one is given. */
	save(session: NoteSession & { ownerKey?: string; ownerProof?: string }) {
		const prev = this.get(session.id);
		const entry: NoteEntry = {
			id: session.id,
			name: session.name,
			role: session.role,
			viewAccess: session.viewAccess,
			token: session.token,
			ownerKey: session.ownerKey ?? prev?.ownerKey,
			ownerProof: session.ownerProof ?? prev?.ownerProof,
			openedAt: Date.now()
		};
		this.notes = [...this.notes.filter((n) => n.id !== entry.id), entry];
		this.#persist();
		return entry;
	}

	touch(id: string) {
		this.notes = this.notes.map((n) => (n.id === id ? { ...n, openedAt: Date.now() } : n));
		this.#persist();
	}

	/** Forget a note on this device. Callers own deleting its stroke data — see
	 *  noteStore.destroyNoteData(). */
	remove(id: string) {
		this.notes = this.notes.filter((n) => n.id !== id);
		this.#persist();
	}

	#persist() {
		if (typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.notes));
		} catch {
			// Quota/private-mode: the in-memory list still works for this session.
		}
	}
}

function isEntry(v: unknown): v is NoteEntry {
	if (typeof v !== 'object' || v === null) return false;
	const n = v as Record<string, unknown>;
	return (
		typeof n.id === 'string' &&
		typeof n.name === 'string' &&
		(n.role === 'edit' || n.role === 'view') &&
		typeof n.token === 'string' &&
		typeof n.viewAccess === 'string' &&
		typeof n.openedAt === 'number'
	);
}

export const noteIndex = new NoteIndex();

const NAME_KEY = 'conote:name';
/** Longest name kept; presence labels are cut at 40 on the receiving side anyway. */
export const NAME_MAX = 24;

/** The name this device shows to others (cursor tag, people list); '' = none given. */
export function myName(): string {
	try {
		return (localStorage.getItem(NAME_KEY) ?? '').slice(0, NAME_MAX);
	} catch {
		return '';
	}
}

export function setMyName(name: string) {
	const clean = name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
	try {
		if (clean) localStorage.setItem(NAME_KEY, clean);
		else localStorage.removeItem(NAME_KEY);
	} catch {
		// Private mode: the name just won't be remembered.
	}
}

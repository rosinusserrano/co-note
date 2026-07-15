// The list of notes on *this device*.
//
// Deliberately local-only (localStorage), and deliberately NOT a Yjs doc: per
// ROADMAP.md notes belong to the user and live locally, while the only thing
// that is ever shared is a note you explicitly hand to someone. So the index is
// not replicated — a peer reaches a specific note by its id (`?note=<id>`),
// which is the seam the broadcast/join flow will grow out of.
//
// Only metadata lives here. The strokes are in noteStore (the Yjs doc); the
// two are joined by `id`, which is also the sync room (see roomFor()).

import { uid } from './model';

const STORAGE_KEY = 'pennable:notes';

/** The pre-notes-list note. Seeded on first run so existing drawings survive. */
export const LEGACY_NOTE_ID = 'default';

export interface NoteMeta {
	id: string;
	title: string;
	createdAt: number;
}

function seed(): NoteMeta[] {
	return [{ id: LEGACY_NOTE_ID, title: 'Untitled note', createdAt: Date.now() }];
}

class NoteIndex {
	notes = $state<NoteMeta[]>(seed());

	/** Hydrate from localStorage. Safe to call more than once. */
	load() {
		if (typeof localStorage === 'undefined') return;
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return; // first run: keep the seed so the legacy note is listed
			const parsed: unknown = JSON.parse(raw);
			const notes = Array.isArray(parsed) ? parsed.filter(isNoteMeta) : [];
			// An empty/corrupt index would strand the user with no note to open.
			this.notes = notes.length > 0 ? notes : seed();
		} catch {
			this.notes = seed();
		}
	}

	get(id: string): NoteMeta | undefined {
		return this.notes.find((n) => n.id === id);
	}

	create(title = 'Untitled note'): NoteMeta {
		const note = { id: uid(), title, createdAt: Date.now() };
		this.notes = [...this.notes, note];
		this.#persist();
		return note;
	}

	/** Add an entry for a note we didn't create — i.e. one opened by id from a
	 *  URL. The doc may be empty until a peer syncs it to us. */
	ensure(id: string): NoteMeta {
		const existing = this.get(id);
		if (existing) return existing;
		const note = { id, title: 'Shared note', createdAt: Date.now() };
		this.notes = [...this.notes, note];
		this.#persist();
		return note;
	}

	rename(id: string, title: string) {
		const clean = title.trim();
		if (!clean) return;
		this.notes = this.notes.map((n) => (n.id === id ? { ...n, title: clean } : n));
		this.#persist();
	}

	/** Forget a note locally. Callers own deleting its stroke data — see
	 *  noteStore.destroyNoteData(). Refuses to remove the last note. */
	remove(id: string): boolean {
		if (this.notes.length <= 1) return false;
		if (!this.get(id)) return false;
		this.notes = this.notes.filter((n) => n.id !== id);
		this.#persist();
		return true;
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

function isNoteMeta(v: unknown): v is NoteMeta {
	if (typeof v !== 'object' || v === null) return false;
	const n = v as Record<string, unknown>;
	return typeof n.id === 'string' && typeof n.title === 'string' && typeof n.createdAt === 'number';
}

export const noteIndex = new NoteIndex();

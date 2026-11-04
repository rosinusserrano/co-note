// Tabs: the notes open on this device, to switch between without going back
// to the start page. One note is connected at a time — switching closes one
// and opens the other, which is quick since every note is on the device
// already (IndexedDB) — and each tab keeps where you were in it: zoom, scroll,
// focus, tool. Per device (localStorage), like everything about the view.

import { noteIndex } from './noteIndex.svelte';

const KEY = 'conote:tabs';
export const MAX_TABS = 8;

/** Where you were in a tab (the session's viewport — never shared). */
export interface TabView {
	scale: number;
	x: number;
	y: number;
	focus: boolean;
	tool: string;
	brush: string;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readView(v: any): TabView | null {
	if (!v || !finite(v.scale) || v.scale <= 0 || !finite(v.x) || !finite(v.y)) return null;
	return { scale: v.scale, x: v.x, y: v.y, focus: v.focus === true, tool: String(v.tool ?? ''), brush: String(v.brush ?? '') };
}

class Tabs {
	/** Note ids, in tab order. */
	ids = $state<string[]>([]);
	#views = new Map<string, TabView>();

	load() {
		try {
			const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
			if (raw && Array.isArray(raw.ids)) {
				this.ids = raw.ids.filter((id: unknown) => typeof id === 'string').slice(0, MAX_TABS);
				for (const [id, v] of Object.entries(raw.views ?? {})) {
					const view = readView(v);
					if (view && this.ids.includes(id)) this.#views.set(id, view);
				}
			}
		} catch {
			/* nothing kept, or unreadable: no tabs */
		}
	}

	#save() {
		try {
			localStorage.setItem(KEY, JSON.stringify({ ids: this.ids, views: Object.fromEntries(this.#views) }));
		} catch {
			/* storage full or off: tabs last this session */
		}
	}

	/** The tabs whose notes are still on this device. */
	get open(): string[] {
		return this.ids.filter((id) => noteIndex.get(id));
	}

	/** A note was opened: it gets a tab (the oldest goes if there are too many). */
	add(id: string) {
		if (this.ids.includes(id)) return;
		const ids = [...this.ids.filter((t) => noteIndex.get(t)), id];
		while (ids.length > MAX_TABS) this.#views.delete(ids.shift()!);
		this.ids = ids;
		this.#save();
	}

	/** Close a tab. Returns the tab to show instead (its neighbour), or null. */
	close(id: string): string | null {
		const open = this.open;
		const i = open.indexOf(id);
		this.ids = this.ids.filter((t) => t !== id);
		this.#views.delete(id);
		this.#save();
		if (i < 0) return null;
		return open[i + 1] ?? open[i - 1] ?? null;
	}

	/** Move a tab to position `to`. */
	move(id: string, to: number) {
		const ids = this.ids.filter((t) => t !== id);
		ids.splice(Math.max(0, Math.min(to, ids.length)), 0, id);
		this.ids = ids;
		this.#save();
	}

	remember(id: string, view: TabView) {
		if (!this.ids.includes(id)) return;
		this.#views.set(id, view);
		this.#save();
	}

	view(id: string): TabView | null {
		return this.#views.get(id) ?? null;
	}
}

export const tabs = new Tabs();

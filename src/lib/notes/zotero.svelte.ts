// This device's Zotero connection: the API key (and its library), and the
// WebDAV login when the library's files sync over WebDAV (Koofr and the like)
// rather than Zotero storage. Kept in localStorage; signed in, it is also
// kept (sealed) in the account's vault, so every device that signs in has it
// (see account.svelte.ts / vault.ts). The server relays requests with it
// (server/zotero.js) but never stores it readable.

import type { ZoteroCreds } from './api';

const KEY = 'conote:zotero';
/** When the connection last changed here (or was taken from the account). */
const AT_KEY = 'conote:zotero:at';

export type ZoteroSettings = ZoteroCreds & { username: string };

export const validZotero = (v: unknown): v is ZoteroSettings => {
	const z = v as ZoteroSettings;
	return !!z && typeof z === 'object' && typeof z.apiKey === 'string' && typeof z.userId === 'string';
};

class Zotero {
	settings = $state<ZoteroSettings | null>(null);
	at = 0;
	/** Called after a change made here (the account pushes it to its vault). */
	onchange: (() => void) | null = null;

	load() {
		try {
			const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
			if (validZotero(v)) this.settings = v;
			// Set up before the vault: older than any change, newer than nothing.
			this.at = Number(localStorage.getItem(AT_KEY)) || (this.settings ? 1 : 0);
		} catch {
			/* not set up */
		}
	}

	save(s: ZoteroSettings) {
		this.adopt(s, Date.now());
		this.onchange?.();
	}

	clear() {
		this.adopt(null, Date.now());
		this.onchange?.();
	}

	/** Take `s` as of `at` without telling anyone (from the account, or a change here). */
	adopt(s: ZoteroSettings | null, at: number) {
		this.settings = s;
		this.at = at;
		try {
			if (s) localStorage.setItem(KEY, JSON.stringify(s));
			else localStorage.removeItem(KEY);
			localStorage.setItem(AT_KEY, String(at));
		} catch {
			/* for this session only */
		}
	}
}

export const zotero = new Zotero();

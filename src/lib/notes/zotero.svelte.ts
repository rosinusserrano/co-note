// This device's Zotero connection: the API key (and its library), and the
// WebDAV login when the library's files sync over WebDAV (Koofr and the like)
// rather than Zotero storage. Kept in localStorage on this device only; the
// server relays requests with them (server/zotero.js) but never stores them.

import type { ZoteroCreds } from './api';

const KEY = 'conote:zotero';

export type ZoteroSettings = ZoteroCreds & { username: string };

class Zotero {
	settings = $state<ZoteroSettings | null>(null);

	load() {
		try {
			const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
			if (v && typeof v.apiKey === 'string' && typeof v.userId === 'string') this.settings = v;
		} catch {
			/* not set up */
		}
	}

	save(s: ZoteroSettings) {
		this.settings = s;
		try {
			localStorage.setItem(KEY, JSON.stringify(s));
		} catch {
			/* for this session only */
		}
	}

	clear() {
		this.settings = null;
		try {
			localStorage.removeItem(KEY);
		} catch {
			/* nothing stored */
		}
	}
}

export const zotero = new Zotero();

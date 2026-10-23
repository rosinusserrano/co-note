// HTTP side of the note server (server/sync-server.js): create a note, trade a
// passcode for a token, and the owner's settings. The token is what the
// WebSocket connection presents; the server decides the role from it.

export type NoteRole = 'edit' | 'view';
/** Who can observe: with the observer passcode, anyone with the name, or nobody. */
export type ViewAccess = 'passcode' | 'open' | 'none';

/** The observer settings, as the forms offer them. */
export const VIEW_ACCESS: { value: ViewAccess; label: string; hint: string }[] = [
	{ value: 'passcode', label: 'Passcode', hint: 'Observers need their own passcode to watch.' },
	{ value: 'open', label: 'Anyone', hint: 'Anyone who knows the name can watch.' },
	{ value: 'none', label: 'Nobody', hint: 'No observers: editors only.' }
];

export interface NoteSession {
	id: string;
	name: string;
	role: NoteRole;
	viewAccess: ViewAccess;
	token: string;
	/** Kept after everyone leaves (it belongs to an account). False: it ends then. */
	saved?: boolean;
	/** The signed-in account owns it: owner rights without the owner key. */
	owned?: boolean;
	/** From the account's list: the passcode changed since; no token. */
	locked?: boolean;
	/** No editor passcode: only the account it belongs to opens it. */
	private?: boolean;
}

/** What the owner key gets: an editor session plus the owner proof (see
 *  verifyOwnerProof in server/registry.js). */
export interface OwnerSession extends NoteSession {
	ownerProof: string;
}

export class ApiError extends Error {}

/** Same-origin `/api` behind Caddy; the server's own port when the page comes
 *  from a dev port — mirrors serverUrl() in noteStore. */
function apiBase(): string {
	return location.port ? `${location.protocol}//${location.hostname}:5182/api` : '/api';
}

/** The signed-in account's session, sent with every call (see account.svelte.ts). */
let accountSession = '';
export const setAccountSession = (s: string) => (accountSession = s);

/** The server said the account session is no longer good. */
export class SignedOutError extends Error {}

async function post<T>(path: string, body: object): Promise<T> {
	let res: Response;
	try {
		res = await fetch(apiBase() + path, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(accountSession ? { Authorization: `Bearer ${accountSession}` } : {})
			},
			body: JSON.stringify(body)
		});
	} catch {
		throw new ApiError("Can't reach the server. Check your connection.");
	}
	const data = await res.json().catch(() => ({}));
	if (res.status === 401) throw new SignedOutError(data.error ?? 'Please sign in again.');
	if (!res.ok) throw new ApiError(data.error ?? `Server error (${res.status}).`);
	return data as T;
}

/** "Math Class " → "math-class", exactly as the server normalises names. */
export const normalizeName = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, '-');

export const createNote = (body: {
	name: string;
	editPasscode?: string;
	viewAccess: ViewAccess;
	viewPasscode?: string;
	/** Signed in only: no passcode, just this account. */
	private?: boolean;
}) => post<OwnerSession & { ownerKey: string }>('/notes', body);

/** Signed in, an empty passcode opens a note the account already holds. */
export const joinNote = (name: string, passcode: string) =>
	post<NoteSession>('/join', { name, passcode });

/** With the owner key, or (no key) as the account that owns the note. */
export const ownerSession = (id: string, ownerKey?: string) =>
	post<OwnerSession>('/owner/session', { id, ownerKey });

/** Omitted fields stay as they are. Returns a fresh session for the owner,
 *  since changing the editor passcode revokes their old token too. */
export const updateSettings = (body: {
	id: string;
	ownerKey?: string;
	editPasscode?: string;
	viewAccess?: ViewAccess;
	viewPasscode?: string;
	/** No editor passcode any more: only the owning account opens it. */
	private?: boolean;
}) => post<OwnerSession>('/owner/settings', body);

/** People join with the new name from then on; devices on the note see it change. */
export const renameNote = (id: string, name: string, ownerKey?: string) =>
	post<OwnerSession>('/owner/rename', { id, name, ownerKey });

export const deleteNote = (id: string, ownerKey?: string) =>
	post<{ ok: true }>('/owner/delete', { id, ownerKey });

// --- Zotero (relayed by the server, signed in only; see server/zotero.js) -----------

export interface ZoteroCreds {
	apiKey: string;
	userId: string;
	/** Set when the library's files sync over WebDAV instead of Zotero storage. */
	webdav?: { url: string; user: string; password: string };
}
export interface ZoteroItem {
	key: string;
	title: string;
	creators: string;
	year: string;
	children: number;
}
export interface ZoteroPdf {
	key: string;
	title: string;
	filename: string;
	parent: string | null;
}

export const zoteroVerify = (apiKey: string) =>
	post<{ userId: string; username: string; write: boolean }>('/zotero/verify', { apiKey });
export const zoteroSearch = (c: ZoteroCreds, q: string) => post<{ items: ZoteroItem[] }>('/zotero/search', { ...c, q });
export const zoteroPdfs = (c: ZoteroCreds, key: string) => post<{ pdfs: ZoteroPdf[] }>('/zotero/pdfs', { ...c, key });

async function binary(path: string, body: BodyInit, json: boolean): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(apiBase() + path, {
			method: 'POST',
			headers: {
				...(json ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/octet-stream' }),
				...(accountSession ? { Authorization: `Bearer ${accountSession}` } : {})
			},
			body
		});
	} catch {
		throw new ApiError("Can't reach the server. Check your connection.");
	}
	if (res.ok) return res;
	const data = await res.json().catch(() => ({}));
	if (res.status === 401) throw new SignedOutError(data.error ?? 'Please sign in again.');
	throw new ApiError(data.error ?? `Server error (${res.status}).`);
}

export async function zoteroFile(c: ZoteroCreds, key: string): Promise<Uint8Array> {
	const res = await binary('/zotero/file', JSON.stringify({ ...c, key }), true);
	return new Uint8Array(await res.arrayBuffer());
}

/** Save a PDF as an attachment: replacing `key` if it's still there, else new under `parent`. */
export async function zoteroSave(
	c: ZoteroCreds,
	meta: { key?: string; parent?: string; title: string; filename: string },
	pdf: Uint8Array
): Promise<{ key: string }> {
	const head = new TextEncoder().encode(JSON.stringify({ ...c, ...meta }));
	const body = new Uint8Array(4 + head.length + pdf.length);
	new DataView(body.buffer).setUint32(0, head.length);
	body.set(head, 4);
	body.set(pdf, 4 + head.length);
	return (await binary('/zotero/save', body, false)).json();
}

// --- Accounts ----------------------------------------------------------------------

export interface AccountSession {
	name: string;
	session: string;
}

export const register = (name: string, password: string) =>
	post<AccountSession>('/account/register', { name, password });

export const login = (name: string, password: string) => post<AccountSession>('/account/login', { name, password });

/** Every note the account holds, with fresh tokens (`at`: when it was granted). */
export const accountNotes = () => post<{ notes: (NoteSession & { ownerProof?: string; at?: number })[] }>('/account/notes', {});

/** Bring notes this device holds (tokens, and owner keys) into the account. */
export const addToAccount = (notes: { id: string; token: string; ownerKey?: string }[]) =>
	post<{ added: string[] }>('/account/add', { notes });

export const forgetInAccount = (id: string) => post<{ ok: true }>('/account/forget', { id });
export const getVault = () => post<{ vault: string | null }>('/account/vault', {});
export const setVault = (vault: string) => post<{ ok: true }>('/account/vault/set', { vault });

/** Keep a note this device owns (by key) in the account. */
export const claimNote = (id: string, ownerKey?: string) => post<OwnerSession>('/account/claim', { id, ownerKey });

// --- Files (imported PDFs) -----------------------------------------------------
// The note token goes in the Authorization header; the server checks it like
// the WebSocket's, so only editors can add a file and a passcode change cuts
// access. Files are content-addressed by sha256.

async function fileRequest(path: string, token: string, init: RequestInit = {}): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(apiBase() + path, {
			...init,
			headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` }
		});
	} catch {
		throw new ApiError("Can't reach the server. Check your connection.");
	}
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new ApiError(data.error ?? `Server error (${res.status}).`);
	}
	return res;
}

export async function uploadFile(noteId: string, token: string, bytes: Uint8Array): Promise<string> {
	const res = await fileRequest(`/files/${encodeURIComponent(noteId)}`, token, {
		method: 'POST',
		body: new Blob([bytes.slice()], { type: 'application/pdf' })
	});
	const { hash } = await res.json();
	return String(hash);
}

export async function downloadFile(noteId: string, hash: string, token: string): Promise<Uint8Array> {
	const res = await fileRequest(`/files/${encodeURIComponent(noteId)}/${hash}`, token);
	return new Uint8Array(await res.arrayBuffer());
}

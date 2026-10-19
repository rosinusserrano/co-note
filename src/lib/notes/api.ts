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

async function post<T>(path: string, body: object): Promise<T> {
	let res: Response;
	try {
		res = await fetch(apiBase() + path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
	} catch {
		throw new ApiError("Can't reach the server. Check your connection.");
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError(data.error ?? `Server error (${res.status}).`);
	return data as T;
}

/** "Math Class " → "math-class", exactly as the server normalises names. */
export const normalizeName = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, '-');

export const createNote = (body: {
	name: string;
	editPasscode: string;
	viewAccess: ViewAccess;
	viewPasscode?: string;
}) => post<OwnerSession & { ownerKey: string }>('/notes', body);

export const joinNote = (name: string, passcode: string) =>
	post<NoteSession>('/join', { name, passcode });

export const ownerSession = (id: string, ownerKey: string) =>
	post<OwnerSession>('/owner/session', { id, ownerKey });

/** Omitted fields stay as they are. Returns a fresh session for the owner,
 *  since changing the editor passcode revokes their old token too. */
export const updateSettings = (body: {
	id: string;
	ownerKey: string;
	editPasscode?: string;
	viewAccess?: ViewAccess;
	viewPasscode?: string;
}) => post<OwnerSession>('/owner/settings', body);

export const deleteNote = (id: string, ownerKey: string) =>
	post<{ ok: true }>('/owner/delete', { id, ownerKey });

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

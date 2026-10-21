// The account's vault: a small encrypted blob the server keeps for an account
// (today: the Zotero connection), so every device that signs in has it. It is
// encrypted here with a key derived from the account password, so what sits
// on the server's disk (and in its backups) is unreadable without it. The
// server does see the password at sign-in, and the Zotero key on every
// request it relays — this protects data at rest, not against the server.
//
// The key is derived at sign-in (the only time this device has the password)
// and kept with the session in localStorage. Needs Web Crypto, i.e. a secure
// context (https or localhost); elsewhere the vault is simply off.

const ITERATIONS = 310_000;

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const vaultAvailable = () => typeof crypto !== 'undefined' && !!crypto.subtle;

/** The raw vault key for `name` + `password`, base64. Same on every device. */
export async function deriveVaultKey(name: string, password: string): Promise<string> {
	const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
	const salt = new TextEncoder().encode(`conote vault:${name.trim().toLowerCase()}`);
	const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, 256);
	return b64(new Uint8Array(bits));
}

const aesKey = (key: string) => crypto.subtle.importKey('raw', unb64(key), 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function seal(key: string, value: unknown): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = new TextEncoder().encode(JSON.stringify(value));
	const box = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(key), data));
	return `v1.${b64(iv)}.${b64(box)}`;
}

/** @returns the sealed value, or undefined if it can't be opened with `key`. */
export async function open(key: string, sealed: string): Promise<unknown> {
	const [v, iv, box] = sealed.split('.');
	if (v !== 'v1' || !iv || !box) return undefined;
	try {
		const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(key), unb64(box));
		return JSON.parse(new TextDecoder().decode(data));
	} catch {
		return undefined;
	}
}

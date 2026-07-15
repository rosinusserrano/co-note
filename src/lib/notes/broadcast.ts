// Broadcast IDs and edit tokens.
//
// Two separate secrets, per ROADMAP's "discovery vs security" question:
//
//   - broadcastId — the room address. Shareable, short enough to read aloud.
//     Holding it gets you a READ-ONLY view.
//   - editToken   — a second, longer secret. Holding it *as well* gets you edit.
//
// Splitting them is what lets you hand out a view link without handing out
// write access. The token is never sent through the signaling server: it goes
// over the WebRTC data channel once the peer connection is up, so the central
// server only ever does matchmaking (see server/signal-server.js).
//
// The broadcaster is the only thing that validates a token — a joiner claiming
// `role: 'edit'` proves nothing. See webrtcStar.ts.

/** Crockford-ish: no 0/O, 1/I/L, U — so an id survives being read out loud. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Uniform random string over ALPHABET. Uses rejection sampling rather than
 * `byte % len`, which would bias toward the first 16 symbols (256 % 30 = 16)
 * and quietly cost entropy in something we're using as an access secret.
 */
function randomString(len: number): string {
	const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length; // 240
	let out = '';
	const buf = new Uint8Array(len * 2);
	while (out.length < len) {
		crypto.getRandomValues(buf);
		for (let i = 0; i < buf.length && out.length < len; i++) {
			if (buf[i] < max) out += ALPHABET[buf[i] % ALPHABET.length];
		}
	}
	return out;
}

/** ~39 bits. Guessing one only buys a read-only view of a live broadcast. */
export const newBroadcastId = () => randomString(8);

/** ~78 bits. This is the thing that grants write access — keep it long. */
export const newEditToken = () => randomString(16);

/**
 * Compare without leaking length/prefix through timing. Best-effort in JS (the
 * engine gives no real guarantees), but it costs nothing and the alternative is
 * a plainly timing-dependent `===` on a write credential.
 */
export function tokensMatch(a: string, b: string): boolean {
	if (typeof a !== 'string' || typeof b !== 'string') return false;
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export type Role = 'host' | 'edit' | 'view';

/** The note id a joined broadcast is filed under locally, so it persists and
 *  shows up in the note list like any other note. */
export const noteIdForBroadcast = (broadcastId: string) => `b-${broadcastId}`;

export interface BroadcastLinks {
	view: string;
	edit: string;
}

/** Share links for a live broadcast, built off the current page URL. */
export function broadcastLinks(id: string, token: string, base = location.href): BroadcastLinks {
	const mk = (withToken: boolean) => {
		const u = new URL(base);
		u.search = '';
		u.searchParams.set('b', id);
		if (withToken) u.searchParams.set('t', token);
		return u.toString();
	};
	return { view: mk(false), edit: mk(true) };
}

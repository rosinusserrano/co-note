// Direct device-to-device links for a note: how its devices talk.
//
// The server stays the connecting point: it checks passcodes, mints tokens and
// introduces devices (server/sync-server.js, "P2P matchmaking"). Once
// introduced, devices exchange strokes *and presence* (cursors, views, live
// strokes, lasers, pulls) over WebRTC data channels — nothing between them
// goes through the server. A device linked to the hub goes quiet on the relay
// (relayMode.ts); the hub keeps the server's copy, in batches. The relay is
// the fallback when WebRTC can't get through (hard NAT, no STUN): such a
// device stays on it, and the hub passes things between it and the others.
//
// WHY A STAR, NOT A MESH (unchanged from the v1 broadcast):
//   Read-only has to be enforced, not just hidden in the observer's UI. In a
//   mesh (y-webrtc) an observer running a patched client could push updates
//   straight to the others. In a star every device has one link, to the hub,
//   and the hub knows which link each update came in on, so it drops writes
//   from observers before they reach anyone. The server only forwards signals
//   that have the hub at one end, so no other link can form.
//
// Roles come from the server, which read them from each device's verified
// token. A device's own idea of its role is never consulted.
//
// Presence follows the same star: a device sends only its own awareness
// state to the hub, which checks it (only that device's client id; `laser` /
// `live` only from editors; `pull` / `lead` only from the owner — the same
// fields the relay strips) and fans it out. The server tells everyone whether
// the hub is the owner; if it isn't, `pull` / `lead` from the hub are ignored,
// so an editor acting as hub can't move anyone's view.
//
// Data channel protocol (hand-rolled on plain yjs; simple-peer wants Node
// globals Vite won't supply):
//   SV         "here's my state vector; send me what I'm missing"
//   UPDATE     a Yjs update
//   AWARENESS  a y-protocols awareness update

import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const TAG_SV = 0;
const TAG_UPDATE = 1;
const TAG_AWARENESS = 2;

/** Presence fields only the owner may send, and only editors. */
const OWNER_FIELDS = ['pull', 'lead'];
const EDITOR_FIELDS = ['laser', 'live'];

// Close codes from server/sync-server.js. Retrying can't help after these.
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_GONE = 4404;
const CLOSE_ENDED = 4410;

/** STUN only. A TURN server would relay the stroke data, which is the one
 *  thing direct links exist to avoid; pairs that can't connect directly just
 *  keep using the relay. */
export const DEFAULT_ICE: RTCConfiguration = {
	iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

/** A link that hasn't opened by then is given up on (and retried later). */
const CONNECT_TIMEOUT_MS = 15_000;
const RETRY_MS = 20_000;

type Role = 'edit' | 'view';

function frame(tag: number, payload: Uint8Array): ArrayBuffer {
	const out = new Uint8Array(payload.length + 1);
	out[0] = tag;
	out.set(payload, 1);
	return out.buffer;
}

/** An update that carries nothing (what a diff against an up-to-date peer
 *  looks like): no structs, empty delete set. */
const isEmptyUpdate = (u: Uint8Array) => u.length <= 2 && u.every((b) => b === 0);

/**
 * An awareness update with `fields` removed from every state and the clients
 * `keep` refuses left out. Returns the client ids kept and the update (null
 * if nothing is left). Format (y-protocols): count, then per client: id,
 * clock, JSON state.
 */
function filterAwareness(
	update: Uint8Array,
	fields: string[],
	keep: (client: number, first: number) => boolean
): { ids: number[]; update: Uint8Array | null } {
	const dec = decoding.createDecoder(update);
	const kept: [number, number, string][] = [];
	let first = -1;
	for (let n = decoding.readVarUint(dec); n > 0; n--) {
		const client = decoding.readVarUint(dec);
		const clock = decoding.readVarUint(dec);
		let json = decoding.readVarString(dec);
		if (first < 0) first = client;
		if (!keep(client, first)) continue;
		if (fields.length > 0) {
			const state = JSON.parse(json);
			if (state && typeof state === 'object' && fields.some((f) => f in state)) {
				for (const f of fields) delete state[f];
				json = JSON.stringify(state);
			}
		}
		kept.push([client, clock, json]);
	}
	if (kept.length === 0) return { ids: [], update: null };
	const enc = encoding.createEncoder();
	encoding.writeVarUint(enc, kept.length);
	for (const [client, clock, json] of kept) {
		encoding.writeVarUint(enc, client);
		encoding.writeVarUint(enc, clock);
		encoding.writeVarString(enc, json);
	}
	return { ids: kept.map((k) => k[0]), update: encoding.toUint8Array(enc) };
}

/** ICE candidates can arrive before the description they belong to, and
 *  addIceCandidate() throws without one. Buffer until there is one. */
class CandidateQueue {
	#pending: RTCIceCandidateInit[] = [];
	#ready = false;
	constructor(private pc: RTCPeerConnection) {}
	async add(c: RTCIceCandidateInit) {
		if (!this.#ready) return void this.#pending.push(c);
		await this.pc.addIceCandidate(c).catch(() => {});
	}
	async flush() {
		this.#ready = true;
		const q = this.#pending;
		this.#pending = [];
		for (const c of q) await this.pc.addIceCandidate(c).catch(() => {});
	}
}

/** One WebRTC link: hub → device on the hub, device → hub everywhere else. */
interface Link {
	peer: string;
	/** The remote device's role. Only the hub's view of it matters. */
	role: Role;
	/** The remote device is the note's owner (from the server, hub's view). */
	owner: boolean;
	/** Awareness client ids that came in over this link (a device's own, on
	 *  the hub; everyone the hub passed on, elsewhere): dropped with the link. */
	clients: Set<number>;
	/** Presence has come over it: the other end speaks AWARENESS (a hub from
	 *  before it doesn't, and then the relay must keep carrying presence). */
	heard: boolean;
	pc: RTCPeerConnection;
	dc: RTCDataChannel | null;
	cands: CandidateQueue;
	timer: ReturnType<typeof setTimeout>;
}

export interface P2PState {
	/** Open direct links. */
	links: number;
	/** Whether this device is the hub. */
	hub: boolean;
	/** The server says the hub is the note's owner. */
	hubOwner: boolean;
	/** Not the hub, and the hub's link carries everything, presence too: the
	 *  relay can go quiet. */
	carried: boolean;
	/** Updates the hub dropped because an observer sent them. Kept observable
	 *  so enforcement is a fact you can check, not a claim. */
	rejected: number;
	/** 'revoked' / 'gone' mirror the relay's close codes. */
	status: 'connecting' | 'ready' | 'revoked' | 'gone' | 'closed';
}

export class P2PLinks {
	#doc: Y.Doc;
	#aw: awarenessProtocol.Awareness;
	#url: string;
	#ice: RTCConfiguration;
	#remoteOrigin: () => unknown;
	#onChange: (s: P2PState) => void;

	#ws: WebSocket | null = null;
	#me = '';
	#hub: string | null = null;
	#hubOwner = false;
	/** On the hub: the devices the server says should link to us. */
	#listed = new Map<string, { role: Role; owner: boolean }>();
	#links = new Map<string, Link>();
	#rejected = 0;
	#status: P2PState['status'] = 'connecting';
	#closed = false;
	#retry: ReturnType<typeof setTimeout> | null = null;
	#backoff = 1000;
	#docUpdate: (u: Uint8Array, origin: unknown) => void;
	#awUpdate: (c: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void;

	/**
	 * `url` is the matchmaking socket, token included. `remoteOrigin` is the
	 * origin updates from the hub are applied with: the relay provider, so it
	 * doesn't upload what the hub already did, and so undo leaves them alone.
	 * `awareness` is the note's presence (the relay provider's).
	 */
	constructor(
		doc: Y.Doc,
		url: string,
		opts: {
			awareness: awarenessProtocol.Awareness;
			remoteOrigin: () => unknown;
			onChange: (s: P2PState) => void;
			ice?: RTCConfiguration;
		}
	) {
		this.#doc = doc;
		this.#aw = opts.awareness;
		this.#url = url;
		this.#ice = opts.ice ?? DEFAULT_ICE;
		this.#remoteOrigin = opts.remoteOrigin;
		this.#onChange = opts.onChange;

		this.#docUpdate = (update, origin) => {
			if (this.#isHub) {
				// Fan out everything, whoever it came from (local, relay, a device),
				// except back to the link it arrived on.
				const msg = frame(TAG_UPDATE, update);
				for (const link of this.#links.values()) if (origin !== link) this.#send(link, msg);
			} else if (origin !== this.#remoteOrigin()) {
				// The hub already has what came from it or from the relay.
				for (const link of this.#links.values()) this.#send(link, frame(TAG_UPDATE, update));
			}
		};
		doc.on('update', this.#docUpdate);

		this.#awUpdate = ({ added, updated, removed }, origin) => {
			if (this.#isHub) {
				// Everyone's presence (ours, the devices', the relay's) to every
				// device but the one it came from.
				const changed = added.concat(updated, removed);
				const msg = frame(TAG_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.#aw, changed));
				for (const link of this.#links.values()) if (origin !== link) this.#send(link, msg);
			} else {
				// Only our own state goes to the hub; the rest came from it.
				const me = this.#doc.clientID;
				if (!added.includes(me) && !updated.includes(me) && !removed.includes(me)) return;
				const msg = frame(TAG_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.#aw, [me]));
				for (const link of this.#links.values()) this.#send(link, msg);
			}
		};
		this.#aw.on('update', this.#awUpdate);
		this.#open();
	}

	get state(): P2PState {
		let links = 0;
		let heard = false;
		for (const l of this.#links.values()) {
			if (l.dc?.readyState !== 'open') continue;
			links++;
			heard ||= l.heard;
		}
		const hub = this.#isHub;
		return { links, hub, hubOwner: this.#hubOwner, carried: !hub && heard, rejected: this.#rejected, status: this.#status };
	}

	get #isHub() {
		return this.#me !== '' && this.#me === this.#hub;
	}

	#changed() {
		if (!this.#closed) this.#onChange(this.state);
	}

	// --- Matchmaking socket ----------------------------------------------------

	#open() {
		const ws = new WebSocket(this.#url);
		this.#ws = ws;
		ws.onmessage = (e) => {
			if (this.#ws === ws) this.#onSignalMessage(e.data);
		};
		ws.onclose = (e) => {
			if (this.#ws !== ws) return;
			this.#ws = null;
			// Whoever we were linked with, the server no longer vouches for this
			// session: it may have picked a new hub, or revoked us.
			this.#me = '';
			this.#hub = null;
			this.#dropAll();
			if (this.#closed) return;
			if (e.code === CLOSE_UNAUTHORIZED || e.code === CLOSE_GONE || e.code === CLOSE_ENDED) {
				this.#status = e.code === CLOSE_UNAUTHORIZED ? 'revoked' : 'gone';
				this.#changed();
				return;
			}
			this.#status = 'connecting';
			this.#changed();
			this.#retry = setTimeout(() => this.#open(), this.#backoff);
			this.#backoff = Math.min(this.#backoff * 2, 30_000);
		};
	}

	/** Reconnect with a new token, e.g. after the passcodes changed. */
	setUrl(url: string) {
		this.#url = url;
		if (this.#closed) return;
		if (this.#retry) clearTimeout(this.#retry);
		const old = this.#ws;
		this.#ws = null;
		old?.close();
		this.#me = '';
		this.#hub = null;
		this.#dropAll();
		this.#status = 'connecting';
		this.#backoff = 1000;
		this.#open();
		this.#changed();
	}

	#signal(to: string, data: unknown) {
		if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: 'signal', to, data }));
	}

	#onSignalMessage(raw: unknown) {
		let m: any;
		try {
			m = JSON.parse(String(raw));
		} catch {
			return;
		}
		if (m.t === 'welcome') {
			this.#me = String(m.id);
			this.#status = 'ready';
			this.#backoff = 1000;
		} else if (m.t === 'hub') {
			const hub = typeof m.hub === 'string' ? m.hub : null;
			if (hub !== this.#hub) {
				// New hub: links to the old one (or, if we were it, to everyone) are void.
				this.#hub = hub;
				this.#dropAll();
			}
			this.#hubOwner = m.hubOwner === true;
			if (this.#isHub) {
				this.#listed = new Map(
					(Array.isArray(m.peers) ? m.peers : []).map((p: any) => [
						String(p.id),
						{ role: p.role === 'edit' ? 'edit' : 'view', owner: p.owner === true && p.role === 'edit' }
					])
				);
				this.#reconcile();
			}
		} else if (m.t === 'signal') {
			void this.#onSignal(String(m.from), m.data);
		}
		this.#changed();
	}

	// --- Links -----------------------------------------------------------------

	/** Hub: link up with every listed device, and cut anyone no longer listed
	 *  (left, or revoked by a passcode change). */
	#reconcile() {
		for (const link of [...this.#links.values()]) {
			const listed = this.#listed.get(link.peer);
			// Gone, or its role changed (the server re-announced it): link again.
			if (!listed || listed.role !== link.role || listed.owner !== link.owner) this.#drop(link);
		}
		for (const [peer, p] of this.#listed) if (!this.#links.has(peer)) void this.#offer(peer, p.role, p.owner);
	}

	#newLink(peer: string, role: Role, owner = false): Link {
		const pc = new RTCPeerConnection(this.#ice);
		const link: Link = {
			peer,
			role,
			owner,
			clients: new Set(),
			heard: false,
			pc,
			dc: null,
			cands: new CandidateQueue(pc),
			// Never opened: give up so it doesn't sit there forever; the hub retries.
			timer: setTimeout(() => this.#fail(link), CONNECT_TIMEOUT_MS)
		};
		this.#links.set(peer, link);
		pc.onicecandidate = (e) => {
			if (e.candidate && this.#links.get(peer) === link) this.#signal(peer, { candidate: e.candidate.toJSON() });
		};
		pc.onconnectionstatechange = () => {
			if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.#fail(link);
		};
		return link;
	}

	/** Hub side: we offer and own the channel. */
	async #offer(peer: string, role: Role, owner: boolean) {
		const link = this.#newLink(peer, role, owner);
		this.#wire(link, link.pc.createDataChannel('yjs'));
		try {
			await link.pc.setLocalDescription(await link.pc.createOffer());
			if (this.#links.get(peer) === link) this.#signal(peer, { sdp: link.pc.localDescription });
		} catch {
			this.#fail(link);
		}
	}

	async #onSignal(from: string, data: any) {
		if (!data) return;
		let link = this.#links.get(from);
		if (data.sdp?.type === 'offer') {
			// Only the hub offers, and we only accept offers from the one the server named.
			if (this.#isHub || from !== this.#hub) return;
			if (link) this.#drop(link); // the hub started over
			const fresh = this.#newLink(from, 'edit');
			fresh.pc.ondatachannel = (e) => this.#wire(fresh, e.channel);
			try {
				await fresh.pc.setRemoteDescription(data.sdp);
				await fresh.cands.flush();
				await fresh.pc.setLocalDescription(await fresh.pc.createAnswer());
				if (this.#links.get(from) === fresh) this.#signal(from, { sdp: fresh.pc.localDescription });
			} catch {
				this.#fail(fresh);
			}
		} else if (data.sdp?.type === 'answer' && link) {
			const answered = link;
			await answered.pc.setRemoteDescription(data.sdp).catch(() => this.#fail(answered));
			await answered.cands.flush();
		} else if (data.candidate && link) {
			await link.cands.add(data.candidate);
		}
	}

	#wire(link: Link, dc: RTCDataChannel) {
		link.dc = dc;
		dc.binaryType = 'arraybuffer';
		dc.onopen = () => {
			clearTimeout(link.timer);
			// Both ends ask for what they're missing.
			this.#send(link, frame(TAG_SV, Y.encodeStateVector(this.#doc)));
			if (this.#isHub) {
				// Everyone we know of, to the newcomer.
				const all = [...this.#aw.getStates().keys()];
				this.#send(link, frame(TAG_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.#aw, all)));
			} else {
				// Ours, at a new clock: the hub may still hold it at the old one
				// (dropped with an earlier link), and would ignore a replay.
				const st = this.#aw.getLocalState();
				if (st) this.#aw.setLocalState({ ...st });
			}
			this.#changed();
		};
		dc.onclose = () => this.#fail(link);
		dc.onmessage = (e) => {
			if (this.#links.get(link.peer) === link) this.#onData(link, e.data);
		};
	}

	#onData(link: Link, data: unknown) {
		if (!(data instanceof ArrayBuffer) || data.byteLength === 0) return;
		const bytes = new Uint8Array(data);
		const payload = bytes.subarray(1);
		try {
			if (bytes[0] === TAG_SV) {
				const diff = Y.encodeStateAsUpdate(this.#doc, payload);
				if (!isEmptyUpdate(diff)) this.#send(link, frame(TAG_UPDATE, diff));
			} else if (bytes[0] === TAG_UPDATE) {
				if (!this.#isHub) {
					Y.applyUpdate(this.#doc, payload, this.#remoteOrigin());
					return;
				}
				// *** The enforcement point. *** An observer's write dies here: not
				// applied, so never fanned out, and in a star there is no other route.
				if (link.role !== 'edit') {
					this.#rejected++;
					this.#changed();
					return;
				}
				// Origin = the link, so the fan-out skips it and undo ignores it.
				Y.applyUpdate(this.#doc, payload, link);
			} else if (bytes[0] === TAG_AWARENESS) {
				this.#onAwareness(link, payload);
			}
		} catch {
			// Garbage from a device costs it the link, not us the note.
			this.#drop(link);
		}
	}

	/** Presence over a link. On the hub: one device's own state, checked like
	 *  the relay checks it (the same fields stripped), then fanned out by
	 *  `#awUpdate`. Elsewhere: everyone's, from the hub. */
	#onAwareness(link: Link, payload: Uint8Array) {
		if (!link.heard) {
			link.heard = true;
			this.#changed();
		}
		const me = this.#doc.clientID;
		let f: { ids: number[]; update: Uint8Array | null };
		if (this.#isHub) {
			const banned = [...(link.owner ? [] : OWNER_FIELDS), ...(link.role === 'edit' ? [] : EDITOR_FIELDS)];
			// A device speaks for itself only: the first client id it ever sent
			// is its own, and nothing else from it counts.
			const own: number | undefined = link.clients.values().next().value;
			f = filterAwareness(payload, banned, (c, first) => c !== me && c === (own ?? first));
		} else {
			// Nobody else writes our state.
			f = filterAwareness(payload, this.#hubOwner ? [] : OWNER_FIELDS, (c) => c !== me);
		}
		if (!f.update) return;
		for (const id of f.ids) link.clients.add(id);
		awarenessProtocol.applyAwarenessUpdate(this.#aw, f.update, link);
	}

	#send(link: Link, msg: ArrayBuffer) {
		if (link.dc?.readyState !== 'open') return;
		try {
			link.dc.send(msg);
		} catch {
			/* channel died mid-send; onclose cleans up */
		}
	}

	/** A link that failed or closed by itself: the hub tries again later, if
	 *  the device is still listed by then. Meanwhile the relay carries strokes. */
	#fail(link: Link) {
		if (!this.#drop(link) || !this.#isHub) return;
		setTimeout(() => {
			if (this.#isHub && !this.#closed && !this.#links.has(link.peer)) this.#reconcile();
		}, RETRY_MS);
	}

	/** Close a link, if it is still the current one for its device (callbacks
	 *  of a replaced link can fire late). Returns whether it was. */
	#drop(link: Link): boolean {
		if (this.#links.get(link.peer) !== link) return false;
		this.#links.delete(link.peer);
		clearTimeout(link.timer);
		this.#forget(link);
		try {
			link.dc?.close();
			link.pc.close();
		} catch {
			/* already gone */
		}
		this.#changed();
		return true;
	}

	#dropAll() {
		for (const link of [...this.#links.values()]) this.#drop(link);
	}

	/** The presence that came over a link goes with it — and so do the
	 *  clocks, so the same states coming back (a new link, the relay) count. */
	#forget(link: Link) {
		const ids = [...link.clients].filter((id) => this.#aw.states.has(id));
		link.clients.clear();
		if (ids.length > 0) awarenessProtocol.removeAwarenessStates(this.#aw, ids, 'p2p');
		for (const id of ids) this.#aw.meta.delete(id);
	}

	destroy() {
		this.#closed = true;
		this.#status = 'closed';
		if (this.#retry) clearTimeout(this.#retry);
		this.#doc.off('update', this.#docUpdate);
		this.#aw.off('update', this.#awUpdate);
		this.#dropAll();
		const ws = this.#ws;
		this.#ws = null;
		ws?.close();
	}
}

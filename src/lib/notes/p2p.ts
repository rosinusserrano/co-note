// Direct device-to-device links for a note, alongside the server relay.
//
// The server stays the connecting point: it checks passcodes, mints tokens and
// introduces devices (server/sync-server.js, "P2P matchmaking"). Once
// introduced, devices exchange strokes over WebRTC data channels, so a stroke
// drawn on the tablet reaches the laptop next to it without the round trip to
// the server, and keeps reaching it if the server link blips. The relay stays
// connected too: it is the fallback when WebRTC can't get through (hard NAT,
// no STUN) and the copy for whoever joins next. Yjs merges whatever arrives
// twice, so running both paths is safe.
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
// Data channel protocol (hand-rolled on plain yjs; simple-peer wants Node
// globals Vite won't supply):
//   SV      "here's my state vector; send me what I'm missing"
//   UPDATE  a Yjs update

import * as Y from 'yjs';

const TAG_SV = 0;
const TAG_UPDATE = 1;

// Close codes from server/sync-server.js. Retrying can't help after these.
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_GONE = 4404;

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
	/** Updates the hub dropped because an observer sent them. Kept observable
	 *  so enforcement is a fact you can check, not a claim. */
	rejected: number;
	/** 'revoked' / 'gone' mirror the relay's close codes. */
	status: 'connecting' | 'ready' | 'revoked' | 'gone' | 'closed';
}

export class P2PLinks {
	#doc: Y.Doc;
	#url: string;
	#ice: RTCConfiguration;
	#remoteOrigin: () => unknown;
	#onChange: (s: P2PState) => void;

	#ws: WebSocket | null = null;
	#me = '';
	#hub: string | null = null;
	/** On the hub: the devices the server says should link to us. */
	#listed = new Map<string, Role>();
	#links = new Map<string, Link>();
	#rejected = 0;
	#status: P2PState['status'] = 'connecting';
	#closed = false;
	#retry: ReturnType<typeof setTimeout> | null = null;
	#backoff = 1000;
	#docUpdate: (u: Uint8Array, origin: unknown) => void;

	/**
	 * `url` is the matchmaking socket, token included. `remoteOrigin` is the
	 * origin updates from the hub are applied with: the relay provider, so it
	 * doesn't upload what the hub already did, and so undo leaves them alone.
	 */
	constructor(
		doc: Y.Doc,
		url: string,
		opts: { remoteOrigin: () => unknown; onChange: (s: P2PState) => void; ice?: RTCConfiguration }
	) {
		this.#doc = doc;
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
		this.#open();
	}

	get state(): P2PState {
		let links = 0;
		for (const l of this.#links.values()) if (l.dc?.readyState === 'open') links++;
		return { links, hub: this.#isHub, rejected: this.#rejected, status: this.#status };
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
			if (e.code === CLOSE_UNAUTHORIZED || e.code === CLOSE_GONE) {
				this.#status = e.code === CLOSE_GONE ? 'gone' : 'revoked';
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
			if (this.#isHub) {
				this.#listed = new Map(
					(Array.isArray(m.peers) ? m.peers : []).map((p: any) => [String(p.id), p.role === 'edit' ? 'edit' : 'view'])
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
		for (const link of [...this.#links.values()]) if (!this.#listed.has(link.peer)) this.#drop(link);
		for (const [peer, role] of this.#listed) if (!this.#links.has(peer)) void this.#offer(peer, role);
	}

	#newLink(peer: string, role: Role): Link {
		const pc = new RTCPeerConnection(this.#ice);
		const link: Link = {
			peer,
			role,
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
	async #offer(peer: string, role: Role) {
		const link = this.#newLink(peer, role);
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
			}
		} catch {
			// Garbage from a device costs it the link, not us the note.
			this.#drop(link);
		}
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

	destroy() {
		this.#closed = true;
		this.#status = 'closed';
		if (this.#retry) clearTimeout(this.#retry);
		this.#doc.off('update', this.#docUpdate);
		this.#dropAll();
		const ws = this.#ws;
		this.#ws = null;
		ws?.close();
	}
}

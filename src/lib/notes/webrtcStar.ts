// P2P transport for a broadcast: a star with the broadcaster at the centre.
//
// WHY A STAR, NOT A MESH (this is the whole design):
//   Read-only has to be *enforced*, not just a toggle in the observer's UI. In a
//   mesh (what y-webrtc gives you) every peer talks to every other peer, so an
//   observer running a patched client can push updates straight to the others
//   and nothing is positioned to stop it — short of signing every update and
//   trusting every client to verify.
//   In a star, each joiner has its own data channel to the broadcaster and no
//   path to anyone else. The broadcaster therefore *inherently knows which peer
//   sent each update* and can drop writes from observers before they reach a
//   soul. Enforcement falls out of the topology; no crypto required.
//
// Stroke data flows only over these data channels. The signaling server is used
// to trade SDP/ICE and nothing else (see server/signal-server.js).
//
// Sync protocol (deliberately hand-rolled on plain yjs, so we don't pull in
// y-protocols or simple-peer — the latter wants Node globals Vite won't give us):
//   HELLO  guest -> host   { token? }   the edit token, over P2P, never signaling
//   ROLE   host  -> guest  { role }     the host's verdict, which is final
//   SV     both            state vector "here's what I have; send me the rest"
//   UPDATE both            a Yjs update

import * as Y from 'yjs';
import { tokensMatch, type Role } from './broadcast';

const TAG_HELLO = 0;
const TAG_ROLE = 1;
const TAG_SV = 2;
const TAG_UPDATE = 3;

const te = new TextEncoder();
const td = new TextDecoder();

/** STUN only. A TURN server would relay the actual stroke data, which is the
 *  one thing this design exists to avoid — so hard-NAT pairs fail over to the
 *  central Yjs relay instead (see ROADMAP). */
export const DEFAULT_ICE: RTCConfiguration = {
	iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

function frame(tag: number, payload: Uint8Array): ArrayBuffer {
	const out = new Uint8Array(payload.length + 1);
	out[0] = tag;
	out.set(payload, 1);
	return out.buffer;
}
const frameJson = (tag: number, obj: unknown) => frame(tag, te.encode(JSON.stringify(obj)));

function unframe(data: ArrayBuffer) {
	const bytes = new Uint8Array(data);
	return { tag: bytes[0], payload: bytes.subarray(1) };
}

function parseJson(payload: Uint8Array): Record<string, unknown> {
	try {
		const v = JSON.parse(td.decode(payload));
		return v && typeof v === 'object' ? v : {};
	} catch {
		return {};
	}
}

/**
 * ICE candidates can arrive before the description they belong to, and
 * addIceCandidate() throws if there's no remote description yet. Buffer until
 * there is one.
 */
class CandidateQueue {
	#pending: RTCIceCandidateInit[] = [];
	#ready = false;
	constructor(private pc: RTCPeerConnection) {}
	async add(c: RTCIceCandidateInit) {
		if (!this.#ready) {
			this.#pending.push(c);
			return;
		}
		await this.pc.addIceCandidate(c).catch(() => {});
	}
	async flush() {
		this.#ready = true;
		const q = this.#pending;
		this.#pending = [];
		for (const c of q) await this.pc.addIceCandidate(c).catch(() => {});
	}
}

interface HostPeer {
	id: string;
	pc: RTCPeerConnection;
	dc: RTCDataChannel | null;
	/** 'view' until a valid edit token shows up. Default-deny. */
	role: Role;
	cands: CandidateQueue;
}

export interface HostStats {
	peers: number;
	editors: number;
	/** Updates dropped because a read-only peer tried to write. */
	rejected: number;
}

/** The broadcaster. Owns the note, and is the only thing that grants edit. */
export class StarHost {
	readonly id: string;
	#doc: Y.Doc;
	#token: string;
	#ws: WebSocket;
	#peers = new Map<string, HostPeer>();
	#rejected = 0;
	#destroyed = false;
	#onChange: () => void;
	#docUpdate: (u: Uint8Array, origin: unknown) => void;
	#ice: RTCConfiguration;

	constructor(
		doc: Y.Doc,
		signalUrl: string,
		id: string,
		editToken: string,
		onChange: () => void,
		ice: RTCConfiguration = DEFAULT_ICE
	) {
		this.#doc = doc;
		this.#token = editToken;
		this.id = id;
		this.#onChange = onChange;
		this.#ice = ice;

		// Fan every doc change out to the peers — including changes that arrived
		// from an editor peer, since in a star we're the only path between them.
		this.#docUpdate = (update, origin) => {
			const msg = frame(TAG_UPDATE, update);
			for (const p of this.#peers.values()) {
				if (origin === p) continue; // don't echo back to whoever sent it
				this.#send(p, msg);
			}
		};
		doc.on('update', this.#docUpdate);

		this.#ws = new WebSocket(signalUrl);
		this.#ws.onopen = () => this.#ws.send(JSON.stringify({ t: 'host', id }));
		this.#ws.onmessage = (e) => this.#onSignalMessage(e);
	}

	get stats(): HostStats {
		let editors = 0;
		for (const p of this.#peers.values()) if (p.role === 'edit') editors++;
		return { peers: this.#peers.size, editors, rejected: this.#rejected };
	}

	#onSignalMessage(e: MessageEvent) {
		if (this.#destroyed) return;
		let m: any;
		try {
			m = JSON.parse(e.data);
		} catch {
			return;
		}
		if (m.t === 'peer-joined') this.#addPeer(m.peerId);
		else if (m.t === 'peer-left') this.#dropPeer(m.peerId);
		else if (m.t === 'signal') this.#onSignal(m.from, m.data);
	}

	async #addPeer(peerId: string) {
		const pc = new RTCPeerConnection(this.#ice);
		const peer: HostPeer = { id: peerId, pc, dc: null, role: 'view', cands: new CandidateQueue(pc) };
		this.#peers.set(peerId, peer);

		pc.onicecandidate = (e) => {
			if (e.candidate) this.#signal(peerId, { candidate: e.candidate.toJSON() });
		};
		pc.onconnectionstatechange = () => {
			if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.#dropPeer(peerId);
		};

		// Host is the offerer and owns the channel.
		const dc = pc.createDataChannel('yjs');
		peer.dc = dc;
		this.#wire(peer, dc);

		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		this.#signal(peerId, { sdp: pc.localDescription });
		this.#onChange();
	}

	async #onSignal(peerId: string, data: any) {
		const peer = this.#peers.get(peerId);
		if (!peer || !data) return;
		if (data.sdp) {
			await peer.pc.setRemoteDescription(data.sdp).catch(() => {});
			await peer.cands.flush();
		} else if (data.candidate) {
			await peer.cands.add(data.candidate);
		}
	}

	#wire(peer: HostPeer, dc: RTCDataChannel) {
		dc.binaryType = 'arraybuffer';
		dc.onopen = () => this.#onChange();
		dc.onclose = () => this.#onChange();
		dc.onmessage = (e) => this.#onData(peer, e.data);
	}

	#onData(peer: HostPeer, data: ArrayBuffer) {
		const { tag, payload } = unframe(data);

		if (tag === TAG_HELLO) {
			// The joiner presents a token; we decide the role. Anything it *claims*
			// about its own role is ignored — this is the only place role is set.
			const { token } = parseJson(payload);
			peer.role = typeof token === 'string' && tokensMatch(token, this.#token) ? 'edit' : 'view';
			this.#send(peer, frameJson(TAG_ROLE, { role: peer.role }));
			this.#send(peer, frame(TAG_SV, Y.encodeStateVector(this.#doc)));
			this.#onChange();
			return;
		}

		if (tag === TAG_SV) {
			this.#send(peer, frame(TAG_UPDATE, Y.encodeStateAsUpdate(this.#doc, payload)));
			return;
		}

		if (tag === TAG_UPDATE) {
			// *** The enforcement point. ***
			// A read-only peer's writes die here: not applied, and never fanned out
			// to anyone else. Because this is a star, there is no other route for
			// them to take.
			if (peer.role !== 'edit') {
				this.#rejected++;
				this.#onChange();
				return;
			}
			Y.applyUpdate(this.#doc, payload, peer);
		}
	}

	#send(peer: HostPeer, msg: ArrayBuffer) {
		if (peer.dc?.readyState === 'open') {
			try {
				peer.dc.send(msg);
			} catch {
				/* channel died mid-send; cleanup runs on close */
			}
		}
	}

	#signal(to: string, data: unknown) {
		if (this.#ws.readyState === 1) this.#ws.send(JSON.stringify({ t: 'signal', to, data }));
	}

	#dropPeer(peerId: string) {
		const peer = this.#peers.get(peerId);
		if (!peer) return;
		this.#peers.delete(peerId);
		try {
			peer.dc?.close();
			peer.pc.close();
		} catch {
			/* already gone */
		}
		this.#onChange();
	}

	destroy() {
		this.#destroyed = true;
		this.#doc.off('update', this.#docUpdate);
		for (const id of [...this.#peers.keys()]) this.#dropPeer(id);
		try {
			this.#ws.close();
		} catch {
			/* already closed */
		}
	}
}

export type GuestStatus = 'connecting' | 'connected' | 'ended' | 'error';

/** A joiner. Its role is whatever the host says it is. */
export class StarGuest {
	#doc: Y.Doc;
	#token: string;
	#ws: WebSocket;
	#pc: RTCPeerConnection | null = null;
	#dc: RTCDataChannel | null = null;
	#cands: CandidateQueue | null = null;
	#destroyed = false;
	#onChange: () => void;
	#docUpdate: (u: Uint8Array, origin: unknown) => void;
	#ice: RTCConfiguration;

	/** null until the host rules. Advisory for UI only — the host enforces. */
	role: Role | null = null;
	status: GuestStatus = 'connecting';
	error = '';

	constructor(
		doc: Y.Doc,
		signalUrl: string,
		id: string,
		editToken: string,
		onChange: () => void,
		ice: RTCConfiguration = DEFAULT_ICE
	) {
		this.#doc = doc;
		this.#token = editToken;
		this.#onChange = onChange;
		this.#ice = ice;

		this.#docUpdate = (update, origin) => {
			if (origin === this) return; // came from the host; don't bounce it back
			this.#send(frame(TAG_UPDATE, update));
		};
		doc.on('update', this.#docUpdate);

		this.#ws = new WebSocket(signalUrl);
		this.#ws.onopen = () => this.#ws.send(JSON.stringify({ t: 'join', id }));
		this.#ws.onmessage = (e) => this.#onSignalMessage(e);
		this.#ws.onerror = () => this.#fail('signal-unreachable');
	}

	#fail(reason: string) {
		if (this.#destroyed) return;
		this.status = 'error';
		this.error = reason;
		this.#onChange();
	}

	async #onSignalMessage(e: MessageEvent) {
		if (this.#destroyed) return;
		let m: any;
		try {
			m = JSON.parse(e.data);
		} catch {
			return;
		}
		if (m.t === 'error') return this.#fail(m.reason);
		if (m.t === 'broadcast-ended') {
			this.status = 'ended';
			this.#onChange();
			return;
		}
		if (m.t === 'signal') await this.#onSignal(m.data);
	}

	async #onSignal(data: any) {
		if (!data) return;
		if (data.sdp) {
			if (!this.#pc) this.#createPc();
			const pc = this.#pc!;
			await pc.setRemoteDescription(data.sdp).catch(() => {});
			await this.#cands!.flush();
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);
			this.#ws.send(JSON.stringify({ t: 'signal', data: { sdp: pc.localDescription } }));
		} else if (data.candidate) {
			if (!this.#pc) this.#createPc();
			await this.#cands!.add(data.candidate);
		}
	}

	#createPc() {
		const pc = new RTCPeerConnection(this.#ice);
		this.#pc = pc;
		this.#cands = new CandidateQueue(pc);
		pc.onicecandidate = (e) => {
			if (e.candidate && this.#ws.readyState === 1) {
				this.#ws.send(JSON.stringify({ t: 'signal', data: { candidate: e.candidate.toJSON() } }));
			}
		};
		pc.onconnectionstatechange = () => {
			if (pc.connectionState === 'failed') this.#fail('peer-connection-failed');
		};
		// The host owns the channel; we just receive it.
		pc.ondatachannel = (e) => {
			this.#dc = e.channel;
			this.#dc.binaryType = 'arraybuffer';
			this.#dc.onopen = () => {
				this.status = 'connected';
				// Present the token over P2P. The signaling server never saw it.
				this.#send(frameJson(TAG_HELLO, this.#token ? { token: this.#token } : {}));
				this.#onChange();
			};
			this.#dc.onclose = () => {
				if (this.status !== 'ended') this.status = 'ended';
				this.#onChange();
			};
			this.#dc.onmessage = (ev) => this.#onData(ev.data);
		};
	}

	#onData(data: ArrayBuffer) {
		const { tag, payload } = unframe(data);
		if (tag === TAG_ROLE) {
			const { role } = parseJson(payload);
			this.role = role === 'edit' ? 'edit' : 'view';
			this.#send(frame(TAG_SV, Y.encodeStateVector(this.#doc)));
			this.#onChange();
			return;
		}
		if (tag === TAG_SV) {
			this.#send(frame(TAG_UPDATE, Y.encodeStateAsUpdate(this.#doc, payload)));
			return;
		}
		if (tag === TAG_UPDATE) {
			// origin `this` keeps it out of the local UndoManager and stops us
			// echoing it straight back at the host.
			Y.applyUpdate(this.#doc, payload, this);
		}
	}

	#send(msg: ArrayBuffer) {
		if (this.#dc?.readyState === 'open') {
			try {
				this.#dc.send(msg);
			} catch {
				/* channel died mid-send */
			}
		}
	}

	destroy() {
		this.#destroyed = true;
		this.#doc.off('update', this.#docUpdate);
		try {
			this.#dc?.close();
			this.#pc?.close();
			this.#ws.close();
		} catch {
			/* already gone */
		}
	}
}

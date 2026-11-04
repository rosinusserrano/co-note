// How much of a note goes through the server's relay, decided per device.
//
// Devices on a note talk over direct links (p2p.ts). The relay connection
// stays open — it's how a device loads the stored note, learns its access
// was revoked, and the fallback when no direct link comes up — but it only
// carries what has no other way:
//
//   live    the relay as it always was: every change goes up at once, and
//           comes down from the others. For a device without a direct link,
//           and for the hub while such a device is on the relay.
//   quiet   linked to the hub: nothing goes up, and the server sends nothing
//           down but keepalives. The hub carries our changes to the others
//           and to the server.
//   saver   the hub, with nobody else on the relay: changes go up in one
//           batch every SAVE_EVERY_MS (and when the page is hidden), so the
//           server keeps the note — no presence, nothing for anyone else.
//
// The server knows a connection is quiet from MESSAGE_QUIET, and tells the
// others how many connections still listen (MESSAGE_LISTENERS), which is how
// the hub picks between live and saver. Both are message types y-websocket
// doesn't use; see server/sync-server.js.

import * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
/** Client → server: 1 = quiet, 0 = listening again. */
const MESSAGE_QUIET = 100;
/** Server → client: how many other connections on the note still listen. */
const MESSAGE_LISTENERS = 101;

/** How often the hub saves, when nobody needs its changes live. */
export const SAVE_EVERY_MS = 5000;

export type RelayModeName = 'live' | 'quiet' | 'saver';

export class RelayMode {
	#ws: WebsocketProvider;
	#mode: RelayModeName = 'live';
	#pending: Uint8Array[] = [];
	#timer: ReturnType<typeof setTimeout> | null = null;
	#batch: (update: Uint8Array, origin: unknown) => void;
	#flushOnHide: () => void;
	/** Other connections still listening on the relay; null until the server says. */
	listeners: number | null = null;

	constructor(ws: WebsocketProvider, onListeners: () => void) {
		this.#ws = ws;
		this.#batch = (update, origin) => {
			if (origin === ws) return; // came from the server
			this.#pending.push(update);
			this.#timer ??= setTimeout(() => this.flush(), SAVE_EVERY_MS);
		};
		ws.messageHandlers[MESSAGE_LISTENERS] = (_enc, dec) => {
			this.listeners = decoding.readVarUint(dec);
			onListeners();
		};
		ws.on('status', (e: { status: string }) => {
			if (e.status !== 'connected') return;
			// A new socket: the server starts it listening, and the sync it opens
			// with uploads whatever it lacks — a pending batch included.
			this.#pending = [];
			this.listeners = null;
			if (this.#mode === 'quiet') this.#sendFlag(1);
		});
		this.#flushOnHide = () => {
			if (document.visibilityState === 'hidden') this.flush();
		};
		document.addEventListener('visibilitychange', this.#flushOnHide);
		window.addEventListener('pagehide', this.#flushOnHide);
	}

	get mode(): RelayModeName {
		return this.#mode;
	}

	set(mode: RelayModeName) {
		const was = this.#mode;
		if (mode === was) return;
		const ws = this.#ws;
		const doc = ws.doc;
		const aw = ws.awareness;
		this.flush();
		// Take down what `was` had up…
		if (was === 'live') {
			doc.off('update', ws._updateHandler);
			aw.off('update', ws._awarenessUpdateHandler);
		} else if (was === 'saver') {
			doc.off('update', this.#batch);
		}
		this.#mode = mode;
		if (was === 'quiet') this.#sendFlag(0); // the server replies with its state
		else if (mode === 'quiet') this.#sendFlag(1);
		// …and put up what `mode` needs.
		if (mode === 'live') {
			doc.on('update', ws._updateHandler);
			aw.on('update', ws._awarenessUpdateHandler);
			// Whoever just appeared on the relay sees everyone (and us, at a
			// new clock: the server may have timed our old one out).
			const st = aw.getLocalState();
			if (st) aw.setLocalState({ ...st });
			this.#send(MESSAGE_AWARENESS, (enc) =>
				encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(aw, [...aw.getStates().keys()]))
			);
		} else if (mode === 'saver') {
			doc.on('update', this.#batch);
		}
		if (was === 'quiet') {
			// Back on the relay: catch up on what we missed, in both directions
			// (the server's SyncStep1 makes us send what it lacks).
			this.#send(MESSAGE_SYNC, (enc) => syncProtocol.writeSyncStep1(enc, doc));
		}
	}

	/** Send the batch now (the hub, when it's about to go or be hidden). */
	flush() {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		if (this.#pending.length === 0) return;
		const update = Y.mergeUpdates(this.#pending);
		this.#pending = [];
		this.#send(MESSAGE_SYNC, (enc) => syncProtocol.writeUpdate(enc, update));
	}

	#sendFlag(quiet: 0 | 1) {
		this.#send(MESSAGE_QUIET, (enc) => encoding.writeVarUint(enc, quiet));
	}

	#send(type: number, write: (enc: encoding.Encoder) => void) {
		const ws = this.#ws;
		if (!ws.wsconnected || ws.ws?.readyState !== WebSocket.OPEN) return;
		const enc = encoding.createEncoder();
		encoding.writeVarUint(enc, type);
		write(enc);
		ws.ws.send(encoding.toUint8Array(enc));
	}

	destroy() {
		this.flush();
		if (this.#timer) clearTimeout(this.#timer);
		document.removeEventListener('visibilitychange', this.#flushOnHide);
		window.removeEventListener('pagehide', this.#flushOnHide);
		this.#ws.doc.off('update', this.#batch);
	}
}

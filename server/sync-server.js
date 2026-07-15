// Minimal Yjs relay server.
//
// y-websocket v3 ships client-only, so this is a compact standalone
// implementation of the Yjs sync + awareness protocols over `ws`. One Y.Doc per
// room (the note id); updates from any client are applied to the room doc and
// broadcast to the others. State is kept in memory — durable per-device state
// lives in each client's IndexedDB (y-indexeddb), so a server restart just
// re-syncs from whichever clients are connected.
//
// Run:  npm run sync   (listens on SYNC_PORT, default 5182)

import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const PORT = Number(process.env.SYNC_PORT) || 5182;

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const WS_OPEN = 1;

/** @type {Map<string, { doc: Y.Doc, awareness: awarenessProtocol.Awareness, conns: Map<any, Set<number>> }>} */
const rooms = new Map();

function getRoom(name) {
	let room = rooms.get(name);
	if (room) return room;

	const doc = new Y.Doc();
	const awareness = new awarenessProtocol.Awareness(doc);
	awareness.setLocalState(null);
	/** @type {Map<any, Set<number>>} */
	const conns = new Map();

	// Broadcast document updates to every connected client.
	doc.on('update', (update) => {
		const enc = encoding.createEncoder();
		encoding.writeVarUint(enc, MESSAGE_SYNC);
		syncProtocol.writeUpdate(enc, update);
		const msg = encoding.toUint8Array(enc);
		conns.forEach((_ids, ws) => send(ws, msg));
	});

	// Broadcast awareness (peer presence) changes, and track which client ids
	// each connection owns so we can clean them up on disconnect.
	awareness.on('update', ({ added, updated, removed }, origin) => {
		if (origin && conns.has(origin)) {
			const owned = conns.get(origin);
			added.forEach((id) => owned.add(id));
			removed.forEach((id) => owned.delete(id));
		}
		const changed = added.concat(updated, removed);
		const enc = encoding.createEncoder();
		encoding.writeVarUint(enc, MESSAGE_AWARENESS);
		encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
		const msg = encoding.toUint8Array(enc);
		conns.forEach((_ids, ws) => send(ws, msg));
	});

	room = { doc, awareness, conns };
	rooms.set(name, room);
	return room;
}

function send(ws, msg) {
	if (ws.readyState !== WS_OPEN) return;
	try {
		ws.send(msg, (err) => err && ws.close());
	} catch {
		ws.close();
	}
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws, req) => {
	ws.binaryType = 'arraybuffer';
	const roomName = decodeURIComponent((req.url || '/').slice(1).split('?')[0]) || 'default';
	const room = getRoom(roomName);
	room.conns.set(ws, new Set());

	// Kick off sync: send our state vector (SyncStep1) so the client replies with
	// whatever we're missing.
	{
		const enc = encoding.createEncoder();
		encoding.writeVarUint(enc, MESSAGE_SYNC);
		syncProtocol.writeSyncStep1(enc, room.doc);
		send(ws, encoding.toUint8Array(enc));
	}
	// Send existing awareness states so the newcomer sees current peers.
	const states = room.awareness.getStates();
	if (states.size > 0) {
		const enc = encoding.createEncoder();
		encoding.writeVarUint(enc, MESSAGE_AWARENESS);
		encoding.writeVarUint8Array(
			enc,
			awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()])
		);
		send(ws, encoding.toUint8Array(enc));
	}

	ws.on('message', (data) => {
		const bytes = new Uint8Array(data);
		const decoder = decoding.createDecoder(bytes);
		const encoder = encoding.createEncoder();
		const type = decoding.readVarUint(decoder);
		if (type === MESSAGE_SYNC) {
			encoding.writeVarUint(encoder, MESSAGE_SYNC);
			// Applies updates to room.doc (which triggers the broadcast above) and
			// writes any reply (e.g. SyncStep2) into `encoder`.
			syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
			if (encoding.length(encoder) > 1) send(ws, encoding.toUint8Array(encoder));
		} else if (type === MESSAGE_AWARENESS) {
			awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws);
		}
	});

	// Keepalive: drop connections that stop responding (mobile links flap).
	ws.isAlive = true;
	ws.on('pong', () => (ws.isAlive = true));

	const cleanup = () => {
		const owned = room.conns.get(ws);
		room.conns.delete(ws);
		if (owned && owned.size > 0) {
			awarenessProtocol.removeAwarenessStates(room.awareness, [...owned], null);
		}
		if (room.conns.size === 0) rooms.delete(roomName);
	};
	ws.on('close', cleanup);
	ws.on('error', cleanup);
});

const heartbeat = setInterval(() => {
	wss.clients.forEach((ws) => {
		if (ws.isAlive === false) {
			ws.terminate();
			return;
		}
		ws.isAlive = false;
		try {
			ws.ping();
		} catch {
			ws.terminate();
		}
	});
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

console.log(`[sync] Yjs relay listening on ws://0.0.0.0:${PORT}`);

// Matchmaking server for P2P broadcasts. THIS IS NOT A RELAY.
//
// Its entire job is to let a broadcaster and its joiners find each other and
// exchange WebRTC connection info (SDP offers/answers + ICE candidates). Once
// the peer connection is up, stroke data flows directly peer-to-peer and never
// touches this process. Per ROADMAP: "central = matchmaking only".
//
// What this server deliberately never sees:
//   - stroke/document data — it goes over the WebRTC data channel
//   - the edit token       — presented over that same data channel, not here,
//                            so a compromised signaling host cannot mint editors
//
// It does see broadcast IDs (it has to — they're the room address) and the SDP,
// which contains network addresses. That's the documented trade of using a
// signaling server at all.
//
// Topology is a star: every joiner connects to the broadcaster and only to the
// broadcaster. That is what makes read-only enforceable — the broadcaster is
// the only hop, so it always knows which peer an update came from.
//
// Run:  npm run signal   (listens on SIGNAL_PORT, default 5183)

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.SIGNAL_PORT) || 5183;

/** @type {Map<string, { host: any, peers: Map<string, any> }>} */
const broadcasts = new Map();

const send = (ws, obj) => {
	if (ws.readyState === 1) {
		try {
			ws.send(JSON.stringify(obj));
		} catch {
			/* peer is going away; cleanup runs on close */
		}
	}
};

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
	// What this socket is, decided by its first message.
	/** @type {'host' | 'peer' | null} */
	let kind = null;
	let bid = ''; // broadcast id
	let peerId = '';

	ws.on('message', (raw) => {
		let msg;
		try {
			msg = JSON.parse(String(raw));
		} catch {
			return; // ignore garbage rather than take the process down
		}

		switch (msg.t) {
			case 'host': {
				if (kind) return;
				if (typeof msg.id !== 'string' || !msg.id) return;
				if (broadcasts.has(msg.id)) {
					send(ws, { t: 'error', reason: 'id-taken' });
					return;
				}
				kind = 'host';
				bid = msg.id;
				broadcasts.set(bid, { host: ws, peers: new Map() });
				send(ws, { t: 'hosting', id: bid });
				console.log(`[signal] broadcast ${bid} started`);
				break;
			}

			case 'join': {
				if (kind) return;
				const b = broadcasts.get(msg.id);
				if (!b) {
					send(ws, { t: 'error', reason: 'no-such-broadcast' });
					return;
				}
				kind = 'peer';
				bid = msg.id;
				peerId = randomUUID();
				b.peers.set(peerId, ws);
				send(ws, { t: 'joined', peerId });
				// The broadcaster is the offerer, so tell it to reach out.
				send(b.host, { t: 'peer-joined', peerId });
				console.log(`[signal] peer ${peerId.slice(0, 8)} joined ${bid} (${b.peers.size} peers)`);
				break;
			}

			// Opaque passthrough. We never inspect msg.data — it is SDP/ICE.
			case 'signal': {
				const b = broadcasts.get(bid);
				if (!b) return;
				if (kind === 'host') {
					const target = b.peers.get(msg.to);
					if (target) send(target, { t: 'signal', data: msg.data });
				} else if (kind === 'peer') {
					send(b.host, { t: 'signal', from: peerId, data: msg.data });
				}
				break;
			}
		}
	});

	const cleanup = () => {
		const b = broadcasts.get(bid);
		if (!b) return;
		if (kind === 'host') {
			// Broadcast is over: tell joiners so they can show it, and drop the room.
			b.peers.forEach((p) => send(p, { t: 'broadcast-ended' }));
			broadcasts.delete(bid);
			console.log(`[signal] broadcast ${bid} ended`);
		} else if (kind === 'peer') {
			b.peers.delete(peerId);
			send(b.host, { t: 'peer-left', peerId });
		}
	};
	ws.on('close', cleanup);
	ws.on('error', cleanup);
});

console.log(`[signal] matchmaking server listening on ws://0.0.0.0:${PORT}`);

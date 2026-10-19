// co-note server: the note registry's HTTP API plus the Yjs relay.
//
// y-websocket v3 ships client-only, so the relay is a compact standalone
// implementation of the Yjs sync + awareness protocols over `ws`. One Y.Doc per
// note; updates from editors are applied to the room doc and broadcast to the
// others. Each doc is also written to disk (registry.js), so a note is there
// for whoever joins next even when nobody else is online.
//
// Access: a client exchanges note name + passcode for a token over HTTP
// (POST /api/join), then opens the WebSocket at /<noteId>?token=…. The token
// fixes the connection's role, and the relay enforces it: an observer's
// connection may ask for state (SyncStep1) but every write it sends is dropped.
//
// The owner's device also presents `&owner=<proof>`. Its connection is the only
// one whose presence may carry `pull` (bring everyone to my view): the relay
// strips that field from everyone else's awareness, so a pull that reaches a
// device came from the owner. Likewise `laser` (the laser pointer) and `live`
// (a stroke in progress, previewed until the real one lands) are stripped
// from observers: they can't draw, so they can't seem to either.
//
// The same token also opens /signal/<noteId>: matchmaking for direct WebRTC
// links between the note's devices (see "P2P matchmaking" below).
//
// Run:  npm run sync   (listens on SYNC_PORT, default 5182; data in CONOTE_DATA, default ./data)

import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as registry from './registry.js';
import * as zotero from './zotero.js';

const PORT = Number(process.env.SYNC_PORT) || 5182;
// Unset = all interfaces (LAN dev). Production sets 127.0.0.1: only Caddy talks to it.
const HOST = process.env.SYNC_HOST || undefined;

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const WS_OPEN = 1;

// WebSocket close codes the client acts on (4000–4999 is the app range).
const CLOSE_UNAUTHORIZED = 4401; // bad/revoked token: ask for the passcode again
const CLOSE_GONE = 4404; // note deleted
const CLOSE_ENDED = 4410; // an unsaved note ended: nobody was left on it

// An unsaved note (created without an account) is deleted once nobody has
// been connected for this long. Not instantly: a reload or a flaky network
// mustn't end it, and a restart of this server gives everyone this long to
// come back.
const ENDED_GRACE_MS = Number(process.env.CONOTE_ENDED_GRACE_MS) || 2 * 60_000;

// How long after the last edit a room's doc is written to disk.
const SAVE_DELAY_MS = 1000;

/** @type {Map<string, { doc: Y.Doc, awareness: awarenessProtocol.Awareness, conns: Map<any, Set<number>>, saveTimer: any }>} */
const rooms = new Map();

function getRoom(id) {
	let room = rooms.get(id);
	if (room) return room;

	const doc = new Y.Doc();
	const saved = registry.loadDoc(id);
	if (saved) Y.applyUpdate(doc, saved);
	const awareness = new awarenessProtocol.Awareness(doc);
	awareness.setLocalState(null);
	/** @type {Map<any, Set<number>>} */
	const conns = new Map();

	// Broadcast document updates to every connected client, and schedule a save.
	doc.on('update', (update) => {
		const enc = encoding.createEncoder();
		encoding.writeVarUint(enc, MESSAGE_SYNC);
		syncProtocol.writeUpdate(enc, update);
		const msg = encoding.toUint8Array(enc);
		conns.forEach((_ids, ws) => send(ws, msg));
		clearTimeout(room.saveTimer);
		room.saveTimer = setTimeout(() => saveRoom(id, room), SAVE_DELAY_MS);
	});

	// Broadcast awareness (peer presence) changes, and track which client ids
	// each connection owns so we can clean them up on disconnect.
	awareness.on('update', ({ added, updated, removed }, origin) => {
		if (origin && conns.has(origin)) {
			const owned = conns.get(origin);
			added.forEach((cid) => owned.add(cid));
			removed.forEach((cid) => owned.delete(cid));
		}
		const changed = added.concat(updated, removed);
		const enc = encoding.createEncoder();
		encoding.writeVarUint(enc, MESSAGE_AWARENESS);
		encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
		const msg = encoding.toUint8Array(enc);
		conns.forEach((_ids, ws) => send(ws, msg));
	});

	room = { doc, awareness, conns, saveTimer: null };
	rooms.set(id, room);
	return room;
}

function saveRoom(id, room) {
	clearTimeout(room.saveTimer);
	room.saveTimer = null;
	try {
		registry.saveDoc(id, Y.encodeStateAsUpdate(room.doc));
	} catch (e) {
		console.error(`[sync] saving ${id} failed:`, e);
	}
}

function send(ws, msg) {
	if (ws.readyState !== WS_OPEN) return;
	try {
		ws.send(msg, (err) => err && ws.close());
	} catch {
		ws.close();
	}
}

/** Drop live connections whose token no longer holds (passcode changed, note
 *  deleted), relay and matchmaking alike. Their clients see the close code and
 *  stop retrying. Closing a matchmaking socket also tells the hub to cut that
 *  device's direct link, so revocation reaches P2P too. */
function closeConnections(id, roles, code) {
	const reason = code === CLOSE_GONE ? 'note deleted' : 'access revoked';
	for (const ws of rooms.get(id)?.conns.keys() ?? []) {
		if (roles.includes(ws.role)) ws.close(code, reason);
	}
	for (const peer of signalRooms.get(id)?.values() ?? []) {
		if (roles.includes(peer.role)) peer.ws.close(code, reason);
	}
}

// --- P2P matchmaking --------------------------------------------------------
//
// Devices on a note also link up directly over WebRTC, so strokes reach the
// others without the round trip through here (and keep flowing if this server
// blips). This part only introduces them: it relays SDP/ICE and never sees
// stroke data on that path.
//
// Topology is a star around one hub, the longest-connected editor. Every other
// device links to the hub and to nothing else; this server only forwards
// signals that have the hub at one end, so no other link can form. The hub
// drops writes from observers exactly like the relay does, and it learns each
// device's role from here — from the verified token, never from the device.
// It is the v1 broadcast star, with roles now coming from note tokens.

/** @type {Map<string, Map<string, { ws: any, role: 'edit' | 'view' }>>} note id → peer id → peer */
const signalRooms = new Map();
const MAX_SIGNAL_PEERS = 32;
const MAX_SIGNAL_MESSAGE = 64 * 1024;

const sendJson = (ws, obj) => send(ws, JSON.stringify(obj));

/** The hub is the first editor still connected (Maps keep insertion order),
 *  so it only changes when that device leaves. */
function hubOf(room) {
	for (const [pid, p] of room) if (p.role === 'edit') return pid;
	return null;
}

/** Tell everyone who the hub is, and the hub who to link up with. Sent on
 *  every membership change; clients reconcile against it. */
function announce(id) {
	const room = signalRooms.get(id);
	if (!room) return;
	const hub = hubOf(room);
	for (const [pid, p] of room) {
		if (pid === hub) {
			const peers = [...room].filter(([q]) => q !== hub).map(([q, r]) => ({ id: q, role: r.role }));
			sendJson(p.ws, { t: 'hub', hub, peers });
		} else {
			sendJson(p.ws, { t: 'hub', hub });
		}
	}
}

function onSignalConnection(ws, id, role) {
	let room = signalRooms.get(id);
	if (!room) signalRooms.set(id, (room = new Map()));
	if (room.size >= MAX_SIGNAL_PEERS) {
		ws.close(1013, 'too many devices for direct links');
		return;
	}
	const peerId = randomUUID();
	room.set(peerId, { ws, role });
	sendJson(ws, { t: 'welcome', id: peerId, role });
	announce(id);

	ws.on('message', (raw) => {
		if (raw.length > MAX_SIGNAL_MESSAGE) return;
		let msg;
		try {
			msg = JSON.parse(String(raw));
		} catch {
			return;
		}
		if (msg?.t !== 'signal' || typeof msg.to !== 'string') return;
		const target = room.get(msg.to);
		const hub = hubOf(room);
		// Star only: one end must be the hub. Opaque payload (SDP/ICE).
		if (!target || (peerId !== hub && msg.to !== hub)) return;
		sendJson(target.ws, { t: 'signal', from: peerId, data: msg.data });
	});

	ws.isAlive = true;
	ws.on('pong', () => (ws.isAlive = true));
	const cleanup = () => {
		if (!room.delete(peerId)) return;
		if (room.size === 0) signalRooms.delete(id);
		else announce(id);
	};
	ws.on('close', cleanup);
	ws.on('error', cleanup);
}

// --- Unsaved notes end ------------------------------------------------------

/** note id → when it was last known to have someone on it (or was created). */
const lastSeen = new Map();
const startedAt = Date.now();

setInterval(() => {
	const now = Date.now();
	for (const id of registry.ephemeralIds()) {
		if ((rooms.get(id)?.conns.size ?? 0) > 0) continue;
		if (now - (lastSeen.get(id) ?? startedAt) < ENDED_GRACE_MS) continue;
		const room = rooms.get(id);
		if (room) clearTimeout(room.saveTimer);
		if (registry.endNote(id)) {
			lastSeen.delete(id);
			closeConnections(id, ['edit', 'view'], CLOSE_ENDED);
			console.log(`[sync] unsaved note ${id} ended`);
		}
	}
}, Math.min(15_000, ENDED_GRACE_MS / 4)).unref();

// --- HTTP API ---------------------------------------------------------------

/** Per-IP attempt budgets. Passcodes are short and human-picked, so guessing
 *  must be slow; creation is limited so nobody can squat the name space. */
const limits = {
	join: { max: 10, windowMs: 10 * 60_000 },
	// Per note name, across all addresses: caps guessing from many IPs at once.
	// Keyed by the typed name, existing or not, so hitting it reveals nothing.
	// Holders of a token, and the owner, are unaffected; a fresh join of a
	// name under attack waits out the window.
	joinName: { max: 20, windowMs: 60 * 60_000 },
	create: { max: 10, windowMs: 60 * 60_000 },
	owner: { max: 10, windowMs: 10 * 60_000 },
	login: { max: 10, windowMs: 10 * 60_000 },
	// Per account name, like joinName.
	loginName: { max: 20, windowMs: 60 * 60_000 },
	register: { max: 5, windowMs: 60 * 60_000 },
	// Signed-in calls (listing, forgetting): plenty, just not unbounded.
	account: { max: 300, windowMs: 10 * 60_000 },
	// Zotero relaying, per account and per address.
	zotero: { max: 300, windowMs: 10 * 60_000 },
	upload: { max: 30, windowMs: 60 * 60_000 }
};
/** @type {Map<string, { count: number, resetAt: number }>} */
const attempts = new Map();

function overLimit(kind, ip) {
	const key = `${kind}:${ip}`;
	const now = Date.now();
	let a = attempts.get(key);
	if (!a || a.resetAt < now) attempts.set(key, (a = { count: 0, resetAt: now + limits[kind].windowMs }));
	return a.count >= limits[kind].max;
}
function countAttempt(kind, ip) {
	const a = attempts.get(`${kind}:${ip}`);
	if (a) a.count++;
}
setInterval(() => {
	const now = Date.now();
	for (const [k, a] of attempts) if (a.resetAt < now) attempts.delete(k);
}, 60_000).unref();

/** The client's address. Behind Caddy every request comes from loopback and
 *  Caddy sets X-Forwarded-For to the real client, so trust it only then. */
function clientIp(req) {
	const remote = req.socket.remoteAddress ?? '';
	const fwd = req.headers['x-forwarded-for'];
	if (fwd && (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
		return String(fwd).split(',').pop().trim();
	}
	return remote;
}

function readBody(req, max) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > max) {
				reject(new registry.HttpError(413, 'Request too large.'));
				req.destroy();
			} else chunks.push(c);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

async function readJson(req) {
	const raw = await readBody(req, 16_384);
	try {
		const body = JSON.parse(raw.toString('utf8') || '{}');
		return typeof body === 'object' && body ? body : {};
	} catch {
		throw new registry.HttpError(400, 'Invalid JSON.');
	}
}

// --- Files (imported PDFs) ----------------------------------------------------
//
//   POST /api/files/<noteId>          body = the PDF; editors only → { hash }
//   GET  /api/files/<noteId>/<sha256> editors and observers
//
// Both take the note token as `Authorization: Bearer …`, like the WebSocket
// takes it as ?token=, so a passcode change cuts file access too. Files are
// content-addressed, so a GET can be cached forever.

const FILE_ROUTE = /^\/api\/files\/([a-z0-9]+)(?:\/([0-9a-f]{64}))?$/;
const PDF_MAGIC = Buffer.from('%PDF-');

async function handleFile(req, res, match, reply, ip) {
	const [, id, hash] = match;
	const auth = String(req.headers.authorization ?? '');
	const access = registry.verifyToken(auth.startsWith('Bearer ') ? auth.slice(7) : '');
	if (!access || access.note.id !== id) {
		return reply(registry.noteExists(id) ? 403 : 404, { error: 'No access to this note.' });
	}

	if (req.method === 'GET' && hash) {
		const file = registry.filePath(id, hash);
		let size;
		try {
			size = fs.statSync(file).size;
		} catch {
			return reply(404, { error: 'No such file.' });
		}
		res.writeHead(200, {
			'Content-Type': 'application/pdf',
			'Content-Length': size,
			'Cache-Control': 'private, max-age=31536000, immutable'
		});
		fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
		return;
	}

	if (req.method === 'POST' && !hash) {
		if (access.role !== 'edit') return reply(403, { error: "Observers can't add files." });
		if (overLimit('upload', ip)) return reply(429, { error: 'Too many uploads. Try again later.' });
		countAttempt('upload', ip);
		// Refuse early on the declared size, before reading 50 MB for nothing.
		registry.checkFileQuota(id, Number(req.headers['content-length']) || 0);
		const bytes = await readBody(req, registry.MAX_FILE_BYTES);
		if (!bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return reply(400, { error: "That isn't a PDF." });
		registry.checkFileQuota(id, bytes.length);
		const digest = createHash('sha256').update(bytes).digest('hex');
		registry.saveFile(id, digest, bytes);
		return reply(200, { hash: digest });
	}

	reply(405, { error: 'Method not allowed.' });
}

/** Signed-in only: refuses without a valid account session. */
const signedIn = (fn) => (body, account) => {
	if (!account) throw new registry.HttpError(401, 'Please sign in again.');
	return fn(account, body);
};

// --- Zotero files -------------------------------------------------------------
//
//   POST /api/zotero/file  JSON { apiKey, userId, key, webdav? } → the PDF
//   POST /api/zotero/save  [4-byte length][JSON meta][PDF bytes] → { key }
//
// Signed-in only. Credentials ride in the body, never a header or URL, so
// they stay out of access logs.

async function handleZoteroFile(req, res, path, reply, ip) {
	if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });
	const auth = String(req.headers.authorization ?? '');
	const account = auth.startsWith('Bearer ') ? registry.verifyAccount(auth.slice(7)) : null;
	if (!account) return reply(401, { error: 'Please sign in again.' });
	for (const key of [ip, `@${account.key}`]) {
		if (overLimit('zotero', key)) return reply(429, { error: 'Too many Zotero requests. Try again later.' });
		countAttempt('zotero', key);
	}
	if (path === '/api/zotero/file') {
		const bytes = await zotero.file(await readJson(req));
		res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
		return void res.end(bytes);
	}
	const raw = await readBody(req, zotero.MAX_PDF_BYTES + 65_536);
	const n = raw.length >= 4 ? raw.readUInt32BE(0) : -1;
	if (n < 0 || n > 16_384 || raw.length < 4 + n) return reply(400, { error: 'Malformed upload.' });
	let meta;
	try {
		meta = JSON.parse(raw.subarray(4, 4 + n).toString('utf8'));
	} catch {
		return reply(400, { error: 'Malformed upload.' });
	}
	reply(200, await zotero.save(meta, raw.subarray(4 + n)));
}

/** route → [rate-limit bucket, handler(body, account)]. `account` is the
 *  signed-in account (from `Authorization: Bearer <account session>`), or
 *  null. A request that fails with 403 counts against the bucket; successful
 *  ones don't (except create and register, which always do). */
const routes = {
	'/api/notes': ['create', async (body, account) => {
		const session = await registry.createNote(body, account);
		lastSeen.set(session.id, Date.now()); // its grace starts now, before anyone connects
		return session;
	}],
	'/api/join': ['join', (body, account) => registry.join(body, account)],
	'/api/account/register': ['register', (body) => registry.register(body)],
	'/api/account/login': ['login', (body) => registry.login(body)],
	'/api/account/notes': ['account', signedIn((account) => registry.accountNotes(account))],
	'/api/account/forget': ['account', signedIn((account, body) => registry.forget(account, body))],
	'/api/account/claim': ['owner', signedIn((account, body) => registry.claim(account, body))],
	'/api/zotero/verify': ['zotero', signedIn((_a, body) => zotero.verify(body))],
	'/api/zotero/search': ['zotero', signedIn((_a, body) => zotero.search(body))],
	'/api/zotero/pdfs': ['zotero', signedIn((_a, body) => zotero.pdfs(body))],
	'/api/owner/session': ['owner', (body, account) => registry.ownerSession(body, account)],
	'/api/owner/settings': ['owner', async (body, account) => {
		const { revoked, session } = await registry.updateSettings(body, account);
		closeConnections(session.id, revoked, CLOSE_UNAUTHORIZED);
		return session;
	}],
	'/api/owner/delete': ['owner', async (body, account) => {
		const id = await registry.deleteNote(body, account);
		closeConnections(id, ['edit', 'view'], CLOSE_GONE);
		const room = rooms.get(id);
		if (room) clearTimeout(room.saveTimer);
		return { ok: true };
	}]
};

async function handleHttp(req, res) {
	// Dev serves the app from another port (vite :5173), so allow cross-origin.
	// Nothing here rides on cookies — credentials are in the body — so * is safe.
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	const reply = (status, obj) => {
		res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
		res.end(JSON.stringify(obj));
	};

	if (req.method === 'OPTIONS') return void res.writeHead(204).end();
	const path = (req.url ?? '').split('?')[0];
	if (path === '/api/health') return reply(200, { ok: true });
	const fileMatch = FILE_ROUTE.exec(path);
	if (fileMatch) {
		try {
			return await handleFile(req, res, fileMatch, reply, clientIp(req));
		} catch (e) {
			if (e instanceof registry.HttpError) return reply(e.status, { error: e.message });
			throw e;
		}
	}
	if (path === '/api/zotero/file' || path === '/api/zotero/save') {
		try {
			return await handleZoteroFile(req, res, path, reply, clientIp(req));
		} catch (e) {
			if (e instanceof registry.HttpError) return reply(e.status, { error: e.message });
			console.error('[sync] zotero failed:', e);
			return reply(500, { error: 'Server error.' });
		}
	}
	const route = routes[path];
	if (!route) return reply(404, { error: 'Not found.' });
	if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

	const [bucket, handler] = route;
	const ip = clientIp(req);
	const busy = (kind, key) => overLimit(kind, key) && reply(429, { error: 'Too many attempts. Try again later.' });
	if (busy(bucket, ip)) return;
	let name = null; // join / login: the per-name budget's key
	const nameBucket = bucket === 'join' ? 'joinName' : bucket === 'login' ? 'loginName' : null;
	try {
		const body = await readJson(req);
		if (nameBucket) {
			name = bucket === 'join' ? registry.normalizeName(body.name) : String(body.name ?? '').trim().toLowerCase();
			if (busy(nameBucket, name)) return;
		}
		if (['create', 'register', 'account', 'zotero'].includes(bucket)) countAttempt(bucket, ip);
		const auth = String(req.headers.authorization ?? '');
		const account = auth.startsWith('Bearer ') ? registry.verifyAccount(auth.slice(7)) : null;
		reply(200, await handler(body, account));
	} catch (e) {
		if (e instanceof registry.HttpError) {
			if (e.status === 403) {
				countAttempt(bucket, ip);
				if (nameBucket) countAttempt(nameBucket, name);
			}
			reply(e.status, { error: e.message });
		} else {
			console.error('[sync] request failed:', e);
			reply(500, { error: 'Server error.' });
		}
	}
}

// --- Presence fields only some may send -------------------------------------

/**
 * An awareness update with the given fields removed from every state: `pull`
 * unless it's the owner's connection, `laser` and `live` unless an editor's
 * (see the header). Update format (y-protocols/awareness): count, then per client: id,
 * clock, JSON state. Returned unchanged if none of the fields is there.
 */
function stripFields(update, fields) {
	const dec = decoding.createDecoder(update);
	const entries = [];
	let found = false;
	for (let n = decoding.readVarUint(dec); n > 0; n--) {
		const client = decoding.readVarUint(dec);
		const clock = decoding.readVarUint(dec);
		const state = JSON.parse(decoding.readVarString(dec));
		if (state && typeof state === 'object') {
			for (const f of fields) {
				if (!(f in state)) continue;
				delete state[f];
				found = true;
			}
		}
		entries.push([client, clock, state]);
	}
	if (!found) return update;
	const enc = encoding.createEncoder();
	encoding.writeVarUint(enc, entries.length);
	for (const [client, clock, state] of entries) {
		encoding.writeVarUint(enc, client);
		encoding.writeVarUint(enc, clock);
		encoding.writeVarString(enc, JSON.stringify(state));
	}
	return encoding.toUint8Array(enc);
}

const server = http.createServer((req, res) => {
	handleHttp(req, res).catch(() => res.destroy());
});

// --- WebSocket relay --------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

// Two kinds of socket, both behind a note token:
//   /<noteId>          the Yjs relay
//   /signal/<noteId>   P2P matchmaking (see above)
// Production reaches both under /sync/ (Caddy strips the prefix).
server.on('upgrade', (req, socket, head) => {
	wss.handleUpgrade(req, socket, head, (ws) => {
		const url = new URL(req.url ?? '/', 'http://x');
		const signal = url.pathname.startsWith('/signal/');
		const id = decodeURIComponent(url.pathname.slice(signal ? '/signal/'.length : 1));
		const access = registry.verifyToken(url.searchParams.get('token'));
		// Accept, then close with a code: a refused upgrade reaches the browser as
		// a bare 1006, which a client can't tell apart from a network blip.
		if (!access || access.note.id !== id) {
			const code = registry.noteExists(id) ? CLOSE_UNAUTHORIZED : registry.wasEnded(id) ? CLOSE_ENDED : CLOSE_GONE;
			ws.close(code, 'no access');
			return;
		}
		if (signal) onSignalConnection(ws, id, access.role);
		else {
			ws.owner = registry.verifyOwnerProof(id, url.searchParams.get('owner'));
			wss.emit('connection', ws, id, access.role);
		}
	});
});

wss.on('connection', (ws, id, role) => {
	ws.binaryType = 'arraybuffer';
	lastSeen.set(id, Date.now());
	ws.role = role;
	const room = getRoom(id);
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
		try {
			const decoder = decoding.createDecoder(new Uint8Array(data));
			const encoder = encoding.createEncoder();
			const type = decoding.readVarUint(decoder);
			if (type === MESSAGE_SYNC) {
				// Observers may only ask (SyncStep1). SyncStep2 and Update both
				// write into the doc, so from an observer they are dropped here —
				// this, not the client's UI, is what makes observing read-only.
				if (role !== 'edit' && decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) return;
				encoding.writeVarUint(encoder, MESSAGE_SYNC);
				// Applies updates to room.doc (which triggers the broadcast above) and
				// writes any reply (e.g. SyncStep2) into `encoder`.
				syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
				if (encoding.length(encoder) > 1) send(ws, encoding.toUint8Array(encoder));
			} else if (type === MESSAGE_AWARENESS) {
				let update = decoding.readVarUint8Array(decoder);
				const banned = [];
				if (!ws.owner) banned.push('pull');
				if (role !== 'edit') banned.push('laser', 'live');
				if (banned.length > 0) update = stripFields(update, banned);
				awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
			}
		} catch (e) {
			// A malformed message must cost the sender its connection, not the room.
			console.error(`[sync] bad message on ${id}:`, e?.message ?? e);
			ws.close();
		}
	});

	// Keepalive: drop connections that stop responding (mobile links flap).
	ws.isAlive = true;
	ws.on('pong', () => (ws.isAlive = true));

	const cleanup = () => {
		if (!room.conns.has(ws)) return; // 'error' and 'close' both fire
		const owned = room.conns.get(ws);
		room.conns.delete(ws);
		if (owned && owned.size > 0) {
			awarenessProtocol.removeAwarenessStates(room.awareness, [...owned], null);
		}
		if (room.conns.size === 0) {
			lastSeen.set(id, Date.now());
			if (room.saveTimer) saveRoom(id, room);
			room.doc.destroy();
			rooms.delete(id);
		}
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

// Flush pending saves on shutdown (systemctl restart sends SIGTERM).
for (const sig of ['SIGTERM', 'SIGINT']) {
	process.on(sig, () => {
		for (const [id, room] of rooms) if (room.saveTimer) saveRoom(id, room);
		process.exit(0);
	});
}

server.listen(PORT, HOST, () => {
	console.log(`[sync] co-note server on http://${HOST ?? '0.0.0.0'}:${PORT} (data: ${registry.DATA_DIR})`);
});

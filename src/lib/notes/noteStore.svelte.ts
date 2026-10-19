// Reactive store for the current note's shared content (the strokes), backed by
// a Yjs CRDT for conflict-free cross-device sync.
//
// Layers:
//   - Y.Array<Stroke>          the shared, mergeable list of strokes
//   - Y.Array<PageEntry>       the note's pages (imported PDF pages, added
//                              blank pages), in export order; Y.Map 'meta' holds
//                              the page layout. PDF files themselves live on the
//                              note server and in this device's file cache.
//   - IndexeddbPersistence     local-first: survives reloads, works offline
//   - WebsocketProvider        relay through the note server (server/sync-server.js),
//                              which also carries presence (awareness)
//   - P2PLinks                 direct WebRTC links between the note's devices,
//                              introduced by the same server (p2p.ts)
//   - Y.UndoManager            collaboration-aware undo/redo (local edits only)
//
// INVARIANT (unchanged from before): this holds only *shared* content. Viewport
// state (zoom/scroll) is per-session and lives in viewport.svelte.ts — it is
// never put into the Yjs doc, which is exactly why each device keeps its own
// zoom/scroll while the strokes converge. Presence does publish where each
// session is looking, but only as a hint others may draw; nobody adopts it.
//
// Reactivity is signalled with a `revision` counter (and `strokeCount`) rather
// than by making the whole strokes array a deep `$state` proxy — on every remote
// update we'd otherwise re-proxy the entire drawing. `strokes` is a plain cached
// array the canvas reads imperatively while subscribing to `revision`.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { uid, type Brush, type PageEntry, type PageLayout, type Stroke } from './model';
import { P2PLinks } from './p2p';
import { layoutPages, contentBounds, PAGE_GAP, type PlacedPage } from './pages';
import { getCachedFile, cacheFile, dropCachedFiles } from './files';
import { uploadFile, downloadFile } from './api';

export type SyncStatus = 'offline' | 'connecting' | 'connected' | 'disconnected';
/** 'revoked': the server no longer accepts our token (passcode changed).
 *  'gone': the note was deleted. 'ended': it wasn't kept in an account and
 *  everyone had left. Either way we stop reconnecting. */
export type Access = 'ok' | 'revoked' | 'gone' | 'ended';

/** Another session on this note, as it last told us. World coordinates. */
export interface Presence {
	/** Awareness client id: stable for the session, picks its color. */
	id: number;
	color: string;
	label: string;
	/** Pen/mouse position, null while it's off the canvas. */
	cursor: { x: number; y: number } | null;
	/** The part of the world this session's screen shows. */
	view: { x: number; y: number; w: number; h: number } | null;
	/** Laser pointer on: `cursor` is drawing a fading trail. Editors only —
	 *  the relay strips it from observers. */
	laser: boolean;
}

/** The owner asked everyone to look at `view` (world rect). `n` is new for
 *  every pull this session receives. */
export interface Pull {
	n: number;
	view: { x: number; y: number; w: number; h: number };
	label: string;
	color: string;
}

/** How long the owner's `pull` stays in its presence. A device that connects
 *  within this window is pulled too; one that comes later isn't. */
const PULL_TTL_MS = 4000;

/** What this session publishes about itself (see Presence). */
export type LocalPresence = Partial<Pick<Presence, 'cursor' | 'view' | 'laser'>> & {
	pull?: { n: number; view: Rect };
	live?: LiveChunk | null;
};

/**
 * A stroke in progress, as it goes out in presence: the stroke's look, plus
 * the points added since the last chunk (`n` = index of the first), flat as
 * x, y, pressure. Receivers append chunks into a preview (`liveStrokes`) that
 * gives way to the real stroke once it lands in the doc. Editors only — the
 * relay strips `live` from observers.
 */
export interface LiveChunk {
	id: string;
	color: string;
	width: number;
	brush: Brush;
	sim: boolean;
	z?: number;
	page?: string;
	n: number;
	pts: number[];
}

/** A finished preview whose stroke never arrives is dropped after this. */
const LIVE_LINGER_MS = 3000;
/** Bounds on what we accept from others' presence (it's untrusted). */
const LIVE_MAX_POINTS = 20000;
const LIVE_MAX_CHUNK = 2000;

function readLiveChunk(v: any): LiveChunk | null {
	if (!v || typeof v !== 'object') return null;
	const { id, color, width, brush, sim, z, page, n, pts } = v;
	if (typeof id !== 'string' || id.length > 64) return null;
	if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return null;
	if (!finite(width) || width <= 0 || width > 200) return null;
	if (brush !== 'pen' && brush !== 'brush' && brush !== 'marker') return null;
	if (page !== undefined && (typeof page !== 'string' || page.length > 64)) return null;
	if (z !== undefined && (!finite(z) || z < 0.05 || z > 50)) return null;
	if (!Number.isInteger(n) || n < 0 || n > LIVE_MAX_POINTS) return null;
	if (!Array.isArray(pts) || pts.length % 3 !== 0 || pts.length > LIVE_MAX_CHUNK * 3 || !pts.every(finite)) return null;
	return { id, color, width, brush, sim: sim === true, z, page, n, pts };
}

// Readable on white paper (the labels get a dark backing anyway).
const PRESENCE_COLORS = ['#db2777', '#0284c7', '#65a30d', '#d97706', '#9333ea', '#0d9488', '#ea580c'];

// Close codes from server/sync-server.js.
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_GONE = 4404;
const CLOSE_ENDED = 4410;

/** Where the note server's WebSockets live, overridable with `?sync=`.
 *  Served from a default port (production: Caddy terminates TLS and proxies
 *  `/sync`, see deploy/), it's a same-origin path. Served from an explicit port
 *  (vite dev :5173, preview :4173), it's the server's own port on the same
 *  host, which is how the LAN setup has always worked. */
function syncUrl(): string {
	if (typeof window === 'undefined') return 'ws://localhost:5182';
	const override = new URLSearchParams(location.search).get('sync');
	if (override) return override;
	const proto = location.protocol === 'https:' ? 'wss' : 'ws';
	return location.port ? `${proto}://${location.hostname}:5182` : `${proto}://${location.host}/sync`;
}

/** Direct links are on unless the page has `?p2p=0` (handy to compare, or
 *  if a network misbehaves with WebRTC). */
const p2pEnabled = () => typeof window !== 'undefined' && new URLSearchParams(location.search).get('p2p') !== '0';

/** The sync room / IndexedDB database name for a note id. The note index keys
 *  notes by the same id, so this is the only place the mapping is defined. */
export function roomFor(id: string): string {
	return `pennable-${id}`;
}

/** Delete a note's local stroke data. Only valid for a note that is not
 *  currently connected — disconnect() or switch away first, or the live doc
 *  will just re-persist itself. */
export function destroyNoteData(id: string): Promise<void> {
	if (typeof indexedDB === 'undefined') return Promise.resolve();
	const doc = new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(roomFor(id));
		// Resolve on any terminal outcome: losing the data delete is not worth
		// blocking the UI over, and a blocked delete still lands once tabs close.
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
	return Promise.all([doc, dropCachedFiles(id)]).then(() => {});
}

/** Relay query params: the token, plus the owner proof on the owner's device. */
const wsParams = (token: string, owner?: string): Record<string, string> => (owner ? { token, owner } : { token });

/** The note server's matchmaking socket for direct links (sync-server.js). */
const p2pUrl = (id: string, token: string) =>
	`${syncUrl()}/signal/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

type Rect = { x: number; y: number; w: number; h: number };
const readRect = (v: any): Rect | null =>
	v && finite(v.x) && finite(v.y) && finite(v.w) && finite(v.h) && v.w > 0 && v.h > 0
		? { x: v.x, y: v.y, w: v.w, h: v.h }
		: null;

/** Other sessions' awareness states → Presence. These come from other devices,
 *  so everything is checked rather than trusted. */
function readPresence(states: Map<number, Record<string, any>>, self: number): Presence[] {
	const out: Presence[] = [];
	for (const [id, st] of states) {
		if (id === self || !st) continue;
		const c = st.cursor;
		out.push({
			id,
			color: PRESENCE_COLORS[id % PRESENCE_COLORS.length],
			label: typeof st.label === 'string' ? st.label.slice(0, 40) : '',
			cursor: c && finite(c.x) && finite(c.y) ? { x: c.x, y: c.y } : null,
			view: readRect(st.view),
			laser: st.laser === true
		});
	}
	return out;
}

class NoteStore {
	id = $state('');
	loaded = $state(false); // local IndexedDB hydrated
	revision = $state(0); // bumps on any strokes change (canvas redraw trigger)
	strokeCount = $state(0);
	canUndo = $state(false);
	canRedo = $state(false);
	status = $state<SyncStatus>('offline');
	peers = $state(1); // this device + connected others
	access = $state<Access>('ok');
	/** Other sessions on this note (not us). Replaced wholesale on change. */
	presence = $state.raw<Presence[]>([]);
	/** The latest pull from the owner (only the owner's connection can send
	 *  one — the relay strips `pull` from everyone else's presence). */
	pulled = $state.raw<Pull | null>(null);
	/** Bumps when others' strokes in progress change (see `liveStrokes`). */
	liveRevision = $state(0);
	/** Open direct (WebRTC) links: on the hub, one per device; elsewhere 0 or 1. */
	direct = $state(0);
	/** Whether this device is the hub the others link to directly. */
	hub = $state(false);
	/** The note's pages, placed in the world. Updated with `revision`. */
	pages = $state.raw<PlacedPage[]>([]);
	/** Which way pages run (shared by everyone on the note). */
	layout = $state<PageLayout>('vertical');

	#doc: Y.Doc | null = null;
	#arr: Y.Array<Stroke> | null = null;
	#pages: Y.Array<PageEntry> | null = null;
	#meta: Y.Map<unknown> | null = null;
	#token = '';
	#undo: Y.UndoManager | null = null;
	#ws: WebsocketProvider | null = null;
	#idb: IndexeddbPersistence | null = null;
	#p2p: P2PLinks | null = null;
	/** Pulls: ours (counter and the timer that withdraws it), and the last one
	 *  acted on per other session. */
	#pullSeq = 0;
	#pullTimer: ReturnType<typeof setTimeout> | null = null;
	#pullsSeen = new Map<number, number>();
	/** Others' strokes in progress, by stroke id. `ended`: when its sender
	 *  stopped sending (the real stroke is on its way). */
	#live = new Map<string, { client: number; stroke: Stroke; ended: number | null }>();
	#liveTimer: ReturnType<typeof setTimeout> | null = null;
	#cache: Stroke[] = [];

	/** Plain, non-reactive snapshot of strokes for imperative rendering. Pair
	 *  reads with a read of `revision` to stay reactive. */
	get strokes(): Stroke[] {
		return this.#cache;
	}

	/** Open a note, tearing down any note already open. Switching notes swaps the
	 *  whole Yjs layer (doc, local persistence, relay, direct links, undo
	 *  history) — nothing carries across, since each note is an independent
	 *  document and room.
	 *
	 *  `token` is the server-issued credential for this note (see api.ts); the
	 *  server decides from it whether our writes count, on the relay and on
	 *  the direct links it introduces. `label` is how other sessions see us.
	 *  `owner` is the owner proof, on the owner's device only. */
	connect(id: string, opts: { token?: string; label?: string; owner?: string } = {}) {
		if (this.#doc && this.id === id) return; // already on this note
		this.disconnect();
		this.id = id;
		const room = roomFor(id);
		const token = opts.token ?? '';

		const doc = new Y.Doc();
		const arr = doc.getArray<Stroke>('strokes');
		const pages = doc.getArray<PageEntry>('pages');
		const meta = doc.getMap<unknown>('meta');
		this.#doc = doc;
		this.#arr = arr;
		this.#pages = pages;
		this.#meta = meta;
		this.#token = token;

		// Async callbacks below can outlive a fast note switch, so every one of
		// them checks that `doc` is still the open document before touching state
		// — otherwise a stale note's late 'synced' would report as the new one's.
		const current = () => this.#doc === doc;

		this.#idb = new IndexeddbPersistence(room, doc);
		this.#idb.on('synced', () => {
			if (!current()) return;
			this.loaded = true;
			this.#refresh();
		});

		// Local edits have origin `null` (tracked by default); remote edits carry
		// the websocket provider (or a direct link) as origin (not tracked), so
		// undo/redo only ever affects this device's own strokes.
		// Pages are tracked too, so adding/deleting a page or importing a PDF is
		// one undo step like any stroke.
		this.#undo = new Y.UndoManager([arr, pages], { captureTimeout: 400 });
		const flags = () => this.#syncUndoFlags();
		this.#undo.on('stack-item-added', flags);
		this.#undo.on('stack-item-popped', flags);
		this.#undo.on('stack-cleared', flags);

		arr.observe(() => {
			if (current()) this.#refresh();
		});
		pages.observe(() => {
			if (current()) this.#refresh();
		});
		meta.observe(() => {
			if (current()) this.#refresh();
		});

		this.status = 'connecting';
		// The WS room is the bare note id; `room` (pennable-<id>) only names the
		// local IndexedDB database.
		const ws = new WebsocketProvider(syncUrl(), id, doc, { params: wsParams(token, opts.owner) });
		this.#ws = ws;

		// Give this session an awareness field before the socket opens.
		//
		// Awareness starts with local state `{}` at clock 0, and a peer that has
		// never heard of us also assumes clock 0. The protocol only accepts an
		// update when `currClock < clock` (y-protocols/awareness), so a clock-0
		// state is dropped on arrival and we stay invisible until Awareness's
		// internal timer renews the clock ~15s later. Writing a field here makes
		// it clock 1, so the first broadcast lands and the peer count is right
		// immediately.
		ws.awareness.setLocalState({
			session: { joinedAt: Date.now() },
			label: opts.label ?? '',
			cursor: null,
			view: null
		});
		ws.on('status', (e: { status: string }) => {
			if (!current() || this.access !== 'ok') return;
			this.status = e.status === 'connected' ? 'connected' : 'connecting';
			if (e.status === 'connected') reannounce();
		});
		// Every reconnect (network blip, renewToken) has the same clock trap as
		// the first connect above, in both directions. On close, y-websocket
		// drops the others' states but keeps their clocks, so when the server
		// replays the very same states they look stale and are ignored; and the
		// server, having dropped ours, ignores our replay at the same clock.
		// Either way presence (and with it the peer count) stays empty until
		// each device next changes something — up to ~15s for a still one.
		// So on connect: forget the departed clients' clocks, and bump ours.
		// ('connected' is emitted before y-websocket sends anything on the new
		// socket, and before the server's replay can arrive.)
		const reannounce = () => {
			const aw = ws.awareness;
			for (const id of [...aw.meta.keys()]) if (id !== doc.clientID && !aw.states.has(id)) aw.meta.delete(id);
			const st = aw.getLocalState();
			if (st) aw.setLocalState({ ...st });
		};
		ws.on('connection-close', (e: CloseEvent | null) => {
			if (!current()) return;
			this.status = 'disconnected';
			const code = e?.code;
			// After renewToken() the old socket's close (often the server's 4401
			// for that very token) can arrive late — it says nothing about the new one.
			const sentToken = new URL((e?.target as WebSocket | null)?.url ?? 'x:').searchParams.get('token');
			if (sentToken !== null && sentToken !== ws.params.token) return;
			if (code === CLOSE_UNAUTHORIZED || code === CLOSE_GONE || code === CLOSE_ENDED) {
				// Retrying can't help; the local copy stays readable.
				this.access = code === CLOSE_GONE ? 'gone' : code === CLOSE_ENDED ? 'ended' : 'revoked';
				ws.disconnect();
				this.#p2p?.destroy();
				this.#p2p = null;
				this.direct = 0;
				this.hub = false;
				this.status = 'offline';
			}
		});
		ws.awareness.on('change', () => {
			if (!current()) return;
			const states = ws.awareness.getStates();
			this.peers = states.size;
			this.presence = readPresence(states, doc.clientID);
			this.#readPulls(states, doc.clientID);
			this.#readLive(states, doc.clientID);
		});

		if (p2pEnabled()) this.#startP2P(id, token);
		this.#refresh();
	}

	#startP2P(id: string, token: string) {
		const doc = this.#doc!;
		const ws = this.#ws!;
		this.#p2p = new P2PLinks(doc, p2pUrl(id, token), {
			// Updates from the hub are applied as if the relay had delivered them:
			// the provider won't upload them again, and undo ignores them.
			remoteOrigin: () => ws,
			onChange: (s) => {
				if (this.#doc !== doc) return;
				this.direct = s.links;
				this.hub = s.hub;
			}
		});
	}

	/** Reconnect the open note with a new token (after the owner changed the
	 *  passcodes, or the user re-entered one). */
	renewToken(token: string, owner?: string) {
		if (!this.#ws) return;
		this.#token = token;
		this.#ws.disconnect();
		this.#ws.params = wsParams(token, owner ?? this.#ws.params.owner);
		this.access = 'ok';
		this.status = 'connecting';
		this.#ws.connect();
		if (this.#p2p) this.#p2p.setUrl(p2pUrl(this.id, token));
		else if (p2pEnabled()) this.#startP2P(this.id, token);
	}

	/** Publish this session's cursor and/or visible area. Cheap to call; the
	 *  caller throttles (every call is a message to every other session). */
	setPresence(fields: LocalPresence) {
		const aw = this.#ws?.awareness;
		if (!aw) return;
		const prev = aw.getLocalState() ?? {};
		aw.setLocalState({ ...prev, ...fields });
	}

	/** Bring everyone else to `view` (world rect): published in our presence
	 *  for a few seconds. Only takes effect from the owner's device; the relay
	 *  strips it from anyone else's. */
	pullEveryone(view: Rect) {
		this.setPresence({ pull: { n: ++this.#pullSeq, view } });
		if (this.#pullTimer) clearTimeout(this.#pullTimer);
		const ws = this.#ws;
		this.#pullTimer = setTimeout(() => {
			this.#pullTimer = null;
			if (this.#ws !== ws || !ws) return;
			const { pull: _, ...rest } = ws.awareness.getLocalState() ?? {};
			ws.awareness.setLocalState(rest);
		}, PULL_TTL_MS);
	}

	/** A pull we haven't acted on yet → `pulled`. */
	#readPulls(states: Map<number, Record<string, any>>, self: number) {
		for (const [id, st] of states) {
			const p = st?.pull;
			if (id === self || !p || !Number.isInteger(p.n)) continue;
			const view = readRect(p.view);
			if (!view || this.#pullsSeen.get(id) === p.n) continue;
			this.#pullsSeen.set(id, p.n);
			const who = this.presence.find((q) => q.id === id);
			this.pulled = {
				n: (this.pulled?.n ?? 0) + 1,
				view,
				label: who?.label ?? '',
				color: who?.color ?? PRESENCE_COLORS[0]
			};
		}
	}

	/** Others' strokes in progress (previews; plain array, read with
	 *  `liveRevision`). Same shape as committed strokes, so they draw alike. */
	get liveStrokes(): Stroke[] {
		return [...this.#live.values()].map((e) => e.stroke);
	}

	/** Append the chunks in others' presence to their previews. Runs on every
	 *  awareness change, i.e. once per message, so no chunk is skipped. */
	#readLive(states: Map<number, Record<string, any>>, self: number) {
		let changed = false;
		const open = new Set<string>();
		for (const [client, st] of states) {
			if (client === self) continue;
			const l = readLiveChunk(st?.live);
			if (!l) continue;
			open.add(l.id);
			let e = this.#live.get(l.id);
			if (!e) {
				// A late chunk of a stroke that already landed (it can overtake
				// presence on a direct link): nothing to preview.
				if (this.#cache.some((s) => s.id === l.id)) continue;
				const stroke: Stroke = { id: l.id, color: l.color, width: l.width, brush: l.brush, sim: l.sim, points: [] };
				if (l.page) stroke.page = l.page;
				if (l.z) stroke.z = l.z;
				this.#live.set(l.id, (e = { client, stroke, ended: null }));
			}
			if (e.client !== client) continue;
			e.ended = null;
			const pts = e.stroke.points;
			// Chunks repeat when presence is re-sent for another reason; a gap
			// (we joined mid-stroke) just joins up with a straight line.
			const from = Math.max(0, pts.length - l.n);
			for (let i = from * 3; i < l.pts.length && pts.length < LIVE_MAX_POINTS; i += 3) {
				pts.push({ x: l.pts[i], y: l.pts[i + 1], pressure: Math.min(1, Math.max(0, l.pts[i + 2])) });
				changed = true;
			}
		}
		const now = performance.now();
		for (const [id, e] of this.#live) {
			if (open.has(id) || e.ended !== null) continue;
			e.ended = now; // sender lifted the pen (or left)
			changed = true;
		}
		if (changed) {
			this.liveRevision++;
			this.#scheduleLivePrune();
		}
	}

	/** Drop previews whose stroke landed, or that ended long enough ago. */
	#pruneLive() {
		if (this.#live.size === 0) return;
		const ids = new Set(this.#cache.map((s) => s.id));
		const now = performance.now();
		let changed = false;
		for (const [id, e] of this.#live) {
			if (ids.has(id) || (e.ended !== null && now - e.ended > LIVE_LINGER_MS)) {
				this.#live.delete(id);
				changed = true;
			}
		}
		if (changed) this.liveRevision++;
	}

	/** Wake when the oldest finished preview is due to go. */
	#scheduleLivePrune() {
		if (this.#liveTimer) clearTimeout(this.#liveTimer);
		this.#liveTimer = null;
		let due = Infinity;
		for (const e of this.#live.values()) if (e.ended !== null) due = Math.min(due, e.ended + LIVE_LINGER_MS);
		if (due === Infinity) return;
		this.#liveTimer = setTimeout(() => {
			this.#liveTimer = null;
			this.#pruneLive();
			this.#scheduleLivePrune();
		}, Math.max(0, due - performance.now()) + 20);
	}

	/** Close the open note and reset to the pre-connect state. Idempotent. */
	disconnect() {
		if (!this.#doc) return;
		// Providers first, then the doc they observe.
		this.#p2p?.destroy();
		this.#p2p = null;
		this.#ws?.destroy();
		this.#idb?.destroy();
		this.#undo?.destroy();
		this.#doc.destroy();
		this.#ws = null;
		this.#idb = null;
		this.#undo = null;
		this.#doc = null;
		this.#arr = null;
		this.#pages = null;
		this.#meta = null;
		this.#token = '';
		if (this.#pullTimer) clearTimeout(this.#pullTimer);
		this.#pullTimer = null;
		this.#pullsSeen.clear();
		this.pulled = null;
		if (this.#liveTimer) clearTimeout(this.#liveTimer);
		this.#liveTimer = null;
		this.#live.clear();
		this.liveRevision++;

		this.#cache = [];
		this.loaded = false;
		this.strokeCount = 0;
		this.canUndo = false;
		this.canRedo = false;
		this.status = 'offline';
		this.peers = 1;
		this.access = 'ok';
		this.presence = [];
		this.direct = 0;
		this.hub = false;
		this.pages = [];
		this.layout = 'vertical';
		this.revision++; // repaint the now-empty canvas
	}

	/** Snapshot boundary for undo: call once at the start of a gesture so it
	 *  undoes as a single step. addStroke does this for you; the eraser calls it
	 *  on its first hit. */
	beginChange() {
		this.#undo?.stopCapturing();
	}

	addStroke(stroke: Stroke) {
		if (!this.#arr) return;
		this.beginChange();
		this.#arr.push([stroke]);
	}

	/** Remove strokes by id in one transaction (so an erase drag merges into a
	 *  single undo step). Does NOT start a new undo boundary — the caller owns
	 *  that via beginChange(). */
	removeStrokes(ids: Set<string>) {
		if (!this.#arr || !this.#doc || ids.size === 0) return;
		const arr = this.#arr;
		this.#doc.transact(() => {
			for (let i = arr.length - 1; i >= 0; i--) {
				if (ids.has(arr.get(i).id)) arr.delete(i, 1);
			}
		});
	}

	clear() {
		if (!this.#arr || !this.#doc || this.#arr.length === 0) return;
		const arr = this.#arr;
		this.beginChange();
		this.#doc.transact(() => arr.delete(0, arr.length));
	}

	undo() {
		this.#undo?.undo();
	}

	redo() {
		this.#undo?.redo();
	}

	// --- Pages ------------------------------------------------------------------

	/** World bounds of pages + ink, for Fit / Follow. */
	contentBounds() {
		return contentBounds(this.#cache, this.pages);
	}

	/** A file of this note: from this device's cache, else from the server. */
	async fileBytes(hash: string): Promise<Uint8Array> {
		const id = this.id;
		const cached = await getCachedFile(id, hash);
		if (cached) return cached;
		const bytes = await downloadFile(id, hash, this.#token);
		await cacheFile(id, hash, bytes);
		return bytes;
	}

	/**
	 * Import a PDF: upload it, then append its pages. The file is checked with
	 * pdf.js first, so a broken or locked PDF fails here rather than on every
	 * device that opens the note. Throws ApiError / Error with a message for
	 * the user. One undo step.
	 */
	async importPdf(file: Blob) {
		const doc = this.#doc;
		if (!doc) return;
		const id = this.id;
		const bytes = new Uint8Array(await file.arrayBuffer());
		const { readPdfPages } = await import('./pdf');
		let info;
		try {
			info = await readPdfPages(bytes);
		} catch (e) {
			const name = (e as { name?: string })?.name;
			throw new Error(name === 'PasswordException' ? 'That PDF is password-protected.' : "That file couldn't be read as a PDF.");
		}
		const hash = await uploadFile(id, this.#token, bytes);
		await cacheFile(id, hash, bytes);
		if (this.#doc !== doc) return; // switched notes meanwhile
		const pages = this.#pages!;
		const meta = this.#meta!;
		const arr = this.#arr!;
		// A PDF conote exported: its pages as they were (added ones beside
		// their page), and its ink back as strokes.
		const conote = info.conote;
		const ids = info.pages.map(() => uid());
		this.beginChange();
		doc.transact(() => {
			// The first pages go below (or beside) any ink already there, not over it.
			if (pages.length === 0 && this.#cache.length > 0) {
				const b = contentBounds(this.#cache, []);
				if (b) {
					meta.set(
						'origin',
						this.layout === 'vertical' ? { x: b.x0, y: b.y1 + 2 * PAGE_GAP } : { x: b.x1 + 2 * PAGE_GAP, y: b.y0 }
					);
				}
			}
			if (conote && pages.length === 0) meta.set('layout', conote.layout);
			pages.push(
				info.pages.map((p, index) => ({
					id: ids[index],
					w: p.w,
					h: p.h,
					extra: index > 0 && !!conote?.pages[index].extra,
					pdf: { file: hash, index, vt: p.vt }
				}))
			);
			if (conote && conote.strokes.length > 0) {
				arr.push(conote.strokes.map((s) => ({ ...s, id: uid(), page: ids[s.page] })));
			}
		});
	}

	/** Add a blank page, the size of `afterId`, right after it: beside it in
	 *  the UI, next in the exported PDF. */
	insertPageAfter(afterId: string) {
		const pages = this.#pages;
		if (!pages) return;
		const list = pages.toArray();
		const i = list.findIndex((p) => p.id === afterId);
		if (i < 0) return;
		this.beginChange();
		pages.insert(i + 1, [{ id: uid(), w: list[i].w, h: list[i].h, extra: true }]);
	}

	/** Remove a page. Its ink stays in the doc (hidden), so undo brings both back.
	 *  Deleting a main page promotes its first added page into its place, so
	 *  the added pages stay where they were instead of joining the row above. */
	deletePage(pageId: string) {
		const pages = this.#pages;
		if (!pages || !this.#doc) return;
		const list = pages.toArray();
		const i = list.findIndex((p) => p.id === pageId);
		if (i < 0) return;
		this.beginChange();
		this.#doc.transact(() => {
			pages.delete(i, 1);
			const next = list[i + 1];
			if (!list[i].extra && next?.extra) {
				pages.delete(i, 1);
				pages.insert(i, [{ ...next, extra: false }]);
			}
		});
	}

	setLayout(layout: PageLayout) {
		this.#meta?.set('layout', layout);
	}

	/** The note as a PDF (see exportPdf.ts). */
	async exportPdf(): Promise<Uint8Array> {
		const { exportPdf } = await import('./exportPdf');
		return exportPdf(this.#pages?.toArray() ?? [], this.#cache, (h) => this.fileBytes(h), this.layout);
	}

	#refresh() {
		this.#cache = this.#arr ? this.#arr.toArray() : [];
		this.strokeCount = this.#cache.length;
		const layout = this.#meta?.get('layout') === 'horizontal' ? 'horizontal' : 'vertical';
		const origin = this.#meta?.get('origin') as { x: number; y: number } | undefined;
		this.layout = layout;
		this.pages = layoutPages(
			this.#pages?.toArray() ?? [],
			layout,
			origin && Number.isFinite(origin.x) && Number.isFinite(origin.y) ? origin : undefined
		);
		this.revision++;
		this.#syncUndoFlags();
		this.#pruneLive(); // a preview's stroke may just have landed
	}

	#syncUndoFlags() {
		this.canUndo = this.#undo ? this.#undo.canUndo() : false;
		this.canRedo = this.#undo ? this.#undo.canRedo() : false;
	}
}

export const noteStore = new NoteStore();

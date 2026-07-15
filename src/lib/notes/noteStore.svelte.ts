// Reactive store for the current note's shared content (the strokes), backed by
// a Yjs CRDT for conflict-free cross-device sync.
//
// Layers:
//   - Y.Array<Stroke>          the shared, mergeable list of strokes
//   - IndexeddbPersistence     local-first: survives reloads, works offline
//   - WebsocketProvider        live relay between devices (see server/sync-server.js)
//   - Y.UndoManager            collaboration-aware undo/redo (local edits only)
//
// INVARIANT (unchanged from before): this holds only *shared* content. Viewport
// state (zoom/scroll) is per-session and lives in viewport.svelte.ts — it is
// never put into the Yjs doc, which is exactly why each device keeps its own
// zoom/scroll while the strokes converge.
//
// Reactivity is signalled with a `revision` counter (and `strokeCount`) rather
// than by making the whole strokes array a deep `$state` proxy — on every remote
// update we'd otherwise re-proxy the entire drawing. `strokes` is a plain cached
// array the canvas reads imperatively while subscribing to `revision`.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import type { Stroke } from './model';
import { newBroadcastId, newEditToken, noteIdForBroadcast, type Role } from './broadcast';
import { StarHost, StarGuest, type GuestStatus } from './webrtcStar';

export type SyncStatus = 'offline' | 'connecting' | 'connected' | 'disconnected';

function defaultSignalUrl(): string {
	if (typeof window === 'undefined') return 'ws://localhost:5183';
	const override = new URLSearchParams(location.search).get('signal');
	if (override) return override;
	const proto = location.protocol === 'https:' ? 'wss' : 'ws';
	return `${proto}://${location.hostname}:5183`;
}

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
	return new Promise((resolve) => {
		const req = indexedDB.deleteDatabase(roomFor(id));
		// Resolve on any terminal outcome: losing the data delete is not worth
		// blocking the UI over, and a blocked delete still lands once tabs close.
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}

function defaultWsUrl(): string {
	if (typeof window === 'undefined') return 'ws://localhost:5182';
	// Allow ?sync=ws://host:port override for testing against a remote relay.
	const override = new URLSearchParams(location.search).get('sync');
	if (override) return override;
	const proto = location.protocol === 'https:' ? 'wss' : 'ws';
	return `${proto}://${location.hostname}:5182`;
}

class NoteStore {
	id = $state('default');
	loaded = $state(false); // local IndexedDB hydrated
	revision = $state(0); // bumps on any strokes change (canvas redraw trigger)
	strokeCount = $state(0);
	canUndo = $state(false);
	canRedo = $state(false);
	status = $state<SyncStatus>('offline');
	peers = $state(1); // this device + connected others

	// --- Broadcast (P2P star) -------------------------------------------------
	/** Non-empty while hosting or joined. Doubles as the signaling room address. */
	broadcastId = $state('');
	/** Only ever set on the host — this is the write credential we hand out. */
	editToken = $state('');
	/** Our part in the broadcast: 'host' | 'edit' | 'view', or null if not in one. */
	role = $state<Role | null>(null);
	broadcastPeers = $state(0);
	broadcastEditors = $state(0);
	/** Writes the host refused from read-only peers. Surfaced so enforcement is
	 *  observable rather than a claim. */
	rejectedWrites = $state(0);
	guestStatus = $state<GuestStatus | null>(null);
	guestError = $state('');

	#doc: Y.Doc | null = null;
	#arr: Y.Array<Stroke> | null = null;
	#undo: Y.UndoManager | null = null;
	#ws: WebsocketProvider | null = null;
	#idb: IndexeddbPersistence | null = null;
	#host: StarHost | null = null;
	#guest: StarGuest | null = null;
	#cache: Stroke[] = [];

	/** Plain, non-reactive snapshot of strokes for imperative rendering. Pair
	 *  reads with a read of `revision` to stay reactive. */
	get strokes(): Stroke[] {
		return this.#cache;
	}

	/** Open a note, tearing down any note already open. Switching notes swaps the
	 *  whole Yjs layer (doc, local persistence, relay, undo history) — nothing
	 *  carries across, since each note is an independent document and room.
	 *
	 *  `relay: false` opens the note with local persistence only, no central
	 *  relay — used when joining a broadcast, where the whole point is that
	 *  stroke data travels P2P and never through a server. */
	connect(id = 'default', opts: { wsUrl?: string; relay?: boolean } = {}) {
		if (this.#doc && this.id === id) return; // already on this note
		this.disconnect();
		this.id = id;
		const room = roomFor(id);

		const doc = new Y.Doc();
		const arr = doc.getArray<Stroke>('strokes');
		this.#doc = doc;
		this.#arr = arr;

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

		// Local edits have origin `null` (tracked by default); remote edits applied
		// by the websocket provider carry the provider as origin (not tracked), so
		// undo/redo only ever affects this device's own strokes.
		this.#undo = new Y.UndoManager(arr, { captureTimeout: 400 });
		const flags = () => this.#syncUndoFlags();
		this.#undo.on('stack-item-added', flags);
		this.#undo.on('stack-item-popped', flags);
		this.#undo.on('stack-cleared', flags);

		arr.observe(() => {
			if (current()) this.#refresh();
		});

		if (opts.relay === false) {
			this.#refresh();
			return;
		}

		this.status = 'connecting';
		this.#ws = new WebsocketProvider(opts.wsUrl ?? defaultWsUrl(), room, doc);

		// Give this session an awareness field before the socket opens.
		//
		// Awareness starts with local state `{}` at clock 0, and a peer that has
		// never heard of us also assumes clock 0. The protocol only accepts an
		// update when `currClock < clock` (y-protocols/awareness), so a clock-0
		// state is dropped on arrival and we stay invisible until Awareness's
		// internal timer renews the clock ~15s later. Writing a field here makes
		// it clock 1, so the first broadcast lands and the peer count is right
		// immediately. (Presence payloads will go here too — see ROADMAP.)
		this.#ws.awareness.setLocalStateField('session', { joinedAt: Date.now() });
		this.#ws.on('status', (e: { status: string }) => {
			if (!current()) return;
			this.status = e.status === 'connected' ? 'connected' : 'connecting';
		});
		this.#ws.on('connection-close', () => {
			if (current()) this.status = 'disconnected';
		});
		this.#ws.awareness.on('change', () => {
			if (!current()) return;
			this.peers = this.#ws ? this.#ws.awareness.getStates().size : 1;
		});

		this.#refresh();
	}

	/**
	 * Broadcast the open note: mint an id + edit token and host a P2P star.
	 * Returns the credentials — the id alone is a read-only invite, id + token
	 * is an edit invite.
	 */
	startBroadcast(signalUrl = defaultSignalUrl()): { id: string; token: string } | null {
		if (!this.#doc || this.#host) return null;
		const id = newBroadcastId();
		const token = newEditToken();
		this.#host = new StarHost(this.#doc, signalUrl, id, token, () => {
			if (!this.#host) return;
			const s = this.#host.stats;
			this.broadcastPeers = s.peers;
			this.broadcastEditors = s.editors;
			this.rejectedWrites = s.rejected;
		});
		this.broadcastId = id;
		this.editToken = token;
		this.role = 'host';
		return { id, token };
	}

	stopBroadcast() {
		this.#host?.destroy();
		this.#host = null;
		this.#resetBroadcast();
	}

	/**
	 * Join someone else's broadcast. The note is filed locally (so it persists
	 * and appears in the note list like any other), but opened with no relay —
	 * strokes arrive only over the P2P channel.
	 *
	 * Passing a token *asks* for edit; the host decides. `role` reflects the
	 * host's verdict, and is advisory for UI only — the host enforces.
	 */
	joinBroadcast(broadcastId: string, editToken = '', signalUrl = defaultSignalUrl()) {
		const noteId = noteIdForBroadcast(broadcastId);
		this.connect(noteId, { relay: false });
		if (!this.#doc) return;
		this.#guest = new StarGuest(this.#doc, signalUrl, broadcastId, editToken, () => {
			if (!this.#guest) return;
			this.role = this.#guest.role;
			this.guestStatus = this.#guest.status;
			this.guestError = this.#guest.error;
		});
		this.broadcastId = broadcastId;
		this.guestStatus = 'connecting';
	}

	#resetBroadcast() {
		this.broadcastId = '';
		this.editToken = '';
		this.role = null;
		this.broadcastPeers = 0;
		this.broadcastEditors = 0;
		this.rejectedWrites = 0;
		this.guestStatus = null;
		this.guestError = '';
	}

	/** Close the open note and reset to the pre-connect state. Idempotent. */
	disconnect() {
		if (!this.#doc) return;
		// Providers first, then the doc they observe.
		this.#host?.destroy();
		this.#guest?.destroy();
		this.#host = null;
		this.#guest = null;
		this.#resetBroadcast();
		this.#ws?.destroy();
		this.#idb?.destroy();
		this.#undo?.destroy();
		this.#doc.destroy();
		this.#ws = null;
		this.#idb = null;
		this.#undo = null;
		this.#doc = null;
		this.#arr = null;

		this.#cache = [];
		this.loaded = false;
		this.strokeCount = 0;
		this.canUndo = false;
		this.canRedo = false;
		this.status = 'offline';
		this.peers = 1;
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

	#refresh() {
		this.#cache = this.#arr ? this.#arr.toArray() : [];
		this.strokeCount = this.#cache.length;
		this.revision++;
		this.#syncUndoFlags();
	}

	#syncUndoFlags() {
		this.canUndo = this.#undo ? this.#undo.canUndo() : false;
		this.canRedo = this.#undo ? this.#undo.canRedo() : false;
	}
}

export const noteStore = new NoteStore();

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

export type SyncStatus = 'offline' | 'connecting' | 'connected' | 'disconnected';

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

	#doc: Y.Doc | null = null;
	#arr: Y.Array<Stroke> | null = null;
	#undo: Y.UndoManager | null = null;
	#ws: WebsocketProvider | null = null;
	#idb: IndexeddbPersistence | null = null;
	#cache: Stroke[] = [];

	/** Plain, non-reactive snapshot of strokes for imperative rendering. Pair
	 *  reads with a read of `revision` to stay reactive. */
	get strokes(): Stroke[] {
		return this.#cache;
	}

	connect(id = 'default', wsUrl = defaultWsUrl()) {
		if (this.#doc) return; // single note for now; already connected
		this.id = id;
		const room = `pennable-${id}`;

		const doc = new Y.Doc();
		const arr = doc.getArray<Stroke>('strokes');
		this.#doc = doc;
		this.#arr = arr;

		this.#idb = new IndexeddbPersistence(room, doc);
		this.#idb.on('synced', () => {
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

		arr.observe(() => this.#refresh());

		this.status = 'connecting';
		this.#ws = new WebsocketProvider(wsUrl, room, doc);

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
			this.status = e.status === 'connected' ? 'connected' : 'connecting';
		});
		this.#ws.on('connection-close', () => (this.status = 'disconnected'));
		this.#ws.awareness.on('change', () => {
			this.peers = this.#ws ? this.#ws.awareness.getStates().size : 1;
		});

		this.#refresh();
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

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A tablet-installable (PWA) web notes app for pen drawing where **each open session
has its own independent zoom and scroll** while sharing the same note content.
The driving use case: mirror a laptop (full-page view) in a Zoom call while
drawing live on a tablet (zoomed-in) with a stylus — see `README.md`.

## Current state

Working app: pressure pen drawing, eraser, undo/redo, per-session pan/zoom, PWA
install, local persistence, **multiple notes**, and **live cross-device sync**
through a Yjs relay. Type-check and build are clean.

- **Verified:** `npm run check`, `npm run build`, and a headless-Chrome pass over
  the built app driving create/switch/rename/delete, per-note persistence across
  reload, `?note=` join from an isolated browser profile, live stroke sync + peer
  count through the relay, and independent zoom between two sessions.
- **Not yet verified on real hardware:** on-device stylus feel and the Android
  install/load path. Local network reach was flaky over an iPhone hotspot (likely
  client isolation); a firewall rule for TCP 5173–5183 was added and is the fix on
  a normal router.
- **Next:** see `ROADMAP.md`. North star is decentralized P2P broadcast (central =
  matchmaking only).

## Stack

- **SvelteKit 2 + Svelte 5 (runes)**, TypeScript, Vite 5.
- **SPA** via `@sveltejs/adapter-static` with `fallback: 'index.html'` and
  `ssr = false` / `prerender = false` (`src/routes/+layout.ts`). No server — it
  hosts as plain static files.
- **PWA** via `@vite-pwa/sveltekit` (`generateSW`, `autoUpdate`). The manifest
  link and service-worker registration are injected client-side in
  `src/routes/+layout.svelte` (`virtual:pwa-info` / `virtual:pwa-register`).
- **Sync**: Yjs CRDT — `yjs` + `y-indexeddb` (local-first) + `y-websocket`
  (client) against a standalone relay in `server/sync-server.js`. `ws` is a
  server-only dep (never bundled into the client).

Note: the `sv` / `create-svelte` CLI needs Node ≥20.12; this repo was scaffolded
by hand and runs on the local Node 20.2. Keep Vite pinned to ^5 (Vite 7 wants
Node ≥20.19).

## Commands

- `npm run dev` — dev server (`host: true`, so a tablet on the same LAN can reach it).
- `npm run sync` — Yjs relay server on port **5182** (`SYNC_PORT` to override).
  Run this alongside the app for cross-device sync; both devices connect to it.
- `npm run build` — production build to `build/`.
- `npm run preview` — serve the built SPA locally.
- `npm run check` — `svelte-kit sync` + `svelte-check` (type check). Run this
  after changes; there is no separate lint/test setup yet.
- Icons: regenerate the placeholder PWA icons with
  `node <scratchpad>/gen-icons.mjs static/icons` (dependency-free PNG generator).
  Replace `static/icons/*` with real artwork before shipping.

## Architecture — the one thing to understand

The whole app hinges on a **world/screen coordinate split**:

- **World coordinates**: an infinite 2D plane where all stroke geometry lives.
  This is the *shared* note content — every session sees the same world.
- **Screen coordinates**: what a given device actually displays.
- A per-session **`Viewport`** maps between them: `screen = world*scale + offset`.

This split is what delivers the core requirement. Two rules follow from it and
must be preserved:

1. **`Viewport` is per-session and never shared.** Each session constructs its
   own `Viewport` (in `+page.svelte`). Zoom/scroll live *only* here — do not put
   them in the note model or persistence. This is why laptop and tablet stay
   independent.
2. **`noteStore` holds only shared content** (the strokes), and it is the Yjs
   doc. Anything drawn goes into world coordinates via `viewport.toWorld(...)`.
   Sync replicates `noteStore`, **never** the viewport — that's what keeps each
   device's zoom/scroll independent while the strokes converge.

### Key files

- `src/lib/notes/model.ts` — `Stroke`/`StrokePoint` types; all geometry in
  world coords, `pressure` in [0,1]. There is no `Note` type: a note's strokes are
  the Yjs array in `noteStore`, its title/id are `NoteMeta` in `noteIndex`.
- `src/lib/notes/noteIndex.svelte.ts` — the list of notes **on this device**
  (localStorage, *not* a Yjs doc, deliberately not synced — see below).
- `src/lib/notes/viewport.svelte.ts` — the per-session transform (`toWorld`,
  `toScreen`, `panBy`, `zoomAt`, `reset`). Runes class.
- `src/lib/notes/noteStore.svelte.ts` — the Yjs-backed shared note (see "Sync"
  below). Public API the UI depends on: `connect(id, wsUrl?)`/`disconnect()`,
  `strokes` (plain cached array — read together with the reactive `revision`
  counter), `strokeCount`, `addStroke`, `removeStrokes(ids)`, `beginChange`,
  `clear`, `undo`/`redo`, `canUndo`/`canRedo`, and `status`/`peers` for the sync
  indicator. Module-level: `roomFor(id)`, `destroyNoteData(id)`.
- `src/lib/components/DrawingCanvas.svelte` — the canvas + all input. See below.
- `src/routes/+page.svelte` — toolbar + owns the session `Viewport` and draw/observe mode.
- `server/sync-server.js` — the standalone Yjs relay (Node + `ws`).

### Notes (`noteIndex.svelte.ts`)

- **The note index is local-only and is not a Yjs doc.** Per `ROADMAP.md` notes
  belong to the user and live locally; only a note you explicitly hand to someone
  is shared. So each device has its own list, and a peer reaches a specific note
  by id: **`?note=<id>`**. Don't "fix" this by syncing the index — that seam is
  where the broadcast/join flow (broadcast ID + permission handshake) plugs in.
- One note = one Yjs doc = one room = one IndexedDB database (`roomFor(id)`).
  Switching notes swaps the whole Yjs layer; nothing carries across.
- `connect()` is the only entry point and tears down the previous note first.
  Its async callbacks (idb `synced`, ws `status`, awareness) all guard on the doc
  still being the open one, so a fast switch can't have a stale note write state
  belonging to the new one.
- `'default'` is the pre-notes-list note, seeded into the index on first run so
  existing drawings survive the upgrade. It isn't special otherwise.

### Sync (`noteStore.svelte.ts` + `server/sync-server.js`)

- Strokes live in a `Y.Array<Stroke>` (room = `pennable-<noteId>`). `y-indexeddb`
  persists the doc locally (offline-first); `WebsocketProvider` relays live edits.
- **Reactivity is signalled by a `revision` counter, not deep `$state`** — on
  every (possibly remote) update we bump `revision` and rebuild a plain `strokes`
  cache, instead of re-proxying the whole drawing. Canvas redraws on `revision`;
  the "empty?" checks use `strokeCount`.
- **Undo/redo is `Y.UndoManager`** (`captureTimeout: 400`). It only tracks local
  edits (origin `null`); remote peers' edits are applied with the provider as
  origin and are therefore not undoable here. Gesture boundary = one step:
  `beginChange()` → `stopCapturing()`; `addStroke` calls it; the eraser calls it
  on first hit; `removeStrokes` runs its deletes in a single `doc.transact`.
- Strokes are treated as **immutable once committed** (append + delete only) — do
  not mutate a stroke in place, or you'll desync peers and break undo snapshots.
- WS URL: defaults to `ws(s)://<page-host>:5182`, overridable with `?sync=ws://…`.
- **`connect()` must set an awareness field** (`setLocalStateField('session', …)`)
  before the socket opens — don't remove it. Awareness starts at clock 0, and a
  peer that has never seen us also assumes clock 0; `applyAwarenessUpdate` only
  accepts an update when `currClock < clock`, so a clock-0 state is dropped and
  the session stays invisible until Awareness's timer renews the clock ~15s later.
  Without the field the peer count silently reads 1 for the first ~15s. Stroke
  sync is unaffected (different message type), which is what makes it easy to miss.

### Canvas & input conventions (`DrawingCanvas.svelte`)

- **Input type decides intent (palm rejection):** pen/mouse **draw**; touch
  **navigates** (one finger pans, two fingers pinch-zoom + pan). `ctrl`+wheel and
  plain wheel both zoom at the cursor. `touch-action: none` — we own all gestures.
- **Live stroke is component-local**, not in the store. Per-point updates happen
  here (using `getCoalescedEvents()` for high-frequency pen sampling) and only the
  finished stroke is handed to `noteStore.addStroke`. This keeps drawing off the
  reactive path so it stays smooth — preserve this separation.
- **Rendering** is an imperative `requestAnimationFrame` loop gated by a `dirty`
  flag, not per-point reactivity. The canvas is scaled by `devicePixelRatio`; the
  world→device transform is applied via `ctx.setTransform` and strokes are drawn
  in world units (so ink zooms with content). `$effect` flips `dirty` when
  `noteStore.revision` (local or remote change) or the viewport changes.
- **`mode = 'observe'`** disables inking but still allows pan/zoom — this is the
  README's "observer" session.
- **Tools:** `tool = 'pen' | 'eraser'`. The eraser is stroke-level (removes whole
  strokes it touches, via `strokeHit` distance testing) with a **screen-constant**
  radius (`ERASER_SCREEN_RADIUS / viewport.scale` → world units), and one drag =
  one undo step.

## Not built yet

See `ROADMAP.md` for the full plan. Highlights:

- **North star: decentralized P2P broadcast.** Notes stay local; a central server
  does *matchmaking only* while stroke data flows peer-to-peer (WebRTC). Broadcast
  a note → get a broadcast ID → others join read-only or editable. Today's
  `server/sync-server.js` (central Yjs relay) becomes the fallback for large
  audiences / NAT-traversal failures.
- **Deploying sync beyond the LAN** — the relay is in-memory and unauthenticated,
  fine for personal same-network use. Internet use needs hosting + access control.
- **Awareness UI** — peer *count* is shown, but live cursors/presence aren't.

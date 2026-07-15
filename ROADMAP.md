# Roadmap

## Status: the P2P broadcast path is built (v1)

Broadcast/join over a WebRTC **star** is implemented and verified end-to-end:
`server/signal-server.js` (matchmaking only), `src/lib/notes/webrtcStar.ts`
(transport + enforcement), `src/lib/notes/broadcast.ts` (ids/tokens).

The open questions below are answered as follows; the reasoning is worth keeping:

- **Permission enforcement → solved by topology, not crypto.** `y-webrtc` was
  rejected: it is a full mesh with no permission model (its `password` only
  encrypts *signaling*), so an observer running a patched client could write
  straight to other peers. In a star, every joiner's only link is to the
  broadcaster, so the broadcaster always knows who sent an update and drops
  writes from read-only peers. Verified with a hostile raw client: the identical
  Yjs update lands with a valid token and is refused without one.
- **Broadcast ID scheme → split into two secrets.** 8-char id (~39 bits) is the
  room address and grants read-only; a separate 16-char token (~78 bits) grants
  edit. The token travels over the P2P data channel, never through signaling, so
  the central server cannot mint editors.
- **NAT traversal → STUN only, deliberately.** TURN would relay the stroke data,
  which is the thing this design exists to avoid. Hard-NAT pairs should fall back
  to the central Yjs relay instead.

### Still open

- **Broadcaster is a single point.** If it drops off, joiners stop syncing. The
  star is what makes permissions enforceable, so this is an accepted trade.
- **Relay fallback is not automatic.** A broadcast that can't traverse NAT just
  fails; nothing yet detects that and switches to `server/sync-server.js`.
- **A joined note stays read-only after the broadcast ends**, even though it's
  then just a local copy. Arguably it should become editable — undecided.
- **Signaling server is unauthenticated and in-memory**, like the relay. Fine for
  personal/LAN use; internet use needs hosting + abuse limits (nothing rate-limits
  broadcast-id guessing today).

## North star: decentralized, local-first notes with P2P broadcast

Notes belong to the user and live **locally** (already true today via y-indexeddb).
Nothing about a note's content should require a server. The only thing that is
ever central is **matchmaking** — a lightweight way for a broadcaster and joiners
to find each other. Once they've found each other, the actual drawing data flows
**peer-to-peer**, not through the central server.

### The flow

1. I have all my notes locally.
2. I pick one note and **broadcast** it. This mints a short **broadcast ID**.
3. I hand that ID to my tablet, or to other people.
4. They **join** using the ID, each with a chosen permission:
   - **read-only (observer)** — consumes the note, no editing (maps to today's
     `mode = 'observe'`), or
   - **edit** — can draw into the shared note.
5. Joiners keep their **own zoom/scroll** (the existing per-session `Viewport`
   invariant carries over unchanged).

### Transport

- **Central = matchmaking/signaling only.** Peers register under the broadcast ID,
  exchange connection info (ICE candidates / addresses), and then connect
  **directly** to each other. The signaling server never sees stroke data.
- **P2P for a handful of listeners** — direct WebRTC connections (a small mesh, or
  star with the broadcaster at the center). Expected to scale to a handful.
- **Central relay fallback for 10+** — for larger audiences, fall back to routing
  through a server. **Today's `server/sync-server.js` is exactly this fallback**:
  a central Yjs relay. So the two modes coexist; the decentralized path is the new
  default, the relay is the escape hatch for scale (or for NAT traversal failures).

### How it maps to the current code

- **Keep:** the Yjs data model (`Y.Array<Stroke>`), y-indexeddb local persistence,
  the per-session `Viewport`, and observe/edit modes. These are transport-agnostic.
- **Add:** a WebRTC provider (e.g. `y-webrtc`, which pairs a signaling server with
  P2P data channels and reuses the same Yjs doc). The `noteStore.connect()` seam is
  where the provider is chosen; a note can run over WebRTC, the WS relay, or both.
- **Add:** the broadcast/join UX — mint/enter a broadcast ID (the Yjs "room"), and
  a permission handshake (observers get a read-only doc; editors get write access).
- **Build:** the small signaling server (matchmaking only). Could live alongside
  `server/sync-server.js`.

### Open questions to resolve when we build it

- **Permission enforcement.** Read-only must be enforced, not just a client-side
  toggle — an observer's peer shouldn't be able to write to others' docs. Likely
  needs the broadcaster to gate/validate incoming updates, or per-peer auth.
- **NAT traversal.** Direct connections over the open internet need STUN, and
  sometimes TURN (which is itself a relay — blurs the "no central data" goal for
  hard-NAT cases). LAN / same-hotspot P2P is the easy, reliable case.
- **Broadcast ID scheme.** Short, shareable, hard to guess (it's the access token).
- **Discovery vs. security.** The ID doubles as "where to connect" and "who's
  allowed" — consider separating the room address from an access secret.

---

## Nearer-term candidates (smaller, independent of the above)

- ~~**Multiple notes / pages**~~ — done. Local note index (`noteIndex.svelte.ts`)
  + `?note=<id>` to open a specific note. The index is deliberately local-only,
  so `?note=<id>` is the embryonic form of the join flow above: replace it with a
  real broadcast ID + permission handshake and the UX lands.
- **Live presence** — show peers' cursors/viewports, not just a peer count.
- **Stroke polish** — curve smoothing; "fit to content" so the laptop view can
  auto-frame the whole drawing.
- **Real PWA icons** — replace the generated placeholder icons in `static/icons/`.

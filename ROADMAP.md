# Roadmap

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

- **Multiple notes / pages** — a real list to create/switch notes (the room/id
  plumbing already exists; only one `'default'` note today).
- **Live presence** — show peers' cursors/viewports, not just a peer count.
- **Stroke polish** — curve smoothing; "fit to content" so the laptop view can
  auto-frame the whole drawing.
- **Real PWA icons** — replace the generated placeholder icons in `static/icons/`.

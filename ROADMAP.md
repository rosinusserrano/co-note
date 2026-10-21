# Roadmap

## Status: server-hosted notes with passcodes (current UI)

The app now runs at conote.sniggles.de and the UI follows a **create / join**
model. Anyone opening the site picks *Join a note* (name + passcode) or *Create
a note* (name, editor passcode, observer setting). The creator can later change
the passcodes or delete the note. Many notes run in parallel on one server.

The server is the central connecting point: registry, passcode check, token
minting, matchmaking. Every stroke still goes through the relay, which enforces
roles (observer writes are dropped) and stores each note so it's complete for
whoever joins next.

### Done: direct links alongside the relay

Devices on a note now also exchange strokes directly over WebRTC (`p2p.ts`):

- **Star around a hub**, the longest-connected editor — the v1 star, with roles
  from note tokens instead of a separate edit secret. The hub drops observers'
  writes; matchmaking (now inside the note server, behind the same token) only
  forwards signals with the hub at one end, so no other link can form.
- **Hub handover** when the hub leaves; **revocation** (passcode change, delete)
  closes matchmaking sockets too, and the hub cuts those links.
- **Relay fallback is automatic** because the relay never goes away: pairs that
  can't connect directly (hard NAT, STUN only) just keep using it, and Yjs
  dedupes what arrives on both paths. This also answers v1's "relay fallback is
  not automatic".
- The old open signaling server (`/signal`, `conote-signal`) is gone.

Gained: LAN-latency strokes between devices in the same room, and strokes keep
flowing between them if the server link drops. **Not** gained yet: less server
traffic — see below.

### Next: actually take strokes off the server

Today the relay still fans every stroke out to every device, direct link or not.
Options, roughly in order of effort:

1. **Relay skips devices the hub reaches.** Clients report "direct link open"
   over matchmaking; the relay stops sending doc updates to them (still accepts
   their uploads, still stores). Cuts server *egress* to ~one copy per stroke.
   Risk: a link that dies silently loses strokes until the client notices and
   tells the relay — needs a resync on link loss (SyncStep1 over the relay).
2. **Only the hub uploads.** Other devices stop sending to the relay while their
   link is up. Cuts ingress too, but the server copy now depends on the hub.
3. **No server copy at all** while someone is online, upload on demand. Closest
   to "notes belong to the user"; makes "join when nobody's online" depend on
   a device being online. Still an open product question.

### Done: PDFs

Import a PDF into a note (pages rendered by pdf.js from the vectors at the
current zoom), draw on its pages, add blank pages beside any page, run pages
vertically or horizontally, export everything back as a PDF with the original
pages untouched and the ink as vector paths. See CLAUDE.md "Pages & PDFs".

Open: file GC for unreferenced PDFs; shipping pdf.js standard fonts / CMaps
(non-embedded fonts, CJK); blank pages in notes without a PDF; moving pages;
whether "Export" should also offer the free ink beside pages.

### Done: desktop navigation, brushes

Hand tool / Space / middle-drag to pan, wheel scrolls and Ctrl+wheel zooms,
optional page snapping (direction-aware, animated). Pen, brush and marker ink
(pressure, or speed from a mouse; tapers; translucent multiplied marker),
exported faithfully. Open: per-user brush settings that persist across
sessions; more brushes (pencil texture, dashed). (Keyboard shortcuts: done.)

### Done: design pass

"Paper & ink" look (warm paper, ink chrome, lime accent; serif / grotesk / mono),
full-bleed canvas with floating chrome that steps back while drawing, panels for
rarely used actions, keyboard shortcuts for tools, and a focus mode for watching
devices that can follow the whole note or one device's view. Open: remembering
brush settings per device; a dark variant of the chrome for dim rooms; letting
the owner make everyone *follow* (not just a one-shot pull).

### Other candidates

- ~~**Live in-progress strokes.**~~ — done, over awareness after all: each
  update carries only the points since the last one (`LiveChunk`, every 30 ms),
  so the whole-state nature doesn't make it grow; ~5 KB/s while drawing with a
  mouse, more with a 240 Hz pen. Possible follow-up: send the chunks over the
  direct link too (lower latency; awareness stays the fallback).
- **Presence over the direct link** — cursors still take the server round trip.
- **Stronger passcodes.** Weak ones are refused and joins have a per-name
  budget (20 failures/hour), but a 4-digit PIN still falls to patient guessing
  (~480 tries/day). Raising the minimum is a UX call.
- **Off-machine backups.** The daily tarballs (`deploy/backup.sh`) stay on the VPS.

### Later: sharing without internet

Wanted: laptop and tablet keep sharing a note where there's no internet (a
lecture hall, a train). Today every device needs the note server: it mints
tokens, introduces devices for the direct links, and relays.

**Bluetooth — not possible from the web app.** Web Bluetooth can only talk *to*
accessories (heart-rate straps, printers); a browser can't act as one, so two
browsers can't connect to each other over it. Safari (iPad, iPhone) has no Web
Bluetooth at all. It would take a native app: the Android APK is a Trusted Web
Activity (Chrome showing the site), which can't reach Bluetooth either, so it
would mean a WebView shell (e.g. Capacitor) with a Bluetooth plugin carrying
Yjs updates — and iPads would still need their own native app. Large; parked
unless the hotspot route below falls short.

**Same Wi-Fi or phone hotspot, introduced by QR code — feasible.** WebRTC
works between devices on one local network without internet; what's missing
is the introduction the server does today. Sketch:

1. The device that has the note (it's local already, y-indexeddb) offers it:
   it becomes the hub and shows a QR code holding its WebRTC offer (SDP,
   compressed — a few hundred bytes) plus a one-time secret and the role it
   grants (edit / watch).
2. The joining device scans it and shows its answer as a QR code; the hub
   scans that back (two scans — or one, if the joiner's answer can travel
   another way). The data channel opens; from there it's today's `p2p.ts`
   protocol and the same star (the hub drops observers' writes).
3. When internet returns, the server relay reconnects and Yjs merges whatever
   was drawn offline, as it already does after a dropped connection.

Open questions: roles without the server — the hub decides from the QR secret,
so whoever scans the code gets that role; joining a note the device has never
opened (it needs the note's PDFs too, sent over the channel); Chrome hides
local addresses behind mDNS names, which some hotspots don't resolve; some
Android hotspots isolate their clients from each other; QR scanning needs
camera permission (and a fallback: copy/paste the code).

## Earlier: the P2P broadcast path (v1, removed — superseded by direct links)

Broadcast/join over a WebRTC **star** was built and verified end-to-end
(`signal-server.js`, `webrtcStar.ts`, `broadcast.ts`; see git history at
149dff3). Its design carried over into `p2p.ts`. The reasoning is worth keeping:

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
  the central server cannot mint editors. (Moot now: the note server mints the
  tokens anyway, so it is trusted to tell the hub each device's role.)
- **NAT traversal → STUN only, deliberately.** TURN would relay the stroke data,
  which is the thing this design exists to avoid. Hard-NAT pairs should fall back
  to the central Yjs relay instead.

What v1 left open, and where it stands:

- **Broadcaster is a single point** → solved: the hub hands over to the next
  editor, and the relay carries strokes meanwhile.
- **Relay fallback is not automatic** → solved: the relay is always connected.
- **Signaling unauthenticated** → solved: matchmaking needs a note token.

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
- ~~**Live presence**~~ — done: others' cursors and visible areas, toggle
  *Others*.
- ~~**Zoom-aware smoothing**~~ — done: strokes remember the zoom they were
  drawn at and are smoothed in those screen pixels, so detail drawn zoomed
  in survives.
- ~~**Laser pointer**~~ — done: editors point with a fading trail everyone
  sees; presence only, nothing stored.
- ~~**Bring everyone here**~~ — done: the owner pulls every other device onto
  their view (one-shot; the relay only lets the owner's connection send it).
  Possible follow-up: a sticky *Lead* mode where the others keep following
  until they move by hand.
- ~~**Stroke polish**~~ — done: render-time curve smoothing; *Fit* and *Follow*
  (keep the whole drawing framed — the laptop-in-a-call view).
- ~~**Real PWA icons**~~ — done: `static/icons/icon.svg` + rendered PNGs.
- ~~**Backups**~~ — done: daily tarballs of `/var/lib/conote`, 14 kept.

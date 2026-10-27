# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A tablet-installable (PWA) web notes app for pen drawing where **each open session
has its own independent zoom and scroll** while sharing the same note content.
The driving use case: mirror a laptop (full-page view) in a Zoom call while
drawing live on a tablet (zoomed-in) with a stylus — see `README.md`.

## Current state

Working app, hosted at **https://conote.sniggles.de**: pressure pen drawing
(smoothed) on white paper, **PDF import** (pages rendered from the PDF's vectors,
ink on top, blank pages added beside any page, pages running vertically or
horizontally) and **PDF export** (original pages + ink as vector paths), eraser, undo/redo, per-session pan/zoom with *Fit* and *Follow*
(keep the whole drawing framed), PWA install, and **server-hosted notes with
passcodes**. The start screen offers *Join* (note name + passcode) and *Create*
(name, editor passcode, observer setting). The passcode entered decides the role
(editor / observer); the server enforces it. Notes and their drawings persist on
the server, and many notes run in parallel. Devices on a note also link up
**directly over WebRTC** (a star around one editor, introduced by the server)
alongside the relay, and show each other's **cursor and visible area**; the
owner can **bring everyone to their view**; editors have a **laser pointer**,
and everyone sees strokes **while they're being drawn**. There are **text
boxes**, **saved inks** (brush + colour + size, one tap away), a **lasso**
(move, copy, cut, paste, delete), optional **dots on pages**, in PDFs a
**preview of where a link leads** (a citation's reference entry) on hover,
a **page picker** for long PDFs (a chapter from the outline, or a range),
**renaming** notes, **private notes** (no passcode: only the owner's
account opens them — the default when signed in), **folders** for the
start page's list (kept in the account), **dropping a PDF** onto a note,
**shapes** (rectangle, ellipse, line, arrow, and **covers** that a tap lifts
for everyone), and **presenting** (pages one at a time, full screen, the
owner's slides bringing everyone along).
The UI is a
"paper & ink" design (see *Design & chrome*): a full-bleed canvas with floating
toolbars that step back while the pen is down, and a **focus mode** for devices
that watch — chrome hidden, ink off, the view following the whole note or a
chosen device.

- **Verified:** `npm run check`, `npm run build`; server tests over the real
  protocol (create/join/roles, observer writes dropped by the relay, forged
  token refused, passcode change revokes only that role, persistence across a
  server restart, delete, weak passcodes refused, per-name join budget answers
  the same for unknown names); a headless-Chrome pass (23 checks) through a
  production-shaped Caddy + bundled server: create → draw → join by link as
  observer and editor → live sync → owner changes passcodes (others locked out
  and re-enter, owner keeps going) → drawing served with nobody else online →
  delete; a pull pass (20 checks): the owner's *Bring all here* moves a
  same-size editor to exactly the owner's view and fits a smaller observer
  around it, with a notice; a pull waits for pen-up; an editor's forged pull
  (raw socket, own token, with and without a bad owner proof) is stripped by
  the relay while the real proof works; a late joiner isn't pulled; an owner
  device without a proof fetches one; a laser pass (14 checks): the trail
  shows on every device in the same place, even with *Others* off, fades
  (only the head dot stays while held still, nothing after release), stores
  nothing, and an observer's forged laser is stripped while an editor's
  shows; a live-stroke pass (16 checks): editor and observer see a stroke
  mid-draw reaching the pen, matching the drawer's own pixel for pixel, before
  it's committed; it gives way to the real stroke with nothing left over,
  also on a PDF page; ~5 KB/s upload while drawing, 0 idle; an observer's
  forged live stroke is stripped, an editor's shows, and a preview whose
  stroke never comes goes after the linger time; a zoomed-ink pass (8 checks):
  at ~750% a small end hook keeps its corner (blank with the old smoothing —
  the test fails with the fix switched off), on the drawer's screen, in the
  live preview, on another device, and through export; and a second pass (23 checks) for this round: ink lands under the
  pointer, Fit/Follow frame the drawing, presence overlay on/off, direct link
  comes up with the first editor as hub, strokes cross it both ways **with the
  relay frozen**, a hostile observer's hand-crafted update on its data channel
  is dropped by the hub while the same from an editor lands and fans out, hub
  handover when the hub leaves, and a passcode change cuts the observer's
  direct link. PDF round (16 + 1 checks, plus curl): import renders pages,
  ink on a page, added page lands beside it / below it after a layout switch,
  ink moves with its page, observer sees PDF + ink and gets no page buttons,
  undo/redo of an added page, export downloads; a **round trip** (export →
  import into a fresh note) puts every mark in the same place on all pages,
  a `/Rotate 90` page included; free-ink-only export; file API: observer
  upload / no token / other note's token / non-PDF / >50 MB refused, passcode
  change cuts file access, deleting the note removes its files.
  Fingers round (16 checks, at 390 and 360px, touch/pen over CDP): the
  phone's tools are a bottom dock inside the screen with the zoom bar clear
  above it; one finger draws, two zoom and the pinch leaves no stroke; a late
  second finger is ignored; hand tool pans without ink; a finger erases; the
  colour panel opens above the dock; a tablet's finger draws until a pen shows
  up, then pans (with a notice), and that survives a reload.
  Steadiness round (10 checks, real touch/pen input over CDP): a finger pans,
  but not during a stroke; wheel, Ctrl+wheel and pinch don't move the view
  mid-stroke; a touch while the pen hovers or with a palm-sized contact is
  ignored, a finger pans again after the grace time; a palm that landed before
  the pen stops counting; the canvas context menu is blocked; following glides
  over several frames.
  Pen-button round (11 checks, pen over CDP): the ⋯ menu offers Eraser
  (default) / Marker / Laser / Hand / Nothing; a barrel-held stroke erases,
  draws a marker stroke in the marker's colour, leaves only a fading laser,
  pans, or does nothing, while the selected tool stays the pen and a plain
  stroke draws again; the eraser end (button 5) erases; the choice survives a
  reload.
  Names round (10 checks): both forms have an optional *Your name*; the
  owner's people list, canvas cursor tag (only with others shown) and the
  observer's focus chip and pulled notice use the names; remembered per
  device; without one, `Role · device` as before.
  Pull-glide round (14 checks, two editors; the glide itself since replaced by the arc, see Notes round): the owner's corner has *Bring
  everyone here* before focus (disabled alone, absent for other editors); a
  far, zoomed-in editor zooms out (195% → 20%) and back in to exactly the
  owner's view (pixel-identical), zoom only falling then rising, ~1.6 s; from
  inside the target it only zooms out; a half-screen hop dips to 80%; the
  zoom runs at ~90% of its peak speed near the start and end and ~40% around
  the turn (never stopping). The
  path's math (endpoints exact, edges monotonic, shape kept) checked
  separately.
  Zotero round (15 checks, fake Zotero API + file storage + WebDAV): signed
  out, the panel asks for an account; an API key lists the library, search
  narrows it; a paper's PDF imports; saving creates "A Paper (conote)" under
  it with the ink data, saving again replaces that file; another account's
  device opens it with the ink as strokes, erases one, saves — still one
  attachment; WebDAV: a wrong password says so; the paper comes out of its
  zip; saving puts `.zip` + `.prop` on WebDAV, item md5/mtime match the
  .prop, nothing in Zotero storage. Plus the WebDAV address guard refusing
  loopback, private, link-local, metadata, v4-mapped/NAT64 and decimal-IP
  forms before connecting, and pre-account notes loading as kept.
  Editable-PDF round (10 + 1 checks): a PDF with an added page beside page
  1, pen and marker ink on both → export has the attachment, the layer, one
  marked ink stream per inked page; imported into a new note: same pages
  laid out the same, the canvas pixel-identical to the original; *Clear all
  ink* leaves bare pages identical to before inking (the drawn copy is
  hidden), undo restores; edited and exported again: still one ink stream per
  page; a third note importing that matches pixel for pixel; a plain PDF
  imports as before; pdf.js with default settings (any viewer) shows the ink.
  Update round (11 checks, two real builds served like Caddy): the version
  from before this mechanism picks up the new one by itself and runs it; a
  returning visitor's page finds a new deploy, the worker takes over but
  the page doesn't reload while the pen is down, reloads once idle, back in
  the same note at the same zoom and tool, on the new build; a half-typed
  passcode on the start page holds it back until emptied.
  Accounts round (21 checks, grace cut to 6 s): signed out, the New note
  form warns and the note shows *unsaved*; a signed-in editor joining it
  doesn't save it — it survives inside the grace time and is gone after
  (join fails, the creator's device shows *ended* with its last copy); a note
  created signed in survives everyone leaving; another device signing in to
  the joining account lists it and opens it without a passcode; the owner's
  second device lists it as Owner and changes passcodes without the key; that
  locks the other account's grant until the new passcode; *Keep in my
  account* from inside an anonymous note (new account) keeps it past the
  grace time; signing out removes the account's notes from the device; wrong
  password, weak password, taken name refused.
  Bars round (28 + 10 checks): defaults leave the bottom-right quarter
  empty; the title tucks into a quarter circle at the corner with the live
  dot, the tools into a left-edge tab, both survive a reload and come back on
  tap; customising makes buttons inert, moves the zoom bar to the bottom
  left, joins it into the tools' capsule (standing up) and reorders inside
  it, refuses the title on a side, cancels in the middle, keeps a top-centre
  capsule centred to the pixel; Esc, persistence, Reset; menus and the colour
  panel open next to their (moved) buttons; bars still fade while drawing;
  at 390/360/320px the dock and rows fit, the zoom bar wraps above the dock,
  the colour panel opens above it; observers get no tools capsule; focus,
  Look only, tool keys and undo still work; a title joined top right tucks
  into the top-right quarter; a bad stored layout falls back to defaults.
  Design round (21 checks, headless Chrome): chrome fades to 10% and lets the
  pen through mid-stroke and returns after; tool keys, Ctrl+Z / Ctrl+Shift+Z;
  colour pick reaches the pen; a tap outside closes panels; an observer opens
  in focus following the whole note; the focus bar hides when idle and returns
  on movement; following the owner tracks its zoom; F / Esc in and out of focus;
  returning home lists the notes; at 360px the top bar's two halves don't overlap.
  Todo round (≈40 checks + the earlier bars/Zotero/round-trip/regress suites
  re-run green): hand tool + wheel zooms, pen + wheel scrolls; saved inks
  save/apply/forget, show on the rail, survive a reload; the start page's
  Account tab connects Zotero; the vault on the server is opaque; a second
  device signing in has the connection, a disconnect there reaches the first,
  an older session unlocks with its password (wrong one refused), signing out
  drops the key; text: tap places an editor, Esc stores, tap edits, undo
  restores the old text, the eraser takes it, export carries it in
  conote.json and reimports to the same place pixel-identical (not drawn
  twice), pdf.js shows it where the canvas did; 10 tools fit the phone dock
  at 320/360/390px; a citation link (synthetic PDF) previews just its entry,
  cropped to its column, on hover and on a hand-tool tap, gone on moving off.
  Lasso round (25 + 5 checks, mouse and touch): a drag on the canvas with
  the ⋯ menu open only closes it (no stroke; also with a finger on a
  phone), the next one draws; S picks the lasso; a loop takes the stroke
  inside it and not the one outside; dragging the selection moves it, one
  undo puts it back; Ctrl+C, a tap elsewhere offers Paste, which puts the
  copy there; Delete, Ctrl+V under the pointer, undo; a text box moves, cuts
  and pastes; another tool drops the selection; `place()` puts items onto
  the page under their start, page-local, with new ids; *Dots on pages*
  draws the grid on the pages and is remembered; 11 tools fit the phone
  dock at 320/360/390px. Regress, text, text round trip, bars, presets,
  round trip and cite suites re-run green.
  Notes round (31 API + 28 browser checks): signed in, *Only my account*
  creates a private note (no passcodes); its account opens it by name with
  no passcode, another account / signed out / any passcode can't, and an
  empty passcode answers as slowly for unknown names; a note B joined once
  opens by name without one; making it private locks B's grant and the old
  passcode, a new editor passcode opens it again; rename: normalised, the
  doc on a live socket gets the name, old name stops joining and is free
  again, taken / bad / non-owner refused, works with the owner key; a
  device signing in brings its notes into the account (one it created
  becomes the account's and kept; forged tokens and wrong owner keys only
  ignored / granted); both devices of an account list each other's notes,
  a note deleted on one leaves the other's list; the other device on the
  note sees the new title; a 40-page PDF with an outline asks which pages
  (chapters with their spans, typed ranges, Cancel), imports just those
  (keeping their page index), a short one comes straight in, one undo
  step each. Pen button (6 checks, pen over CDP): the barrel erases when
  reported at touch-down, only while hovering just before, or only after
  touching (no stroke left); a plain pen still draws; the menu shows the
  last pen touch. Pull arc (6 checks, two editors, the far device's
  transform every frame): log zoom fits a downward parabola in time
  (worst miss ~1.4% of its range), out and back in; position 4% of the way
  in the first + last 15% of the time, 60% in the middle 30%; ends exactly
  on the owner's view; a target inside the view only zooms in.
  Accounts and the earlier suites re-run green.
  Shapes & presenting round (40 + 13 checks, plus lasso, text, textrt,
  roundtrip, phone, bars, presets, regress re-run green): signed in, New
  note defaults to *Only my account* (no passcode fields); a note filed
  into a folder shows a chip, the account keeps it, a note made while a
  folder shows goes into it, another device signing in has the folders,
  *No folder* takes it out; the hand tool's wheel scrolls (Ctrl+wheel
  zooms); a PDF dragged over the note shows the drop hint and dropping it
  imports; a text tap held and dragged places the box where it's dropped,
  the editor's grip moves it while the typing goes on; R picks shapes, the
  panel offers five kinds; a cover hides the page, a tap lifts it and puts
  it back, undo lifts it again; Shift holds an arrow straight; the eraser
  and the lasso take shapes; F5 presents (bars gone, dark desk, 1/n, → and
  Page Up turn pages, Esc ends); the owner's slides bring another device
  along (and stop when *Everyone follows* is off); a pen tap on a cover
  while presenting lifts it with no dot left and no live preview reaching
  the other device; the pen draws while presenting; an exported PDF
  reopens with its shapes (a lifted cover still lifted) and ink.
- **Not yet verified on real hardware:** on-device stylus feel and the Android
  install path over HTTPS.
- **Next:** see `ROADMAP.md`. Direct links run *alongside* the relay; the relay
  still carries (and stores) every stroke, so server traffic isn't reduced yet.

## Stack

- **SvelteKit 2 + Svelte 5 (runes)**, TypeScript, Vite 5.
- **SPA** via `@sveltejs/adapter-static` with `fallback: 'index.html'` and
  `ssr = false` / `prerender = false` (`src/routes/+layout.ts`). No server — it
  hosts as plain static files.
- **Fonts** self-hosted from `@fontsource` (imported in `+layout.svelte`, so
  they're in the PWA precache and work offline): Instrument Serif, Bricolage
  Grotesque (variable, with optical size), DM Mono.
- **PWA** via `@vite-pwa/sveltekit` (`generateSW`). The manifest link is
  injected client-side in `src/routes/+layout.svelte` (`virtual:pwa-info`);
  the service worker is registered by `src/lib/appUpdate.svelte.ts`
  (`injectRegister: false`), which keeps installed apps current:
  - The worker takes over as soon as a new one installs (`skipWaiting` +
    `clientsClaim`, set by hand in `vite.config.ts` — the plugin only adds
    them when it injects the registration). Versions from before this
    module reload on takeover by themselves, so they move over unattended.
  - It checks for a new version every 2 min while visible, and on
    return to the front / focus / online (≥ 20 s apart) — iOS home-screen
    apps otherwise only look at launch.
  - After a takeover (`controllerchange` once a worker already served the
    page), the page reloads **at a quiet moment**: nothing touched for 4 s
    (or the app hidden), nothing focused for typing, and no `block()`er
    active (NoteView: stroke/laser, PDF/Zotero work, open settings, sign-in
    or Zotero panel, customising bars; Home: a half-filled form). A notice
    shows for 1.2 s first; touching anything postpones it.
  - `beforeReload()` lets NoteView stash note id, zoom/offset, focus, follow
    (the whole note only) and tool in sessionStorage `conote:resume`
    (honoured for 2 min), so the reload lands where you were.
  - The page keeps running old code until then, and old hashed bundles
    stay on the server 30 days (`publish-web.sh` doesn't delete
    `_app/immutable/`), so a lazy load (pdf.js, export) never 404s.
  `__BUILD_ID__` (build time, UTC) shows in the ⋯ menu and the start page.
- **Sync**: Yjs CRDT — `yjs` + `y-indexeddb` (local-first) + `y-websocket`
  (client) against `server/sync-server.js` (relay + note registry API). `ws`,
  `y-protocols` and `lib0` are server-side imports (never bundled into the client).

Note: the `sv` / `create-svelte` CLI needs Node ≥20.12; this repo was scaffolded
by hand and runs on the local Node 20.2. Keep Vite pinned to ^5 (Vite 7 wants
Node ≥20.19).

## Commands

- `npm run dev` — dev server (`host: true`, so a tablet on the same LAN can reach it).
- `npm run sync` — note server (API + Yjs relay + P2P matchmaking) on port
  **5182** (`SYNC_PORT`). Required: notes can't be created or joined without it.
  Data goes to `./data` (`CONOTE_DATA` to override; gitignored).
- `npm run build` — production build to `build/`.
- `npm run preview` — serve the built SPA locally.
- `npm run check` — `svelte-kit sync` + `svelte-check` (type check). Run this
  after changes; there is no separate lint/test setup yet.
- Icons: `static/icons/icon.svg` is the source artwork (in the app's palette); the PNGs (and
  `static/favicon.png`) are rendered from it with headless Chrome. The maskable
  one drops the corner radius and scales `#art` by 0.78 into the safe zone.

### Production (`deploy/`) — https://conote.sniggles.de

Runs on the VPS behind the existing Caddy, following the same pattern as the
other `*.sniggles.de` apps. Caddy serves `build/` from `/srv/conote-web` and
proxies `/sync/*` (relay and `/sync/signal/*` matchmaking) and `/api/*` to the
note server on 127.0.0.1:5182, run as systemd unit `conote-sync` (user `conote`)
from an esbuild bundle in `/opt/conote` (no node_modules there). Registry, token
secret and drawings live in `/var/lib/conote` (systemd `StateDirectory`);
`conote-backup.timer` tars them daily into `/var/backups/conote` (newest 14
kept; restore steps in `deploy/backup.sh`). The old open matchmaking service
`conote-signal` (:5183) is retired by `update-server.sh` if still installed.

- `bash deploy/deploy.sh` — both of the below in one go, server first
  (asks for sudo), then checks the live server answers as the new one.
- `sudo bash deploy/setup-server.sh` — first install, and again whenever
  `deploy/Caddyfile` changes. Re-runnable: it replaces its own Caddy block
  (backup first, restored if Caddy rejects it), then runs the two below.
- `bash deploy/publish-web.sh` — after client changes (no sudo). Keeps old
  `_app/immutable/` bundles for 30 days (see PWA under Stack).
- `sudo bash deploy/update-server.sh` — after changes in `server/` or the
  units / `backup.sh` in `deploy/`.

### Android APK (`android/`, `.github/workflows/build.yml`)

A **Trusted Web Activity** generated with Bubblewrap (`@bubblewrap/core`,
config in `android/twa-manifest.json`): a thin shell that opens
https://conote.sniggles.de in Chrome without browser UI. It contains no copy of
the app, so `publish-web.sh` updates it too; rebuild only for name, icon or
colour changes (edit `android/app/build.gradle` / regenerate). CI builds it on
every push to `main` (artifact `conote-apk`; tags `v*` attach it to a release),
next to a `npm run check` + `npm run build` job. `versionCode` = the CI run
number, so each build installs over the previous one.

- **Signing key is not in the repo** (it's public): repo secrets
  `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` (PKCS#12, alias
  `conote`; the original lives in `~/.conote-android/` on the VPS). Its SHA-256
  is in `static/.well-known/assetlinks.json` — that match is what hides the URL
  bar. Without the secrets CI signs with a throwaway key (works, but URL bar).
  Changing the key means updating `assetlinks.json` and reinstalling.

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
   independent. (The owner's one-shot *Bring all here* sends a world rect that
   each device *chooses* to glide to — see Pulls; and *following* a device
   reads its presence `view` and glides after it — see Focus. Neither shares
   viewports: the other side never sets ours.)
2. **`noteStore` holds only shared content** (the strokes), and it is the Yjs
   doc. Anything drawn goes into world coordinates via `viewport.toWorld(...)`.
   Sync replicates `noteStore`, **never** the viewport — that's what keeps each
   device's zoom/scroll independent while the strokes converge.

### Key files

- `src/lib/notes/model.ts` — `Stroke`/`StrokePoint` types; all geometry in
  world coords, `pressure` in [0,1]. There is no `Note` type: a note's strokes are
  the Yjs array in `noteStore`, its name/id/token are a `NoteEntry` in `noteIndex`.
- `src/lib/notes/api.ts` — HTTP calls to the note server: `createNote`,
  `joinNote`, owner `updateSettings`/`deleteNote`/`ownerSession`.
- `src/lib/notes/noteIndex.svelte.ts` — "My notes": the notes **this device**
  created or joined, with their tokens (localStorage, not synced — see below).
- `src/lib/notes/viewport.svelte.ts` — the per-session transform (`toWorld`,
  `toScreen`, `panBy`, `zoomAt`, `reset`, `fit(box, w, h)`, `visible(w, h)`).
  Runes class.
- `src/lib/notes/noteStore.svelte.ts` — the Yjs-backed shared note (see "Sync"
  below). Public API the UI depends on: `connect(id, { token, label })`/`disconnect()`,
  `renewToken(token)`, `access` (`'ok' | 'revoked' | 'gone'`),
  `strokes` (plain cached array — read together with the reactive `revision`
  counter), `strokeCount`, `texts`/`textCount`, `shapes`/`shapeCount`, `addStroke`, `setText`,
  `addShape`, `setShape(oldId, shape)` (a cover lifted / put back), `removeStrokes(ids)` (strokes, texts and shapes),
  `replaceItems(remove, strokes, texts, shapes)` (one undo step: lasso move / cut / paste), `beginChange`,
  `clear`, `undo`/`redo`, `canUndo`/`canRedo`, `status`/`peers`/`direct`/`hub`
  for the sync indicator, `presence` (others) / `setPresence()` (us), and
  `pullEveryone()` / `pulled` (the owner's pulls).
  Module-level: `roomFor(id)`, `destroyNoteData(id)`.
- `src/lib/notes/p2p.ts` — `P2PLinks`: the direct WebRTC links for one open note.
- `src/lib/notes/pages.ts` — `layoutPages` (page list → world positions),
  `pageAt`, `contentBounds`, `PAGE_GAP`.
- `src/lib/notes/ink.ts` — stroke geometry (`inkShape`), brush presets
  (`BRUSHES`, `MARKER_ALPHA`); shared by the canvas and the PDF export so both
  draw the same ink.
- `src/lib/notes/pdf.ts` — pdf.js (lazy-loaded): `readPdfPages` for import,
  `PageRenderer` for drawing pages at the current zoom.
- `src/lib/notes/exportPdf.ts` — pdf-lib (lazy-loaded): pages + ink → PDF.
- `src/lib/notes/files.ts` — this device's IndexedDB cache of imported PDFs.
- `src/lib/notes/text.ts` — text box geometry (font, line height, baseline,
  measured widths, bounds), shared by canvas, eraser, Fit and export.
- `src/lib/notes/vault.ts` — sealing the account's vault (PBKDF2 → AES-GCM).
- `src/lib/notes/selection.ts` — the lasso: what a loop takes, moving /
  placing items (re-homed onto pages), the per-device clipboard.
- `src/lib/notes/shapes.ts` — shape geometry (box, bounds, hit test, arrow
  head, ellipse curves, Shift-constrain), shared by canvas, eraser, lasso,
  Fit and export.
- `src/lib/components/ZoteroConnect.svelte` — the Zotero key / storage form
  (note panel and the start page's Account tab).
- `src/lib/components/DrawingCanvas.svelte` — the canvas + all input. See below.
- `src/lib/components/Icon.svelte` — the inline SVG icon set (mostly Lucide).
- `src/app.css` — design tokens (colours, fonts, shadows) and the few shared
  classes (`.kicker`, `.field`, `.input`, `.btn`, `.seg`).
- `src/routes/+page.svelte` — router only: `?note=<id>` → `NoteView`, else `Home`
  (`?join=<name>` prefills the join form; that's the share link).
- `src/lib/components/Home.svelte` — start screen: Join, Create, My notes (in
  place of the illustration once this device has notes), its folders.
- `src/lib/components/NoteView.svelte` — floating chrome + canvas for one note;
  owns the session `Viewport`, tools/inks, draw/observe mode, follow and focus
  mode, keyboard shortcuts, the panels (people, share, more, ink) and notices.
- `src/lib/components/NoteSettings.svelte` — owner dialog: name, passcodes
  (or private), observer access, delete.
- `src/lib/components/PagePicker.svelte` — which pages of a long PDF to import.
- `server/sync-server.js` — HTTP API (`/api/*`) + authenticated Yjs relay +
  authenticated P2P matchmaking (`/signal/<id>`).
- `server/registry.js` — notes, hashed passcodes, tokens, on-disk storage
  (docs and imported files).

### Notes, passcodes and roles (`server/registry.js` + `noteIndex.svelte.ts`)

- **A note is found by name, entered with a passcode.** The creator picks a unique
  name (normalised: `"Math Class"` → `math-class`), an editor passcode, and
  observer access: `passcode` (separate observer passcode), `open` (anyone with
  the name watches, empty passcode) or `none`. The passcode entered decides the
  role; editor and observer passcodes must differ.
- **The server enforces roles, the client only mirrors them.** `POST /api/join`
  trades name + passcode for a token `<id>.<role>.<epoch>.<hmac>`; the WebSocket
  presents it as `?token=`. An observer connection may send SyncStep1 (asking for
  state) but its SyncStep2/Update messages are dropped in the relay. Hiding the
  pen in `NoteView` is UI only.
- **Revocation by epoch.** Each note has an epoch per role inside its tokens.
  Changing a passcode bumps that role's epoch and closes those sockets with
  **4401**; deleting closes with **4404**. The client sets `noteStore.access`,
  stops reconnecting, and `NoteView` asks for the new passcode (the owner device
  re-authenticates by itself with its owner key).
- **Unknown name and wrong passcode give the same 403**, at the same speed, so
  the join endpoint can't be used to list names. Create still reveals that a
  name is taken (409). Per-IP rate limits apply to join/create/owner calls, plus
  a per-name budget on join (20 failures/hour across all IPs, keyed by the typed
  name whether or not it exists, so the 429 reveals nothing). Trade-off: someone
  can keep a known name's *new* joins locked; token holders and the owner are
  unaffected.
- `passcodeError` refuses common passcodes, runs/repeats (`1234`, `aaaa`, `dcba`)
  and the note's own name. Minimum length is still 4.
- **Private notes** (`note.edit === null`, `session.private`): created
  signed in with *Only my account* (the form's default when signed in),
  no passcodes (observers `none`). Only
  the account the note belongs to opens it — from its list, or by name with
  an empty passcode. The owner can give it an editor passcode later
  (settings), or make an account-owned note private again (`private: true`
  in `/api/owner/settings`: editor epoch bumps, other accounts' edit grants
  lock).
- **Joining by name without a passcode** works for any note the signed-in
  account already holds (`join`: owner account, or a grant at the current
  epoch). An empty passcode otherwise answers like a wrong one, as slowly.
- **Renaming** (`/api/owner/rename`, owner): normalised and unique like
  create; the old name is freed. The server also writes the name into the
  doc's `meta.name` (`stampName`: the live room, or the stored doc), so
  devices on the note — and anyone opening it later — update their list
  entry (`noteStore.name` → `noteIndex.rename`). Display only: an editor
  could write `meta.name` too, but joining always goes by the registry.
- The **owner key** is returned only once, at creation, and lives only in the
  creating device's `noteIndex` entry. It is the only way to change settings or
  delete. Forgetting the note on that device loses it (the UI warns).
- Owner sessions (create, `/api/owner/*`) also carry an **owner proof**
  (`sign("<id>.owner")`, `verifyOwnerProof`), kept as `NoteEntry.ownerProof`;
  owner devices from before it fetch one with the key on open. The relay socket
  takes it as `&owner=` next to the token (see Presence → pulls).
- `noteIndex` (localStorage `conote:notes`) is this device's keyring: tokens, not
  passcodes. Without an account it is not synced; another device joins with
  the passcode.

### Accounts and what is kept (`registry.js`, `account.svelte.ts`)

- **Optional, name + password only** (`accounts.json`: scrypt hash, and per
  note the *grant*: role + that role's epoch). Session token
  `a.<key>.<epoch>.<sig>`, stateless like note tokens, sent as
  `Authorization: Bearer` on every API call (`setAccountSession` in `api.ts`);
  routes get `(body, account)`. Register/login have their own per-IP and
  per-name budgets; wrong name and wrong password answer alike.
- **Accounts decide what is kept.** `note.keep`: `'account'` (created while
  signed in, or claimed — kept until deleted), `'none'` (created signed out:
  **ephemeral**), `'legacy'` (from before accounts: kept, until its owner
  claims it). An ephemeral note is deleted by the sweep in `sync-server.js`
  once its relay room has been empty for `ENDED_GRACE_MS` (2 min;
  `CONOTE_ENDED_GRACE_MS` for tests) — whoever else joined, signed in or not.
  The grace covers reloads, network blips and server restarts (`lastSeen`
  starts at create / server start). Ended ids are remembered for a month, so
  a returning device gets close code **4410** → `access = 'ended'` ("ended
  when everyone left", last local copy, Export / Forget) instead of 4404.
- **Grants follow the account.** Create/join while signed in records the
  grant; `/api/account/notes` returns every grant with a fresh token (owner
  sessions with `owned: true` + proof for the account's own notes), so any
  device that signs in has them, no passcodes. A grant whose role's epoch
  moved on (passcode changed) comes back `locked`, without a token: opening it
  gets 4401 and the usual rejoin prompt, and rejoining signed in renews it.
  The owner's account is never locked out.
- **Owner rights** = the owner key on this device *or* `note.account` = the
  signed-in account (`asOwner`); `isOwner(entry)` on the client. *Keep in my
  account* (⋯ menu, owner only, signs in / registers inline) is
  `/api/account/claim`: ephemeral or legacy → `'account'`.
- **The device's list is the account's** (`account.sync()`, on Home: on
  arrival, on focus / coming back, and every minute while visible). It
  first pushes the entries this device has without an account
  (`/api/account/add`: their tokens; with a matching owner key, a note no
  account owns becomes this one's — kept), then pulls every grant, and
  drops entries from this account that it no longer lists (deleted, or
  forgotten on another device) — except unsaved ones that ended, whose last
  copy is only here, and the note that's open.
- **Folders** are labels on the account's notes (`grant.folder`,
  `/api/account/folder`, returned by `/api/account/notes`; `grant()` keeps
  it when a grant is renewed), so every device of the account files a note
  the same way. Without an account, or for notes not in it, the folder is
  only this device's (`NoteEntry.folder`); signing in pushes it along with
  the note (`/api/account/add`, unless the account already filed it). No
  folder exists empty. Home shows chips over the list (the picked one
  remembered per device, `conote:folder`) and a strip under a note to file
  it; a note made or joined while a folder shows goes into it.
- **Signing out forgets the account's notes on the device** (entries with
  `via` = that account, and their local data): a borrowed laptop keeps
  nothing. Entries joined signed out stay.
- One note = one Yjs doc = one server room (the note id) = one IndexedDB
  database (`roomFor(id)`). Ids are random, so a deleted note's name can be
  reused without a stale local copy merging into the new note.
- `connect()` is the only entry point and tears down the previous note first.
  Its async callbacks (idb `synced`, ws `status`, awareness, close) all guard on
  the doc still being the open one. The close handler also ignores sockets that
  used an older token: after `renewToken()`, the old socket's late 4401 must not
  lock out the new one.

### Zotero (`server/zotero.js`, `zotero.svelte.ts`, NoteView's Zotero panel)

- **⋯ → From Zotero / Save to Zotero**, set up there or on the start page's
  Account tab. Signed-in only: the server relays
  (Zotero storage and WebDAV servers like Koofr don't allow cross-origin
  requests), so it must not be an open proxy. The device keeps the API key
  (and WebDAV URL/user/password) in localStorage `conote:zotero`; requests
  carry them in the **body** (never headers/URLs — access logs).
- **The account's vault** carries the connection to the account's other
  devices: `{ zotero, at }` sealed on the device (`vault.ts`: PBKDF2-SHA256,
  310k rounds, salt `conote vault:<account key>`, → AES-GCM) with a key
  derived from the password at sign-in and kept beside the session
  (`conote:account`.vault). The server stores the sealed string only
  (`account.vault`, `/api/account/vault[/set]`, ≤ 12 000 chars), so its disk
  and backups can't read it; it does still see keys in transit (it relays).
  `account.sync()` → `pullVault()`: the newer `at` wins (pre-vault settings
  count as `at = 1`); a local change pushes (`zotero.onchange`); a
  disconnect is pushed as `zotero: null`. Sessions from before the vault have
  no key until the password is entered once more (Account tab →
  `account.unlock`). Signing out drops a connection that came via the vault.
  Needs Web Crypto (https / localhost); elsewhere the vault is off. `/api/zotero/{verify,search,pdfs}` are JSON routes;
  `/api/zotero/file` returns the PDF; `/api/zotero/save` takes
  `[u32 length][JSON meta][PDF]`. Budget per IP and per account.
- **Files:** Zotero storage via `/items/<key>/file` (download) and the
  3-step upload (authorise with `If-None-Match: *` / `If-Match: <md5>`,
  POST prefix+file+suffix, register). WebDAV: `<url>/zotero/<KEY>.zip` (the
  PDF under its filename) + `<KEY>.prop` (`<properties version="1"><mtime>ms
  </mtime><hash>md5</hash></properties>`), and the item's `md5`/`mtime` set
  through the API (allowed for WebDAV libraries) — they must match, it's
  how Zotero desktop decides its copy is current. `davBase` appends
  `zotero/` like Zotero does, so users type what Zotero's settings show.
- **WebDAV is the one user-chosen target:** https only, no credentials in
  the URL, redirects not followed, and no private/loopback/link-local/
  v4-in-v6 address — IP literals checked up front (Node skips `lookup` for
  them), names checked in the socket's `lookup`. `CONOTE_DAV_ALLOW_PRIVATE=1`
  and `CONOTE_ZOTERO_API` exist for tests only.
- **The link:** importing from Zotero puts `meta.zotero` = `{ library,
  parent, saved, title }` in the doc (`noteStore.zotero`); a save replaces
  `saved` if it still exists, else creates `"<title> (conote)"` under
  `parent` (or top-level). Opening a conote attachment (it carries
  `conote.json`) sets `saved` to it, so a paper keeps one annotated copy
  however often it moves between devices. Its ink reopens editable (see
  *Exported PDFs reopen editable*).

### Direct links / P2P (`p2p.ts` + matchmaking in `server/sync-server.js`)

On by default; `?p2p=0` turns it off for a session. Runs **alongside** the relay,
never instead of it: Yjs dedupes whatever arrives on both paths.

- **The star IS the permission model** (carried over from the v1 broadcast).
  The hub is the longest-connected *editor*; every other device links to the hub
  and nothing else. The hub drops `UPDATE`s from observer links (`P2PLinks.#onData`,
  the `link.role !== 'edit'` check) and fans the rest out. Do not "upgrade" this
  to a mesh (e.g. `y-webrtc`) — a mesh lets peers talk directly, which makes
  read-only unenforceable without signing every update.
- **The server enforces the star.** Matchmaking (`/signal/<id>?token=`, same
  token as the relay) only forwards signals that have the hub at one end, and it
  tells the hub each device's role from the device's verified token. A device's
  own idea of its role is never consulted.
- **Revocation reaches P2P.** `closeConnections` closes matchmaking sockets too;
  the server re-announces, and the hub cuts links to anyone no longer listed.
  Any device whose matchmaking socket closes drops all its links (the server no
  longer vouches for it), then reconnects.
- **Hub handover** is automatic: when the hub's socket closes, the next editor is
  announced, and everyone re-links.
- **Update origins matter.** A non-hub device applies updates from the hub with
  the *relay provider* as origin, so y-websocket doesn't upload them again and
  `Y.UndoManager` ignores them. The hub applies a device's update with that
  `Link` as origin, so its fan-out skips the sender. Keep both.
- Data channel protocol is hand-rolled on plain `yjs` (tags `SV`/`UPDATE`) rather
  than y-protocols + simple-peer — `simple-peer` needs Node globals (`Buffer`/
  `process`) that Vite won't supply without polyfill config.
- STUN only, no TURN, on purpose: TURN would relay the stroke data. Pairs that
  can't connect directly just keep using the relay.
- Presence (awareness) still goes through the relay only.

### Pages & PDFs (`pages.ts`, `pdf.ts`, `exportPdf.ts`, `noteStore`)

- **Doc layout.** `pages` is a `Y.Array<PageEntry>` in *export order*; `meta`
  (`Y.Map`) holds `layout` (`'vertical' | 'horizontal'`, shared — it moves pages
  in the world, so presence frames only line up if everyone agrees) and
  `origin` (set at the first import so pages start beside existing ink).
  `Y.UndoManager` tracks `strokes` *and* `pages`, so import/add/delete undo.
- **`extra` is the whole "beside" model.** A page with `extra: true` is shown
  next to the page before it (right of it when vertical, below when
  horizontal) and simply follows it in the export. "+ page" inserts an extra
  right after the clicked page. Deleting a main page promotes its first extra.
- **Ink on a page is page-local** (`Stroke.page` + coordinates in PDF points
  from the page's top-left, y down) and clipped to the page. That's what lets
  the layout change without moving ink off its page, and what makes export a
  single transform per page. A stroke belongs to the page it *starts* on.
  Strokes on a deleted page stay in the doc (hidden, not erasable) for undo.
- **Never rasterise the PDF ahead of time.** `PageRenderer` renders each page
  with pdf.js at the session's current zoom × dpr — the whole page if it fits
  `FULL_PAGE_MAX_PX`, else the visible part plus a margin — and re-renders
  when the zoom settles, drawing the stale bitmap scaled meanwhile. Bitmaps
  past `TOTAL_MAX_PX` are evicted least-recently-used.
- **Export copies, doesn't re-render.** `exportPdf` copies the original pages
  (one `copyPages` per source file, so shared fonts aren't duplicated), adds
  blank pages, and pushes ink as raw PDF path operators through the inverse of
  the page's pdf.js viewport transform (`PageEntry.pdf.vt`, stored at import),
  which handles `/Rotate` and crop boxes. Quadratics are raised to cubics by
  hand: pdf-lib's `appendQuadraticCurve` emits `v`, a different curve. A note
  without pages exports its free ink on one fitted page; free ink beside pages
  isn't exported.
- **Files live on the note server**, content-addressed:
  `POST /api/files/<id>` (editors; PDF magic checked; 50 MB per file, 200 MB /
  50 files per note; per-IP upload budget) and `GET /api/files/<id>/<sha256>`
  (any role), both with `Authorization: Bearer <note token>`. Stored in
  `$CONOTE_DATA/files/<id>/`, removed with the note. Clients cache them in
  IndexedDB (`conote-files`, key `<id>/<hash>`; dropped by `destroyNoteData`),
  so PDFs open offline. `importPdf` validates with pdf.js *before* uploading.
- **Exported PDFs reopen editable** (`conoteData.ts`). The export embeds
  `conote.json` (page `extra` flags, layout, every on-page stroke, text box
  and shape page-local with its PDF page index, a lifted cover still lifted;
  a page-less note's free ink moved onto its fitted page) and draws the ink as one content stream per page marked
  `/ConoteInk true`, inside an optional-content layer *conote ink*. Importing
  such a PDF (`readPdfPages` → `readConoteData`, which validates everything —
  it's a file) adds its pages with their `extra` flags and the strokes as
  ordinary strokes, one undo step; `PageRenderer` hides that layer whenever
  it renders a page (`withoutConoteInk`), and export drops marked streams
  from copied pages before drawing the ink again — so ink is never drawn
  twice, however many round trips. Other viewers show the layer as normal.
  Keep the marker key and layer name stable: old exports depend on them.
- **Dropping a PDF** file anywhere on the note (editors) imports it like
  ⋯ → Import PDF; a dashed hint shows while a file is dragged over.
- **Long PDFs** (≥ `PICK_PAGES_FROM`, 31 pages) ask which pages to take
  (`importPdf(file, choose)` → `PagePicker`): the outline's first two levels
  as chapters (`readChapters`: each up to the next bookmark at its level or
  above), or a typed range, or all. The whole file is still uploaded; the
  chosen pages keep their `pdf.index`, so export and link previews (a
  citation pointing into the unimported references) still work. Ink from a
  conote export is taken for the chosen pages only.
- pdf.js and pdf-lib are dynamic imports; notes without PDFs never load them.
  The pdf.js worker (`.mjs`) is in the PWA precache.

### Sync (`noteStore.svelte.ts` + `server/sync-server.js`)

- Strokes live in a `Y.Array<Stroke>`. `y-indexeddb` persists the doc locally
  (offline-first, database `pennable-<noteId>`); `WebsocketProvider` relays live
  edits (room = the note id). The server writes each doc to
  `$CONOTE_DATA/docs/<id>.bin` 1s after the last edit, when the room empties, and
  on SIGTERM. Rooms load from there, so a note is complete for whoever joins
  next, even if nobody else is online.
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
- Server URLs (`syncUrl()` in noteStore, `apiBase()` in api.ts): page on a
  default port (production, behind Caddy) → same-origin `wss://<host>/sync`
  (relay at `/sync/<id>`, matchmaking at `/sync/signal/<id>`) and `/api`; page
  on an explicit port (vite :5173, preview) → the server's own port `:5182` on
  the page host. Override the WS base with `?sync=`.
- **`connect()` must set an awareness field** (`setLocalStateField('session', …)`)
  before the socket opens — don't remove it. Awareness starts at clock 0, and a
  peer that has never seen us also assumes clock 0; `applyAwarenessUpdate` only
  accepts an update when `currClock < clock`, so a clock-0 state is dropped and
  the session stays invisible until Awareness's timer renews the clock ~15s later.
  Without the field the peer count silently reads 1 for the first ~15s. Stroke
  sync is unaffected (different message type), which is what makes it easy to miss.
- **Presence** = awareness fields `label`, `cursor` (world point or null) and
  `view` (world rect this session shows). `label` is the name typed on
  joining/creating (optional, per device: `myName()` in `noteIndex`,
  localStorage `conote:name`), else `"<Role> · <device>"`; it's what cursor
  tags, view frames, the people list, focus chips and the pulled notice show. `DrawingCanvas` publishes them
  throttled (50 ms / 120 ms); `readPresence` validates other devices' states
  (they're untrusted) and picks each one's colour from its client id. Others'
  views are only *drawn* — never adopted — with two exceptions: pulls, below,
  and following a device (Focus, under *Design & chrome*), which this device
  chooses itself.
- **Pulls** (*Bring all here*, owner only): `pullEveryone(view)` puts
  `pull: {n, view}` in the owner's presence for `PULL_TTL_MS` (4s), so a
  device connecting in that window is pulled too and a later one isn't.
  Receivers act once per `(client, n)` (`#readPulls` → `noteStore.pulled`):
  `NoteView` turns *Follow* off and calls `DrawingCanvas.showView`, which
  glides to fit that rect and **waits for pen-up** if a stroke or gesture is
  under way. The glide is an **arc** (`arc`), like something thrown (the
  user asked for a parabola): the zoom — log of the view's width — is an
  exact parabola in time, out and back in, its top where the current view
  and the target are both in sight (`outerView`); the centre moves along
  the straight line between the two, its progress the running share of
  width × sin(πk), so slow at the start and end and fastest while far out.
  When the target is inside the view (or around it), the parabola's top
  lands on an end: a plain zoom, no detour. (Replaced the earlier
  "never slides" two-zoom glide with its `PULL_TURN_SPEED`.) Length from
  `PULL_MIN_MS` + `PULL_MS_PER_EFOLD` × zoom travelled, capped at
  `PULL_MAX_MS`. A far jump
  goes far out; a target inside the current view is a plain zoom. This is the one time a
  device's viewport is set from outside — a one-shot jump by the owner; the
  viewport is still never synced, and anyone can move away right after.
  **The relay enforces owner-only:** `stripFields` removes `pull` from every
  awareness update arriving on a connection without a valid owner proof, so
  any `pull` a device sees came from the owner. (Awareness doesn't travel
  over the direct links, so there's no second path to guard.)
- **Laser pointer** (tool `'laser'`, editors): while held, presence carries
  `laser: true` and the cursor goes out every `LASER_EVERY_MS` (30) instead
  of 50. Every device — the sender from its own raw samples, the others from
  that cursor stream — keeps a world-space trail per session (`trails` in
  `DrawingCanvas`) and draws it fading over `LASER_FADE_MS`, with a dot at
  the head while on. Drawn even with *Others* off; never in the doc, so no
  undo and no export. The relay strips `laser` from observers' awareness
  (`stripFields`, next to `pull`).
- **Reconnects re-announce presence** (`reannounce` on every `connected`).
  y-websocket keeps departed clients' awareness clocks when it drops their
  states on close, so the server's replay of the same states looks stale and
  is ignored; and the server, having dropped ours, ignores our replay at the
  same clock. Without the fix, presence and the peer count stay empty after a
  blip or `renewToken` until each device next changes something (~15s for a
  still one). Same trap as the clock-0 note above — keep both.

### Canvas & input conventions (`DrawingCanvas.svelte`)

- **Screen coordinates are canvas-local.** Pointer `clientX/Y` go through
  `local(e)` (minus the canvas origin, re-measured on resize, pointerdown and
  wheel) before touching the viewport. The canvas is full-bleed now (the chrome
  floats over it), so the origin is usually 0,0 — keep `local()` anyway: with
  the old toolbar above it, raw `clientX/Y` put ink a toolbar-height below the
  pen, and that bug shipped once. `width`/`height` are bound out to `NoteView`, which
  uses them for zoom buttons and Fit.
- **Input type decides intent:** pen/mouse use the **tool** (draw, erase,
  laser); two fingers always **pinch-zoom + pan**. One finger depends on the
  device (`fingerInks`, set by `NoteView`): on phones it uses the tool like a
  pen; on a tablet with a pen it **pans**. Automatic per device: fingers ink
  until the first pen event (touch or hover, `onpen`), then `conote:pen` is
  remembered and fingers navigate; *One finger* in the ⋯ menu overrides it
  (`conote:finger` = `draw` | `move`). The hand tool, observe mode and focus
  always make one finger pan. **Pen buttons** (`useFor`, decided once at
  pen-down): the eraser end (button 5 / buttons 32) always erases; a pen that
  touches down with its barrel button held (button 2, buttons 2 — Windows Ink
  and Android report it as the secondary button alone) uses the `penButton`
  prop instead of the tool: eraser, marker (in the marker's own colour and
  size), laser or hand, set in the ⋯ menu per device (localStorage
  `conote:penButton`, default eraser); *Nothing* ignores such contacts.
  Pens differ in *when* they report the barrel: with the touch-down, only
  while hovering just before (`barrelSeenAt`, `BARREL_HOVER_MS`), or a moment
  after (`lateButton`: within `BARREL_LATE_MS` the young stroke is aborted
  and restarts as the button's tool) — all count. The ⋯ menu shows the last
  pen touch's `button`/`buttons` (`onpentouch`) for diagnosing a new pen. A
  **finger stroke that a second finger joins
  within `FINGER_SETTLE_MS`** was the start of a pinch: it's aborted (never
  committed, no undo step) and both fingers zoom; its live preview is held
  back for that long, so the others never see it. Later second fingers are
  ignored (a stray finger mustn't kill a long stroke); a finger erase or
  laser always gives way to the pinch. Pen/mouse
  **pan** instead with the hand tool, Space held, the middle button, or in
  observe mode. Wheel **scrolls** (Shift: sideways; line/page `deltaMode`s
  scaled), Ctrl+wheel (= trackpad pinch) **zooms** at the cursor — whatever
  the tool (the hand tool zooming on the plain wheel was tried and reverted
  at the user's request). The wheel
  listener is bound by hand with `passive: false`: its `preventDefault()` is
  what stops Ctrl+wheel zooming the browser page. `touch-action: none` — we own
  all gestures.
- **The view holds still under a pen.** Samples become world points through
  the *current* viewport, so any move mid-stroke kinks the line. While a
  stroke, erase or laser is under way (`inking()`): wheel is ignored, new
  touches are ignored, pulls wait (`pendingView`) and following pauses
  (`stepTrack` checks `busy()`).
- **Palm rejection** (`isPalm`): a touch is ignored if it lands while inking,
  within `PEN_GRACE_MS` of the pen touching or *hovering* (S Pen hover sends
  pen moves), or with a contact patch over `PALM_PX`. A pen-down also drops
  touches already in progress (a palm that landed first). Ignored touches are
  never put in `touches`, so their moves and lift do nothing — keep the
  `if (!touches.delete(...)) return` in `onPointerUp`, or a palm's lift
  schedules a page snap. Long-press/S Pen-button context menus are blocked on
  the canvas (they can cancel the pointer).
- **Predicted points**: the live stroke is drawn with up to `MAX_PREDICTED`
  points from `getPredictedEvents()` on its tip (hides a frame or two of
  latency). They're never stored or sent, and replaced on every move. No
  `desynchronized` context: each frame re-composites from the paper up, and
  front-buffer rendering would show those half-drawn frames.
- **Following eases** (`follow(box)`, exported): the render loop moves the
  view a fraction toward the framing of the target box every frame (time
  constant `TRACK_TAU_MS`), so a stream of updates — a growing drawing,
  another device panning — reads as one smooth camera instead of jumps or
  restarting glides.
- **Page snapping** (*Snap*, per device in localStorage `conote:snap`, notes
  with pages only): after a scroll/drag/one-finger pan ends — not a zoom or
  pinch — `snapToPage` glides (`glideTo`, 260 ms ease-out, cancelled by any
  input) along the page axis to a row edge: row start at `SNAP_MARGIN` from the
  top/left, or, for a row bigger than the screen, its end at the bottom/right
  (those only within a quarter screen, so the middle of a big page stays
  readable). It continues in the **direction of travel** (`gestureFrom`) once
  the move exceeds `SNAP_INTENT` px — one wheel notch = next page; nearest
  wins for nudges. Don't make it nearest-only: then a notch always snaps back.
- **Live stroke is component-local**, not in the store. Per-point updates happen
  here (using `getCoalescedEvents()` for high-frequency pen sampling) and only the
  finished stroke is handed to `noteStore.addStroke`. This keeps drawing off the
  reactive path so it stays smooth — preserve this separation.
- **Others see it live anyway, via presence, not the doc.** `sendLive` puts a
  `live` chunk (`LiveChunk`: stroke id + look + only the points since the last
  chunk, `n` = first index) in presence every `LIVE_EVERY_MS` (30), with the
  cursor at the tip (the plain cursor publish pauses while drawing). On
  pen-up: last chunk → `addStroke` → `live: null`, in that order, so the real
  stroke lands before the preview ends. Receivers (`#readLive`, run per
  awareness message so no chunk is missed) build `liveStrokes` — ordinary
  `Stroke`s drawn with `liveInkShape` like our own, markers on the marker
  layer — and drop each when its id appears in the doc (`#pruneLive` in
  `#refresh`), or `LIVE_LINGER_MS` after it ended if it never does. A chunk
  for a stroke already in the doc is ignored (direct links can overtake the
  relay). Repeated chunks are skipped by index; a gap (joined mid-stroke)
  just joins up. Everything in a chunk is validated (untrusted), and the
  relay strips `live` from observers.
- **Rendering** is an imperative `requestAnimationFrame` loop gated by dirty
  flags, not per-point reactivity. Committed strokes are drawn into an offscreen
  `base` canvas only when `baseDirty` (revision / viewport / resize); each frame
  composites paper (warm `PAPER`) → dot grid → pages (white sheet + PDF
  bitmap) → `base` → live stroke → presence → eraser ring, so drawing on a big
  note doesn't redraw the whole note per sample. The **dot grid** is one
  pattern fill (`drawGrid`): a 64 px tile scaled to the spacing, in world space;
  the spacing halves/doubles with the zoom (screen spacing within 2–4 ×
  `GRID_UNIT`) and the finer level fades in, so it never pops. Pages stay
  white — PDFs expect it and export prints on it.
- **Page labels** (number, and for editors "+ page" / ✕) are HTML in an overlay,
  positioned from the viewport, sitting in the `PAGE_GAP` above each page; they
  hide when zoomed out too far to fit there. Scaled by
  `devicePixelRatio`; the world→device transform is `setTransform` and strokes
  are drawn in world units (so ink zooms with content).
- **Brushes** (`Stroke.brush`: `pen` | `brush` | `marker`) are filled outlines
  from `perfect-freehand`: thickness follows pressure, or speed when
  `Stroke.sim` (mouse — no pressure); `brush` adds long tapers; `marker` is
  wide, constant, and translucent. A stroke stores only the brush *name*, so
  **editing a preset in `BRUSHES` restyles every existing stroke of that
  kind** — and `getStroke` must stay deterministic for devices to agree.
  **Smoothing follows the zoom a stroke was drawn at** (`Stroke.z`, stamped
  by `strokeZoom(viewport.scale)` at pen-down, carried in `LiveChunk`):
  `brushShape` runs perfect-freehand in the drawer's screen pixels (points
  and width × z, outline ÷ z), so its hard-coded 3-unit end cut-off is 3 px;
  calls `getStrokePoints` / `getStrokeOutlinePoints` separately so the start
  skip (`size` in the first) caps at `START_PX`; caps outline spacing at
  `OUTLINE_PX`; and eases streamline off above 100% (`streamlineAt`: ×1/√z).
  World-unit thresholds had eaten the small details you zoom in to draw.
  Brush strokes without `z` take the exact old path. Like presets, these
  constants restyle every stroke that has `z`.
  Strokes without `brush` (drawn before brushes) keep the old look: a stroked
  centre line, smoothed through sample midpoints, cut into runs of quantised
  pressure width. Stored points are the raw samples (minus ones < 0.75 screen
  px from the previous); the eraser hit-tests the centre line.
- **Markers have their own layer** (`markers` canvas), composited with
  `multiply` at `MARKER_ALPHA` after the pages and *before* the other ink — so
  a highlighter tints paper and leaves PDF text and pen ink dark. Export does
  the same: marker strokes first, inside an ExtGState with `BM /Multiply` and
  `ca/CA = MARKER_ALPHA`.
- Each brush (and text) keeps its own colour and size in `NoteView` (`inks`,
  ranges in `INKS`); the palette and slider edit the current one, and the
  slider's range comes from the preset (logarithmic, so the pen's 0.1 pt —
  for drawing zoomed far in — gets as much travel as its thick end). **Saved inks** (`presets`, localStorage
  `conote:presets`, at most 6, validated on read): brush + colour + size,
  saved and forgotten in the ink panel, shown on the rail (wide screens only;
  phones use the panel) as the brush's icon in that colour, sized by where
  the size sits in the brush's range.
- **`mode = 'observe'`** disables inking but still allows pan/zoom — this is the
  README's "observer" session.
- **Tools:** `tool = 'pen' | 'brush' | 'marker' | 'text' | 'shape' | 'eraser' | 'lasso' | 'laser' | 'hand'`
  (the laser: see Presence). The eraser is stroke-level (removes whole
  strokes it touches, via `strokeHit` distance testing, and text boxes whose
  bounds it touches) with a **screen-constant**
  radius (`ERASER_SCREEN_RADIUS / viewport.scale` → world units), and one drag =
  one undo step.
- **Text boxes** (`TextBox` in `model.ts`, their own `Y.Array` `texts` — a
  separate array so clients from before text ignore them instead of
  crashing in `inkShape`; tracked by the UndoManager). Top-left anchored,
  page-local on a page like strokes, lines only at typed newlines, immutable:
  an edit is `noteStore.setText(oldId, box)` (delete + push, one undo step;
  empty text removes). A tap with the text tool (pen, mouse, or a finger
  where fingers ink) opens a `<textarea>` over the canvas at the box
  (`editing`), rendered and focused synchronously (`flushSync`) so phones
  open the keyboard; the pointerdown is `preventDefault`ed or the compat
  mousedown takes the focus back. Esc / Ctrl+Enter / blur / another tool
  stores it; a blur into the ink panel (`[data-pop]`) keeps it open so the
  colour and size restyle it. Drawn in Arimo (Helvetica-metric, self-hosted),
  exported in Helvetica (standard font, nothing embedded) — same widths, and
  `TEXT_ASCENT` puts the baseline where the textarea does. Characters
  outside WinAnsi print as `?` in the PDF but stay in conote.json (`texts`).
  Deliberate: text boxes are for quick remarks, not symbols, so no embedded
  font (decided with the user).
  No live preview to others while typing; it appears when stored.
  **Moving it while typing:** a text tap held and dragged takes the box
  along before it's let go (`textDrag`), and the open editor has a grip
  (`.textgrip`, its pointerdown `preventDefault`ed so the editor keeps the
  focus) to drag it anywhere; on release it's re-homed onto the page under
  its corner. A blur during the drag doesn't store it.
- **Shapes** (`Shape` in `model.ts`, their own `Y.Array` `shapes` — same
  reason as texts; tracked by the UndoManager; `shapes.ts`; key R): rect,
  ellipse, line, arrow and **cover**, picked in the ink panel (per device,
  `conote:shape`), with the shape ink's colour and line width. Drag out
  from corner / end to corner / end, Shift for square, circle or 45°;
  page-local on the page it starts on, clipped to it. Drawn into `base`
  after the ink and before text — covers first, opaque, so a cover hides
  the PDF *and* the ink under it, while text stays on top (labels).
  Immutable: changes are replacements. **A cover is for hiding part of a
  page during a talk:** a tap on it (shape or hand tool, or any tool while
  presenting) flips `open` for everyone via `setShape` — one undo step. A
  lifted cover isn't drawn or exported; editors see a dashed outline where
  it would go back (`openCovers`, off while presenting). The eraser takes
  shapes along their line (covers anywhere inside), the lasso by their
  middle; export draws them as vector paths in the ink stream.
- **Lasso** (`selection.ts`; key S): a loop takes the strokes with at
  least half their points inside and the text boxes whose middle is.
  `selection` keeps their ids and world copies; a frame shows it, with
  Copy / Cut / Delete above (and Ctrl+C / X, Delete, Esc). Dragging inside
  the frame moves it: the items leave the base layer and are drawn shifted
  (`drawMoving`) until pen-up, then `replaceItems` swaps them for moved
  copies (new ids — items are immutable) in one undo step, each re-homed
  onto the page under its start (`place`). A tap with the lasso offers
  *Paste* there when something is copied; Ctrl+V pastes under the pointer
  (any tool; the lasso then selects it). The clipboard is per device
  (localStorage `conote:clip`), so it works across notes and tabs. A
  selection follows the doc (undo, others erasing) and ends with another
  tool. Lasso and drag count as inking (view holds still, palms ignored, a
  second finger turns it into a pinch).
- **Dots on pages** (⋯ menu, notes with pages; per device, localStorage
  `conote:pageDots`): the desk's dot grid drawn over the pages too
  (`drawPageDots`, under the ink), for lining up geometry. Screen only.
- **Link previews in PDFs** (`PageRenderer.links` / `.preview`): a page's
  internal Link annotations (with a `dest`, no URL) are read once, page-local.
  Hovering one (mouse or pen hover, `HOVER_MS`), or tapping it while moving
  the view (hand tool, a finger on tablets, observers), shows a crop of the
  destination: from its point, the column found from the page's text (lines
  starting at its left edge, hanging indents allowed, plus what continues
  them), down ~4.6 lines or to the next entry back at the left edge (hanging
  indent / label column styles). Shown at the page's zoom (100–200%), within
  640 px; gone on moving off, any pointerdown, or a view change.

## Design & chrome (`app.css`, `NoteView.svelte`, `Home.svelte`)

- **"Paper & ink".** Warm paper (`--paper`), near-black chrome (`--ink`), one
  accent: highlighter lime (`--lime`), used for "on" states and highlights,
  vermilion only for warnings. Tokens live on `:root` in `app.css`; components
  use them, not raw colours (canvas code has its own constants next to `PAPER`).
- **Three typefaces, one job each:** `--f-serif` (Instrument Serif, mostly
  italic) for names and headlines; `--f-sans` (Bricolage Grotesque) for
  anything you read or press; `--f-mono` (DM Mono, the `.kicker` class:
  uppercase, tracked) for labels, numbers and status. Canvas text uses them by
  name too (presence tags mono, page notices serif).
- **The canvas is full-bleed; the chrome floats** in ink capsules (`.chrome`).
  Four **bars** — title, people (people/share/*Bring everyone here*/focus/
  more), view (zoom/fit/follow), tools — sit at eight **anchors** (three
  along the top, three along the bottom, left, right); the bars at one anchor
  share a capsule (`.group[data-anchor]`, each bar a `.bar[data-bar]`).
  `bars.svelte.ts` keeps the layout per device (localStorage `conote:bars`,
  validated on read), one for wide screens and one for phones (≤600px).
  Defaults keep the bottom right empty (the writing hand's arm): wide — title
  top left, view + people joined top right, tools left; phones — tools as a
  bottom dock in thumb reach, view bottom right (it wraps above the dock).
  Each capsule has a slim **tuck** tab (chevron): tucked, a corner capsule is a
  quarter circle in that screen corner (the title's shows the live dot), an
  edge one a tab on the edge; tapping brings it back. **Customize bars**
  (⋯ menu): drop zones in screen thirds, drag a bar to an anchor or onto a
  capsule to join it (caret shows where); the bars' buttons are inert and the
  canvas is covered meanwhile; the title can't go to the side columns; the
  middle cancels; Reset/Done (or Esc). The top and bottom rows are placed by
  hand (`rows` in `NoteView`, from measured widths): a centre capsule stays
  truly centred, a row too full for one line moves the centre inward (top) or
  the corners up (bottom), and the title shrinks first (`TITLE_MIN`). Panels
  (`pop`: people, share, more, ink — one at a time, closed by a pointerdown
  outside any `[data-pop]`; on the canvas that pointer — and fingers joining
  it — is swallowed in the capture phase (`closeFirst` in `NoteView`), so
  tapping away from a panel never also draws) hang off the button that opened them, clear of
  its capsule, toward the middle of the screen (`popStyle`).
- **The chrome steps back while the pen is down.** `DrawingCanvas` calls
  `onactive(true/false)` around strokes and the laser; `NoteView` sets
  `.inking`, and CSS fades `.chrome` to 10% with `pointer-events: none` after
  a short delay, coming back ~0.5 s after pen-up (so quick taps don't flash and
  writing keeps it down).
- **Focus mode** (`focus`, key F, Esc out): no chrome, ink off
  (`effectiveMode` → observe), others' view frames hidden (`showViews`;
  cursors, live strokes and lasers still show), fullscreen when the browser
  allows (leaving fullscreen leaves focus), the cursor hidden when idle, and a
  bar at the bottom that shows on movement and hides after ~2.6 s. Observers
  open in it. The bar picks what to **follow**: `follow` is `null`,
  `'drawing'` (fit everything as it grows — the old *Follow*), or a presence
  id (that device's `view`); one effect hands the target box to
  `DrawingCanvas.follow`, which eases toward it, and falls back if the device
  leaves. Any hand pan/zoom sets
  `follow = null`, as before.
- **Presenting** (`presenting`, F5 or the button beside focus — wide
  screens with pages only; ⋯ → Present everywhere; Esc ends): the pages in
  export order are the slides. Chrome gone, fullscreen if allowed, a dark
  desk (`desk='dark'`) without page labels, and the view held on the slide
  through `DrawingCanvas.follow` (a hand pan/zoom lets go until the next
  slide or *Fit*). ← → ↑ ↓, Page Up / Down (clickers) and Home / End turn
  pages. Editors keep drawing (a bottom bar like focus mode's: page
  arrows, pen / marker / eraser / laser / hand, undo); a pen tap on a
  cover lifts it instead of leaving a dot (`coverTaps`; its live preview is
  held back like a young finger stroke, so nobody sees a dot flash). For
  the owner, *Everyone follows* (on by default) sends a pull with each
  slide (`pullEveryone(page rect)`), so watching devices turn pages too.
  Blocks app updates while on.
- **Keyboard** (not while typing): P B M T R E S L H tools, Ctrl+Z / Ctrl+Shift+Z
  (or Ctrl+Y), Ctrl+C / X / V and Delete for the lasso, F focus, F5 present, 1 fit, 0 100%, +/− zoom, Esc closes a panel / leaves
  focus / ends presenting. Space-to-pan stays in `DrawingCanvas`.

## Not built yet

See `ROADMAP.md` for the full plan and the still-open questions. Highlights:

- **Taking stroke traffic off the server.** Direct links are an extra path; the
  relay still fans every stroke out to every device. See ROADMAP for options.
- **Passcode strength** — weak ones are refused and guessing is budgeted, but the
  4-character minimum stands; a 4-digit PIN still falls to patient guessing.
- **Off-machine backups** — the daily tarballs stay on the VPS.
- **PDF loose ends:** files no longer referenced by any page stay on the server
  (no GC); pdf.js's standard-font / CMap data isn't shipped, so PDFs relying on
  non-embedded fonts render with fallbacks; PDF links/text selection aren't
  supported; ink drawn in white on the old dark canvas is invisible on white
  paper.

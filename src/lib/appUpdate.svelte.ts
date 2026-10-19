// Keeping the app current, for an installed app that stays open for days.
//
// A new service worker takes over as soon as it's installed (skipWaiting +
// clientsClaim: older app versions, which reload when that happens, move
// over by themselves). The open page keeps running its own code; the files it
// may still load lazily stay on the server for a while (publish-web.sh keeps
// old bundles). This module registers the worker itself and
//   - asks for a new version often: every CHECK_MS while visible, and when
//     the app comes back to the front, regains focus or gets back online —
//     iOS home-screen apps only look by themselves at launch;
//   - once one has taken over, reloads into it at a quiet moment: nothing touched
//     for IDLE_MS (or the app in the background), and nothing that mustn't be
//     cut off — a stroke, an export, a half-filled form (`block()`);
//   - lets open views save what they show first (`beforeReload()`), so the
//     reload puts you back where you were (see NoteView's resume).

const CHECK_MS = 2 * 60_000;
/** Checks triggered by focus / visibility come at most this often. */
const MIN_GAP_MS = 20_000;
const IDLE_MS = 4000;
/** The notice stays this long before the reload; touching anything cancels. */
const NOTICE_MS = 1200;

class AppUpdate {
	/** A new version has taken over; this page still runs the old code. */
	ready = $state(false);
	/** About to reload into it (a notice is showing). */
	applying = $state(false);

	#blockers = new Set<() => boolean>();
	#savers = new Set<() => void>();
	#lastInput = Date.now();
	#started = false;

	async start() {
		if (this.#started || !('serviceWorker' in navigator)) return;
		this.#started = true;
		const url = '/sw.js';
		// A takeover while some worker already served this page is an update;
		// the first install claiming a fresh page isn't.
		let served = !!navigator.serviceWorker.controller;
		navigator.serviceWorker.addEventListener('controllerchange', () => {
			if (served) this.ready = true;
			served = true;
		});
		try {
			this.#watch(url, await navigator.serviceWorker.register(url, { scope: '/' }));
		} catch {
			return; // dev server, or no service worker allowed here
		}

		const touched = () => {
			this.#lastInput = Date.now();
			if (this.applying) this.applying = false; // they're back: not now
		};
		for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel']) {
			addEventListener(ev, touched, { capture: true, passive: true });
		}
		setInterval(() => this.#maybeApply(), 1000);
	}

	/** While `fn` returns true, the update waits (a stroke, an upload, a form being filled). */
	block(fn: () => boolean) {
		this.#blockers.add(fn);
		return () => void this.#blockers.delete(fn);
	}

	/** Called right before the reload, to stash what's on screen. */
	beforeReload(fn: () => void) {
		this.#savers.add(fn);
		return () => void this.#savers.delete(fn);
	}

	#watch(url: string, reg: ServiceWorkerRegistration) {
		let last = 0;
		const check = async () => {
			if (reg.installing || !navigator.onLine || Date.now() - last < MIN_GAP_MS) return;
			last = Date.now();
			try {
				// Only ask the browser to update when the script is reachable:
				// update() on a dead network throws noisily.
				const res = await fetch(url, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
				if (res.ok) await reg.update();
			} catch {
				/* offline or blocked: next time */
			}
		};
		setInterval(() => !document.hidden && check(), CHECK_MS);
		document.addEventListener('visibilitychange', () => !document.hidden && check());
		addEventListener('focus', check);
		addEventListener('online', check);
	}

	#blocked() {
		const el = document.activeElement as HTMLElement | null;
		const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
		return typing || [...this.#blockers].some((fn) => fn());
	}

	#maybeApply() {
		if (!this.ready || this.applying) return;
		const quiet = document.hidden || Date.now() - this.#lastInput > IDLE_MS;
		if (!quiet || this.#blocked()) return;
		if (document.hidden) return this.#go();
		this.applying = true;
		setTimeout(() => {
			// Touched meanwhile (applying was reset), or something started: wait again.
			if (this.applying && !this.#blocked()) this.#go();
			else this.applying = false;
		}, NOTICE_MS);
	}

	#go() {
		this.applying = true;
		for (const save of this.#savers) {
			try {
				save();
			} catch {
				/* a view that can't save just reopens fresh */
			}
		}
		location.reload();
	}
}

export const appUpdate = new AppUpdate();

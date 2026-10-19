// Where this device keeps its floating bars: which edge or corner each sits
// at, in what order, which are merged into one capsule, and which are tucked
// away. Per device (localStorage), with one layout for wide screens and one for
// phones, since what suits a tablet doesn't fit a phone.

export type BarId = 'title' | 'people' | 'view' | 'tools';
/** A place along the screen's edge. The bars at one anchor share a capsule. */
export type Anchor =
	| 'top-start'
	| 'top-center'
	| 'top-end'
	| 'left'
	| 'right'
	| 'bottom-start'
	| 'bottom-center'
	| 'bottom-end';
export type Profile = 'wide' | 'narrow';

export const ANCHORS: Anchor[] = [
	'top-start',
	'top-center',
	'top-end',
	'left',
	'right',
	'bottom-start',
	'bottom-center',
	'bottom-end'
];
export const BARS: BarId[] = ['title', 'people', 'view', 'tools'];
export const BAR_NAMES: Record<BarId, string> = { title: 'Title', people: 'People & menu', view: 'Zoom', tools: 'Tools' };
export const ANCHOR_NAMES: Record<Anchor, string> = {
	'top-start': 'Top left',
	'top-center': 'Top',
	'top-end': 'Top right',
	left: 'Left',
	right: 'Right',
	'bottom-start': 'Bottom left',
	'bottom-center': 'Bottom',
	'bottom-end': 'Bottom right'
};

export const isColumn = (a: Anchor) => a === 'left' || a === 'right';
export const isCorner = (a: Anchor) => a.endsWith('-start') || a.endsWith('-end');
/** The title doesn't read standing on end. */
export const fits = (id: BarId, a: Anchor) => !(id === 'title' && isColumn(a));

type Layout = { groups: Partial<Record<Anchor, BarId[]>>; hidden: Anchor[] };

// Nothing bottom right by default: that's where a right hand rests while
// writing. Phones keep the tools in thumb reach at the bottom; the zoom bar
// wraps above them when the row is full.
const DEFAULTS: Record<Profile, Layout> = {
	wide: { groups: { 'top-start': ['title'], 'top-end': ['view', 'people'], left: ['tools'] }, hidden: [] },
	narrow: {
		groups: { 'top-start': ['title'], 'top-end': ['people'], 'bottom-center': ['tools'], 'bottom-end': ['view'] },
		hidden: []
	}
};

const KEY = 'conote:bars';
const copy = (l: Layout): Layout => ({
	groups: Object.fromEntries(Object.entries(l.groups).map(([a, ids]) => [a, [...ids]])),
	hidden: [...l.hidden]
});

/** A stored layout, or null if it isn't one: every bar exactly once, each where it fits. */
function valid(raw: unknown): Layout | null {
	if (!raw || typeof raw !== 'object') return null;
	const { groups, hidden } = raw as Record<string, unknown>;
	if (!groups || typeof groups !== 'object' || !Array.isArray(hidden)) return null;
	const seen = new Set<BarId>();
	const out: Layout = { groups: {}, hidden: [] };
	for (const [a, ids] of Object.entries(groups)) {
		if (!ANCHORS.includes(a as Anchor) || !Array.isArray(ids)) return null;
		for (const id of ids) {
			if (!BARS.includes(id) || seen.has(id) || !fits(id, a as Anchor)) return null;
			seen.add(id);
		}
		if (ids.length) out.groups[a as Anchor] = [...ids];
	}
	if (seen.size !== BARS.length) return null;
	out.hidden = hidden.filter((a): a is Anchor => ANCHORS.includes(a) && !!out.groups[a as Anchor]);
	return out;
}

function read(): Record<Profile, Layout> {
	let stored: Record<string, unknown> = {};
	try {
		stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
	} catch {
		/* unreadable or blocked: defaults */
	}
	return {
		wide: valid(stored.wide) ?? copy(DEFAULTS.wide),
		narrow: valid(stored.narrow) ?? copy(DEFAULTS.narrow)
	};
}

export class Bars {
	#layouts = $state(read());
	/** Which layout applies; NoteView keeps it in step with the screen width. */
	profile = $state<Profile>('wide');

	#layout = $derived(this.#layouts[this.profile]);

	/** The bars at an anchor, in order (including ones this device doesn't show). */
	at(a: Anchor): BarId[] {
		return this.#layout.groups[a] ?? [];
	}

	anchorOf(id: BarId): Anchor {
		return ANCHORS.find((a) => this.at(a).includes(id)) ?? 'top-start';
	}

	isHidden(a: Anchor) {
		return this.#layout.hidden.includes(a);
	}

	setHidden(a: Anchor, on: boolean) {
		const l = this.#layout;
		l.hidden = on ? [...new Set([...l.hidden, a])] : l.hidden.filter((h) => h !== a);
		this.#save();
	}

	/** Put a bar at an anchor, before the bar now at `index` there (merging
	 *  it into that capsule). A tucked-away anchor comes back out. */
	move(id: BarId, to: Anchor, index: number) {
		if (!fits(id, to)) return;
		const l = this.#layout;
		const from = this.anchorOf(id);
		const rest = (l.groups[from] ?? []).filter((b) => b !== id);
		if (rest.length) l.groups[from] = rest;
		else {
			delete l.groups[from];
			l.hidden = l.hidden.filter((h) => h !== from);
		}
		const there = [...(l.groups[to] ?? [])];
		there.splice(Math.max(0, Math.min(index, there.length)), 0, id);
		l.groups[to] = there;
		l.hidden = l.hidden.filter((h) => h !== to);
		this.#save();
	}

	reset() {
		this.#layouts[this.profile] = copy(DEFAULTS[this.profile]);
		this.#save();
	}

	#save() {
		try {
			localStorage.setItem(KEY, JSON.stringify(this.#layouts));
		} catch {
			/* not remembered, still applies for this session */
		}
	}
}

// Note registry: who may open which note, and the drawings themselves.
//
// A note is created with a unique name and passcodes. The name is how people
// find it; the passcode they enter decides their role ('edit' or 'view').
// Passcodes are only ever stored as scrypt hashes. A successful join hands out
// a token that the WebSocket connection presents; tokens carry a per-role
// epoch, so changing a passcode revokes every token issued under the old one.
//
// Accounts are optional and only decide what is *kept*. A note created
// while signed in belongs to that account and stays until its owner deletes
// it; every account that joins it keeps its access (until that role's
// passcode changes). A note created without an account is ephemeral: the
// server deletes it once nobody has been connected for a short while (see
// sync-server.js), whoever else joined. Notes from before accounts are
// 'legacy': kept, until their owner claims them into an account.
//
// Everything lives in one data directory (CONOTE_DATA):
//   secret      HMAC key for tokens (generated on first start)
//   notes.json  the registry
//   accounts.json  accounts: name, password hash, and the notes each holds
//   docs/<id>   each note's Yjs state, so a note outlives its connections
//   files/<id>/<sha256>.pdf   PDFs imported into the note (content-addressed;
//               the doc's page list refers to them by hash)

import { randomBytes, scrypt as scryptCb, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const scrypt = promisify(scryptCb);

export const DATA_DIR = path.resolve(process.env.CONOTE_DATA || 'data');
const DOCS_DIR = path.join(DATA_DIR, 'docs');
const FILES_DIR = path.join(DATA_DIR, 'files');
const REGISTRY = path.join(DATA_DIR, 'notes.json');
const ACCOUNTS = path.join(DATA_DIR, 'accounts.json');
const SECRET = path.join(DATA_DIR, 'secret');

/** Who can observe a note: with the observer passcode, anyone who knows the
 *  name (no passcode), or nobody but editors. */
export const VIEW_ACCESS = ['passcode', 'open', 'none'];

const MAX_NOTES = 2000;

fs.mkdirSync(DOCS_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });

/** Write via rename so a crash mid-write never leaves a torn file behind. */
function writeAtomic(file, data) {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, data, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

const secret = (() => {
	try {
		return fs.readFileSync(SECRET);
	} catch {
		const s = randomBytes(32);
		writeAtomic(SECRET, s);
		return s;
	}
})();

/** @type {Map<string, any>} id → note record */
const notes = new Map();
/** @type {Map<string, string>} name → id */
const byName = new Map();
/** Ephemeral notes that ended, id → when: so a device coming back can be
 *  told "it ended" rather than "the owner deleted it". Pruned after a month. */
let ended = {};
const ENDED_KEEP_MS = 30 * 24 * 3600_000;

try {
	const parsed = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
	for (const n of Object.values(parsed.notes ?? {})) {
		n.keep ??= 'legacy'; // from before accounts: kept until claimed
		notes.set(n.id, n);
		byName.set(n.name, n.id);
	}
	ended = parsed.ended ?? {};
} catch (e) {
	if (e.code !== 'ENOENT') throw e; // a corrupt registry must not be silently replaced
}

function saveRegistry() {
	const now = Date.now();
	for (const [id, t] of Object.entries(ended)) if (now - t > ENDED_KEEP_MS) delete ended[id];
	writeAtomic(REGISTRY, JSON.stringify({ version: 1, notes: Object.fromEntries(notes), ended }, null, '\t'));
}

/** @type {Map<string, any>} account key (lower-cased name) → account */
const accounts = new Map();
try {
	const parsed = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8'));
	for (const a of Object.values(parsed.accounts ?? {})) accounts.set(a.key, a);
} catch (e) {
	if (e.code !== 'ENOENT') throw e;
}
const MAX_ACCOUNTS = 1000;

function saveAccounts() {
	writeAtomic(ACCOUNTS, JSON.stringify({ version: 1, accounts: Object.fromEntries(accounts) }, null, '\t'));
}

/** "Math Class " → "math-class". Clients normalise the same way, so what
 *  people type and what was created always meet. */
export function normalizeName(raw) {
	return String(raw ?? '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-');
}

export function nameError(name) {
	if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(name))
		return 'Note names are 3–40 characters: letters, digits and dashes.';
	return null;
}

/** The passcodes people reach for first. Guessing starts here, so these are
 *  refused outright (compared lower-cased). Runs and repeats are caught below. */
const COMMON = new Set(
	('password passwort passw0rd qwerty qwertz azerty letmein welcome admin secret ' +
		'test test123 hello iloveyou monkey dragon master login abc123 pass1234 ' +
		'123123 112233 121212 654321 666666 696969 123321 1q2w3e4r zaq12wsx')
		.split(' ')
);

/** All one character ("0000"), or a straight run up or down ("1234", "dcba"). */
function isRunOrRepeat(p) {
	const c = [...p.toLowerCase()].map((ch) => ch.codePointAt(0));
	const steps = new Set(c.slice(1).map((v, i) => v - c[i]));
	return steps.size === 1 && [0, 1, -1].includes([...steps][0]);
}

export function passcodeError(p, label, noteName = '') {
	if (typeof p !== 'string' || p.length < 4) return `${label} must be at least 4 characters.`;
	if (p.length > 200) return `${label} is too long.`;
	const lower = p.toLowerCase();
	if (COMMON.has(lower) || isRunOrRepeat(p) || (noteName && normalizeName(p) === noteName))
		return `${label} is too easy to guess. Pick something less obvious.`;
	return null;
}

async function hash(secretText) {
	const salt = randomBytes(16);
	const h = await scrypt(secretText, salt, 32);
	return `${salt.toString('hex')}:${h.toString('hex')}`;
}

async function matches(secretText, stored) {
	if (!stored || typeof secretText !== 'string' || !secretText) return false;
	const [saltHex, hashHex] = stored.split(':');
	const h = await scrypt(secretText, Buffer.from(saltHex, 'hex'), 32);
	return timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
}

const sign = (payload) => createHmac('sha256', secret).update(payload).digest('base64url');

/** Token = `<id>.<role>.<epoch>.<sig>`. Stateless: valid while the note exists
 *  and its epoch for that role hasn't moved on. */
function tokenFor(note, role) {
	const payload = `${note.id}.${role}.${note.epoch[role]}`;
	return `${payload}.${sign(payload)}`;
}

/** @returns {{ note: any, role: 'edit' | 'view' } | null} */
export function verifyToken(token) {
	const parts = String(token ?? '').split('.');
	if (parts.length !== 4) return null;
	const [id, role, epoch, sig] = parts;
	const expected = Buffer.from(sign(`${id}.${role}.${epoch}`));
	const given = Buffer.from(sig);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
	const note = notes.get(id);
	if (!note || (role !== 'edit' && role !== 'view')) return null;
	if (String(note.epoch[role]) !== epoch) return null;
	return { note, role };
}

/** Owner proof = a signature over `<id>.owner`. The relay takes it next to
 *  the token to mark the owner's connection (only the owner may pull the
 *  others' views). The owner key never changes, so neither does this; it ends
 *  with the note. */
const ownerProofFor = (id) => sign(`${id}.owner`);

export function verifyOwnerProof(id, proof) {
	if (typeof proof !== 'string' || !proof) return false;
	const expected = Buffer.from(ownerProofFor(id));
	const given = Buffer.from(proof);
	return expected.length === given.length && timingSafeEqual(expected, given) && notes.has(id);
}

/** What a client is told about a note it has access to. `saved`: whether the
 *  note outlives its last connection. */
function session(note, role, extra = {}) {
	return {
		id: note.id,
		name: note.name,
		role,
		viewAccess: note.viewAccess,
		token: tokenFor(note, role),
		saved: note.keep !== 'none',
		...extra
	};
}

/** The owner's session: an edit token plus the owner proof. */
const ownerSessionOf = (note, extra = {}) => session(note, 'edit', { ownerProof: ownerProofFor(note.id), ...extra });

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}
export { HttpError };

function checkViewSettings(viewAccess, viewPasscode, editPasscode, name) {
	if (!VIEW_ACCESS.includes(viewAccess)) throw new HttpError(400, 'Unknown observer setting.');
	if (viewAccess !== 'passcode') return;
	const err = passcodeError(viewPasscode, 'Observer passcode', name);
	if (err) throw new HttpError(400, err);
	// One passcode can only mean one role.
	if (viewPasscode === editPasscode)
		throw new HttpError(400, 'Observer and editor passcodes must differ.');
}

export async function createNote({ name, editPasscode, viewAccess = 'passcode', viewPasscode }, account = null) {
	name = normalizeName(name);
	const err = nameError(name) ?? passcodeError(editPasscode, 'Editor passcode', name);
	if (err) throw new HttpError(400, err);
	checkViewSettings(viewAccess, viewPasscode, editPasscode, name);
	if (notes.size >= MAX_NOTES) throw new HttpError(503, 'This server is full.');

	const ownerKey = randomBytes(18).toString('base64url');
	const note = {
		id: randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').toLowerCase(),
		name,
		createdAt: Date.now(),
		owner: await hash(ownerKey),
		edit: await hash(editPasscode),
		viewAccess,
		view: viewAccess === 'passcode' ? await hash(viewPasscode) : null,
		epoch: { edit: 1, view: 1 },
		// Kept with an account, ephemeral without one.
		keep: account ? 'account' : 'none',
		account: account?.key ?? null
	};
	// Re-check after the awaits: two creates of one name can interleave there.
	if (byName.has(name)) throw new HttpError(409, 'That name is taken. Pick another.');
	notes.set(note.id, note);
	byName.set(name, note.id);
	saveRegistry();
	if (account) grant(account, note, 'edit');
	return ownerSessionOf(note, { ownerKey, owned: !!account });
}

const WRONG = 'Wrong note name or passcode.';

/** Exchange a passcode for a token. An unknown name and a wrong passcode get
 *  the same answer, so this can't be used to probe which names exist. */
export async function join({ name, passcode }, account = null) {
	const note = notes.get(byName.get(normalizeName(name)) ?? '');
	if (!note) {
		await hash('timing'); // keep "no such note" as slow as a wrong passcode
		throw new HttpError(403, WRONG);
	}
	let role = null;
	if (await matches(passcode, note.edit)) role = 'edit';
	else if (note.viewAccess === 'passcode' && (await matches(passcode, note.view))) role = 'view';
	else if (note.viewAccess === 'open' && !passcode) role = 'view';
	if (!role) throw new HttpError(403, WRONG);
	if (account) grant(account, note, role);
	return session(note, role);
}

/** The owner: whoever holds the owner key, or the account the note belongs to. */
async function asOwner(id, ownerKey, account = null) {
	const note = notes.get(String(id ?? ''));
	const byAccount = !!note && !!account && note.account === account.key;
	if (!note || (!byAccount && !(await matches(ownerKey, note.owner))))
		throw new HttpError(403, 'Not the owner of this note.');
	return note;
}

/** The owner can always get back in, even after changing the passcodes. */
export async function ownerSession({ id, ownerKey }, account = null) {
	const note = await asOwner(id, ownerKey, account);
	return ownerSessionOf(note, { owned: !!account && note.account === account.key });
}

/**
 * Change passcodes / observer access. Omitted fields keep their current value.
 * Returns the roles whose tokens were revoked (so the caller can drop those
 * connections) and a fresh edit session for the owner, whose own token may be
 * among the revoked.
 */
export async function updateSettings({ id, ownerKey, editPasscode, viewAccess, viewPasscode }, account = null) {
	const note = await asOwner(id, ownerKey, account);
	const nextAccess = viewAccess ?? note.viewAccess;
	if (!VIEW_ACCESS.includes(nextAccess)) throw new HttpError(400, 'Unknown observer setting.');

	// Validate the whole target state before changing anything.
	const err =
		(editPasscode && passcodeError(editPasscode, 'Editor passcode', note.name)) ||
		(nextAccess === 'passcode' && viewPasscode && passcodeError(viewPasscode, 'Observer passcode', note.name));
	if (err) throw new HttpError(400, err);
	if (nextAccess === 'passcode' && !viewPasscode && note.viewAccess !== 'passcode')
		throw new HttpError(400, 'Set an observer passcode.');
	if (nextAccess === 'passcode') {
		// The passcodes in effect afterwards must differ: one passcode, one role.
		const same = editPasscode && viewPasscode
			? editPasscode === viewPasscode
			: editPasscode
				? await matches(editPasscode, note.view)
				: viewPasscode
					? await matches(viewPasscode, note.edit)
					: false;
		if (same) throw new HttpError(400, 'Observer and editor passcodes must differ.');
	}

	const revoked = [];
	if (nextAccess !== note.viewAccess || (nextAccess === 'passcode' && viewPasscode)) {
		// Validated above: switching to 'passcode' always comes with one.
		note.view = nextAccess === 'passcode' ? await hash(viewPasscode) : null;
		note.viewAccess = nextAccess;
		note.epoch.view++;
		revoked.push('view');
	}
	if (editPasscode) {
		note.edit = await hash(editPasscode);
		note.epoch.edit++;
		revoked.push('edit');
	}
	saveRegistry();
	return { revoked, session: ownerSessionOf(note, { owned: !!account && note.account === account.key }) };
}

function removeNote(note) {
	notes.delete(note.id);
	byName.delete(note.name);
	saveRegistry();
	fs.rmSync(docFile(note.id), { force: true });
	fs.rmSync(filesDir(note.id), { recursive: true, force: true });
}

export async function deleteNote({ id, ownerKey }, account = null) {
	const note = await asOwner(id, ownerKey, account);
	removeNote(note);
	return note.id;
}

export const noteExists = (id) => notes.has(id);

/** Notes that end when nobody is on them. */
export const ephemeralIds = () => [...notes.values()].filter((n) => n.keep === 'none').map((n) => n.id);

/** An ephemeral note's last connection is gone (for a while): delete it. */
export function endNote(id) {
	const note = notes.get(id);
	if (!note || note.keep !== 'none') return false;
	ended[id] = Date.now();
	removeNote(note);
	return true;
}

export const wasEnded = (id) => id in ended;

// --- Accounts -------------------------------------------------------------------
//
// Name + password, nothing else. A session token `a.<key>.<epoch>.<sig>` is
// stateless like note tokens; the epoch is there so a future "sign out
// everywhere" can revoke them. What an account holds is its grants: per note,
// the role it was given and that role's epoch at the time, so a passcode
// change still locks it out (the owner excepted).

const accountKey = (raw) => String(raw ?? '').trim().toLowerCase();

function accountNameError(key) {
	if (!/^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/.test(key))
		return 'Names are 3–24 characters: letters, digits, - and _.';
	return null;
}

function passwordError(p, key) {
	if (typeof p !== 'string' || p.length < 8) return 'The password must be at least 8 characters.';
	if (p.length > 200) return 'That password is too long.';
	if (COMMON.has(p.toLowerCase()) || isRunOrRepeat(p) || p.toLowerCase() === key)
		return 'That password is too easy to guess.';
	return null;
}

const accountTokenFor = (a) => {
	const payload = `a.${a.key}.${a.epoch}`;
	return `${payload}.${sign(payload)}`;
};

/** @returns the account a session token belongs to, or null. */
export function verifyAccount(token) {
	const parts = String(token ?? '').split('.');
	if (parts.length !== 4 || parts[0] !== 'a') return null;
	const [, key, epoch, sig] = parts;
	const expected = Buffer.from(sign(`a.${key}.${epoch}`));
	const given = Buffer.from(sig);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
	const account = accounts.get(key);
	return account && String(account.epoch) === epoch ? account : null;
}

const accountSession = (a) => ({ name: a.name, session: accountTokenFor(a) });

export async function register({ name, password }) {
	const display = String(name ?? '').trim();
	const key = accountKey(display);
	const err = accountNameError(key) ?? passwordError(password, key);
	if (err) throw new HttpError(400, err);
	if (accounts.size >= MAX_ACCOUNTS) throw new HttpError(503, 'This server is full.');
	const pass = await hash(password);
	if (accounts.has(key)) throw new HttpError(409, 'That name is taken.');
	const account = { key, name: display, pass, createdAt: Date.now(), epoch: 1, notes: {} };
	accounts.set(key, account);
	saveAccounts();
	return accountSession(account);
}

const WRONG_LOGIN = 'Wrong name or password.';

export async function login({ name, password }) {
	const account = accounts.get(accountKey(name));
	if (!account) {
		await hash('timing');
		throw new HttpError(403, WRONG_LOGIN);
	}
	if (!(await matches(password, account.pass))) throw new HttpError(403, WRONG_LOGIN);
	return accountSession(account);
}

/** Remember in `account` that it may open `note` as `role`. */
function grant(account, note, role) {
	const prev = account.notes[note.id];
	// Never step down: an editor who later joins with the observer passcode stays an editor.
	if (prev && prev.role === 'edit' && role === 'view' && String(prev.epoch) === String(note.epoch.edit)) return;
	account.notes[note.id] = { role, epoch: note.epoch[role], at: Date.now() };
	saveAccounts();
}

/** Everything an account holds, with fresh tokens. A grant whose passcode has
 *  changed since comes back `locked` (and without a token): the device asks
 *  for the new passcode. Grants of deleted notes are dropped. */
export function accountNotes(account) {
	const out = [];
	let changed = false;
	for (const [id, g] of Object.entries(account.notes)) {
		const note = notes.get(id);
		if (!note) {
			delete account.notes[id];
			changed = true;
			continue;
		}
		if (note.account === account.key) out.push(ownerSessionOf(note, { owned: true, at: g.at }));
		else if (String(note.epoch[g.role]) === String(g.epoch)) out.push(session(note, g.role, { at: g.at }));
		else
			out.push({ id, name: note.name, role: g.role, viewAccess: note.viewAccess, token: '', saved: note.keep !== 'none', locked: true, at: g.at });
	}
	if (changed) saveAccounts();
	return { notes: out };
}

export function forget(account, { id }) {
	const note = notes.get(String(id ?? ''));
	if (note && note.account === account.key)
		throw new HttpError(400, 'This note belongs to your account. Delete it instead.');
	delete account.notes[String(id ?? '')];
	saveAccounts();
	return { ok: true };
}

/** The owner (by key) puts an unsaved or legacy note into their account: it's kept from now on. */
export async function claim(account, { id, ownerKey }) {
	const note = await asOwner(id, ownerKey, account);
	if (note.account && note.account !== account.key)
		throw new HttpError(409, 'This note already belongs to another account.');
	note.keep = 'account';
	note.account = account.key;
	saveRegistry();
	grant(account, note, 'edit');
	return ownerSessionOf(note, { owned: true });
}

const docFile = (id) => path.join(DOCS_DIR, `${id}.bin`);

export function loadDoc(id) {
	try {
		return fs.readFileSync(docFile(id));
	} catch {
		return null;
	}
}

export function saveDoc(id, update) {
	// A note deleted while its room was still flushing must stay deleted.
	if (!notes.has(id)) return;
	writeAtomic(docFile(id), update);
}

// --- Imported files (PDFs) ----------------------------------------------------

/** Per note: what one import may weigh, and what all of them together may. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_NOTE_FILE_BYTES = 200 * 1024 * 1024;
const MAX_NOTE_FILES = 50;

const filesDir = (id) => path.join(FILES_DIR, id);
export const isHash = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);
export const filePath = (id, hash) => path.join(filesDir(id), `${hash}.pdf`);

/** Throws an HttpError if `id` can't take another `size` bytes. */
export function checkFileQuota(id, size) {
	if (size > MAX_FILE_BYTES) throw new HttpError(413, 'That file is too large (50 MB at most).');
	let entries = [];
	try {
		entries = fs.readdirSync(filesDir(id)).filter((f) => f.endsWith('.pdf'));
	} catch {
		/* no files yet */
	}
	const count = entries.length;
	const total = entries.reduce((sum, f) => sum + fs.statSync(path.join(filesDir(id), f)).size, 0);
	if (count >= MAX_NOTE_FILES || total + size > MAX_NOTE_FILE_BYTES)
		throw new HttpError(413, 'This note has no room for more files.');
}

/** Store `bytes` (already hashed by the caller) for note `id`. Idempotent. */
export function saveFile(id, hash, bytes) {
	if (!notes.has(id)) throw new HttpError(404, 'No such note.');
	fs.mkdirSync(filesDir(id), { recursive: true });
	const file = filePath(id, hash);
	if (!fs.existsSync(file)) writeAtomic(file, bytes);
}

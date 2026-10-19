// Zotero, relayed for signed-in users: search a library, fetch a PDF, save
// one back as a child attachment. Browsers can't do all of it themselves —
// file storage and most WebDAV servers (Koofr, …) don't allow cross-origin
// requests — so the server makes these calls on the user's behalf with the
// credentials sent along. It stores none of them.
//
// Files live in one of two places, as the library is set up in Zotero:
//   Zotero storage  /users/<id>/items/<key>/file (download; the 3-step upload)
//   WebDAV          <url>/zotero/<KEY>.zip (the file, zipped under its
//                   filename) + <KEY>.prop (<properties version="1"><mtime>…
//                   </mtime><hash>md5</hash></properties>); the item's md5
//                   and mtime are set through the API, which allows that for
//                   WebDAV libraries. Zotero desktop then syncs it like its own.
//
// The WebDAV URL is the user's, so it's the one request target not fixed
// here: https only, and every address it resolves to must be public (no
// loopback / private / link-local), checked at connect time (and up front
// for an IP literal, which skips the lookup). Redirects aren't followed.

import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';
import { HttpError } from './registry.js';

const API = process.env.CONOTE_ZOTERO_API || 'https://api.zotero.org';
// Tests run a fake WebDAV server on localhost over http.
const ALLOW_PRIVATE = process.env.CONOTE_DAV_ALLOW_PRIVATE === '1';
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

const isKey = (k) => typeof k === 'string' && /^[A-Z0-9]{8}$/.test(k);
const isUserId = (u) => typeof u === 'string' && /^[0-9]{1,12}$/.test(u);

function creds(body) {
	const { apiKey, userId } = body ?? {};
	if (typeof apiKey !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(apiKey)) throw new HttpError(400, 'That Zotero API key looks wrong.');
	if (userId !== undefined && !isUserId(String(userId))) throw new HttpError(400, 'Bad Zotero user id.');
	return { apiKey, userId: String(userId ?? '') };
}

async function api(path, apiKey, init = {}) {
	let res;
	try {
		res = await fetch(API + path, {
			...init,
			headers: { 'Zotero-API-Version': '3', 'Zotero-API-Key': apiKey, ...(init.headers ?? {}) }
		});
	} catch {
		throw new HttpError(502, "Can't reach Zotero.");
	}
	if (res.status === 403) throw new HttpError(403, 'Zotero refused the API key (check its permissions).');
	return res;
}

async function apiJson(path, apiKey, init) {
	const res = await api(path, apiKey, init);
	if (!res.ok) throw new HttpError(502, `Zotero said ${res.status}.`);
	return res.json();
}

/** The key's owner: { userId, username }. */
export async function verify(body) {
	const { apiKey } = creds(body);
	const k = await apiJson(`/keys/current`, apiKey);
	if (!k?.userID) throw new HttpError(400, "That key isn't tied to a user library.");
	return { userId: String(k.userID), username: String(k.username ?? ''), write: !!k.access?.user?.write };
}

const summary = (it) => ({
	key: it.key,
	title: String(it.data?.title ?? ''),
	creators: String(it.meta?.creatorSummary ?? ''),
	year: String(it.meta?.parsedDate ?? '').slice(0, 4),
	children: Number(it.meta?.numChildren ?? 0)
});

/** Top-level items matching `q` (title, creator, year), most recently changed first. */
export async function search(body) {
	const { apiKey, userId } = creds(body);
	const q = String(body.q ?? '').slice(0, 200);
	const params = new URLSearchParams({ limit: '30', sort: 'dateModified', include: 'data', qmode: 'titleCreatorYear' });
	if (q) params.set('q', q);
	const items = await apiJson(`/users/${userId}/items/top?${params}`, apiKey);
	return { items: items.filter((it) => it.data?.itemType !== 'note').map(summary) };
}

/** An item's PDF attachments (or the item itself, if it is one). */
export async function pdfs(body) {
	const { apiKey, userId } = creds(body);
	if (!isKey(body.key)) throw new HttpError(400, 'Bad item key.');
	const item = await apiJson(`/users/${userId}/items/${body.key}`, apiKey);
	const list = item.data?.itemType === 'attachment' ? [item] : await apiJson(`/users/${userId}/items/${body.key}/children`, apiKey);
	return {
		pdfs: list
			.filter((a) => a.data?.contentType === 'application/pdf' && String(a.data?.linkMode).startsWith('imported'))
			.map((a) => ({ key: a.key, title: String(a.data.title ?? ''), filename: String(a.data.filename ?? ''), parent: a.data.parentItem ?? null }))
	};
}

// --- WebDAV -----------------------------------------------------------------

function isPrivate(ip) {
	if (net.isIPv4(ip)) {
		const [a, b] = ip.split('.').map(Number);
		return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
	}
	const v = ip.toLowerCase();
	if (v.startsWith('::ffff:') && net.isIPv4(v.slice(7))) return isPrivate(v.slice(7));
	// ::/96-ish (loopback, unspecified, v4-mapped/compatible in hex), unique
	// local, link-local, multicast, and the prefixes that embed an IPv4
	// address (NAT64, 6to4): none is a WebDAV server on the internet.
	return /^(::|f[c-f]|64:ff9b:|2002:)/.test(v);
}

/** dns.lookup that refuses non-public addresses: used as the socket's lookup,
 *  so the address checked is the address connected to. */
function publicLookup(host, opts, cb) {
	dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
		if (err) return cb(err);
		const bad = addrs.find((a) => isPrivate(a.address));
		if (bad && !ALLOW_PRIVATE) return cb(new HttpError(400, 'That WebDAV address is not allowed.'));
		if (opts.all) cb(null, addrs);
		else cb(null, addrs[0].address, addrs[0].family);
	});
}

/** `<url>/zotero/` as Zotero itself builds it (it appends zotero/ to what you enter). */
function davBase(webdav) {
	let u;
	try {
		u = new URL(String(webdav?.url ?? '').trim().replace(/^(?!https?:\/\/)/, 'https://'));
	} catch {
		throw new HttpError(400, "That WebDAV URL isn't valid.");
	}
	if (u.protocol !== 'https:' && !(ALLOW_PRIVATE && u.protocol === 'http:')) throw new HttpError(400, 'WebDAV must use https.');
	if (u.username || u.password) throw new HttpError(400, 'Put the WebDAV user and password in their own fields.');
	// An address written as an IP never goes through the lookup below: check it here.
	const host = u.hostname.replace(/^\[|\]$/g, '');
	if (net.isIP(host) && isPrivate(host) && !ALLOW_PRIVATE) throw new HttpError(400, 'That WebDAV address is not allowed.');
	u.search = '';
	u.hash = '';
	const path = u.pathname.replace(/\/+$/, '');
	u.pathname = /\/zotero$/.test(path) ? `${path}/` : `${path}/zotero/`;
	return u;
}

function dav(webdav, method, name, body) {
	const url = new URL(name, davBase(webdav));
	const auth = Buffer.from(`${String(webdav.user ?? '')}:${String(webdav.password ?? '')}`).toString('base64');
	const mod = url.protocol === 'https:' ? https : http;
	return new Promise((resolve, reject) => {
		const req = mod.request(
			url,
			{
				method,
				lookup: publicLookup,
				timeout: 30_000,
				headers: { Authorization: `Basic ${auth}`, ...(body ? { 'Content-Length': body.length } : {}) }
			},
			(res) => {
				const chunks = [];
				let size = 0;
				res.on('data', (c) => {
					size += c.length;
					if (size > MAX_PDF_BYTES * 1.2) req.destroy(new HttpError(413, 'That file is too large.'));
					else chunks.push(c);
				});
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
				res.on('error', reject);
			}
		);
		req.on('timeout', () => req.destroy(new HttpError(504, 'The WebDAV server took too long.')));
		req.on('error', (e) => reject(e instanceof HttpError ? e : new HttpError(502, "Can't reach the WebDAV server.")));
		req.end(body);
	});
}

function davStatus(status, what) {
	if (status === 401 || status === 403) throw new HttpError(403, 'The WebDAV server refused the user name or password.');
	if (status === 404) throw new HttpError(404, `${what} isn't on the WebDAV server (has Zotero synced it?).`);
	if (status < 200 || status >= 300) throw new HttpError(502, `The WebDAV server said ${status}.`);
}

const isPdf = (b) => b.subarray(0, 5).toString('latin1') === '%PDF-';

/** The PDF of attachment `key`, from WebDAV or Zotero storage. */
export async function file(body) {
	const { apiKey, userId } = creds(body);
	if (!isKey(body.key)) throw new HttpError(400, 'Bad item key.');
	let bytes;
	if (body.webdav) {
		const res = await dav(body.webdav, 'GET', `${body.key}.zip`);
		davStatus(res.status, 'That file');
		let files;
		try {
			files = unzipSync(new Uint8Array(res.body));
		} catch {
			throw new HttpError(502, "The file on the WebDAV server isn't a readable zip.");
		}
		const first = Object.values(files).find((f) => isPdf(Buffer.from(f.subarray(0, 5))));
		if (!first) throw new HttpError(415, "That attachment isn't a PDF.");
		bytes = Buffer.from(first);
	} else {
		const res = await api(`/users/${userId}/items/${body.key}/file`, apiKey);
		if (res.status === 404) throw new HttpError(404, "That file isn't in Zotero storage (is it on WebDAV?).");
		if (!res.ok) throw new HttpError(502, `Zotero said ${res.status}.`);
		bytes = Buffer.from(await res.arrayBuffer());
	}
	if (bytes.length > MAX_PDF_BYTES) throw new HttpError(413, 'That file is too large (50 MB at most).');
	if (!isPdf(bytes)) throw new HttpError(415, "That attachment isn't a PDF.");
	return bytes;
}

/**
 * Save `bytes` as a PDF attachment: replacing attachment `meta.key` if given
 * and still there, else a new one under `meta.parent` (or top-level).
 * Returns { key }.
 */
export async function save(meta, bytes) {
	const { apiKey, userId } = creds(meta);
	if (!isPdf(bytes)) throw new HttpError(400, "That isn't a PDF.");
	const filename = String(meta.filename ?? 'conote.pdf').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').slice(0, 120) || 'conote.pdf';
	const title = String(meta.title ?? filename).slice(0, 300);
	const md5 = createHash('md5').update(bytes).digest('hex');
	const mtime = Date.now();
	const webdav = meta.webdav ?? null;

	// The attachment to replace, if it's still there.
	let existing = null;
	if (isKey(meta.key)) {
		const res = await api(`/users/${userId}/items/${meta.key}`, apiKey);
		if (res.ok) existing = await res.json();
	}
	let key = existing?.key;
	if (!existing) {
		const parent = isKey(meta.parent) ? meta.parent : undefined;
		const item = {
			itemType: 'attachment',
			linkMode: 'imported_file',
			title,
			contentType: 'application/pdf',
			filename,
			...(parent ? { parentItem: parent } : {}),
			...(webdav ? { md5, mtime } : {})
		};
		const res = await apiJson(`/users/${userId}/items`, apiKey, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Zotero-Write-Token': randomBytes(16).toString('hex') },
			body: JSON.stringify([item])
		});
		key = res?.successful?.['0']?.key;
		if (!key) throw new HttpError(502, `Zotero didn't create the attachment${res?.failed?.['0']?.message ? `: ${res.failed['0'].message}` : '.'}`);
	}

	if (webdav) {
		const zip = Buffer.from(zipSync({ [filename]: new Uint8Array(bytes) }, { level: 6 }));
		davStatus((await dav(webdav, 'PUT', `${key}.zip`, zip)).status, 'The upload');
		const prop = Buffer.from(`<properties version="1"><mtime>${mtime}</mtime><hash>${md5}</hash></properties>`);
		davStatus((await dav(webdav, 'PUT', `${key}.prop`, prop)).status, 'The upload');
		if (existing) {
			const res = await api(`/users/${userId}/items/${key}`, apiKey, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', 'If-Unmodified-Since-Version': String(existing.version) },
				body: JSON.stringify({ md5, mtime, filename, title })
			});
			if (!res.ok) throw new HttpError(502, `Zotero said ${res.status} updating the attachment.`);
		}
		return { key };
	}

	// Zotero storage: authorise, upload, register.
	const cond = existing?.data?.md5 ? { 'If-Match': existing.data.md5 } : { 'If-None-Match': '*' };
	const form = (o) => new URLSearchParams(o).toString();
	const authRes = await api(`/users/${userId}/items/${key}/file`, apiKey, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...cond },
		body: form({ md5, filename, filesize: String(bytes.length), mtime: String(mtime) })
	});
	if (authRes.status === 413) throw new HttpError(413, 'Your Zotero storage is full.');
	if (!authRes.ok) throw new HttpError(502, `Zotero said ${authRes.status} to the upload.`);
	const auth = await authRes.json();
	if (auth.exists) return { key };
	let up;
	try {
		up = await fetch(auth.url, {
			method: 'POST',
			headers: { 'Content-Type': auth.contentType },
			body: Buffer.concat([Buffer.from(auth.prefix, 'utf8'), bytes, Buffer.from(auth.suffix, 'utf8')])
		});
	} catch {
		throw new HttpError(502, "Can't reach Zotero's file storage.");
	}
	if (up.status !== 201 && !up.ok) throw new HttpError(502, `Zotero's file storage said ${up.status}.`);
	const reg = await api(`/users/${userId}/items/${key}/file`, apiKey, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...cond },
		body: form({ upload: auth.uploadKey })
	});
	if (reg.status !== 204 && !reg.ok) throw new HttpError(502, `Zotero said ${reg.status} registering the upload.`);
	return { key };
}

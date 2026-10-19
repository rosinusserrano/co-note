// This device's copy of a note's imported files (PDFs), in IndexedDB, so a
// note with a PDF opens offline and the PDF is fetched from the server once.
// Keyed `<noteId>/<sha256>`; content-addressed, so an entry never goes stale.

const DB = 'conote-files';
const STORE = 'files';

let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
	opening ??= new Promise((resolve, reject) => {
		const req = indexedDB.open(DB, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => {
			opening = null;
			reject(req.error);
		};
	});
	return opening;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
	return db().then(
		(d) =>
			new Promise<T>((resolve, reject) => {
				const req = fn(d.transaction(STORE, mode).objectStore(STORE));
				req.onsuccess = () => resolve(req.result as T);
				req.onerror = () => reject(req.error);
			})
	);
}

export async function getCachedFile(noteId: string, hash: string): Promise<Uint8Array | null> {
	if (typeof indexedDB === 'undefined') return null;
	try {
		const v = await run<ArrayBuffer | undefined>('readonly', (s) => s.get(`${noteId}/${hash}`));
		return v ? new Uint8Array(v) : null;
	} catch {
		return null;
	}
}

export async function cacheFile(noteId: string, hash: string, bytes: Uint8Array): Promise<void> {
	if (typeof indexedDB === 'undefined') return;
	try {
		// Store a standalone ArrayBuffer (not a view into something larger).
		await run('readwrite', (s) => s.put(bytes.slice().buffer, `${noteId}/${hash}`));
	} catch {
		// Quota / private mode: we'll just fetch it again next time.
	}
}

/** Forget every file of a note on this device. */
export async function dropCachedFiles(noteId: string): Promise<void> {
	if (typeof indexedDB === 'undefined') return;
	try {
		await run('readwrite', (s) => s.delete(IDBKeyRange.bound(`${noteId}/`, `${noteId}/￿`)));
	} catch {
		/* nothing to forget */
	}
}

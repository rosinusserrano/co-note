// A PDF dropped on the start page becomes a new note: Home creates the note,
// hands the file over here, and NoteView takes it when that note opens.

let pending: { id: string; file: File } | null = null;

export function handOver(id: string, file: File) {
	pending = { id, file };
}

/** The file waiting for note `id`, once. */
export function takeOver(id: string): File | null {
	if (pending?.id !== id) return null;
	const { file } = pending;
	pending = null;
	return file;
}

/** A note name from a file name: "Smith 2021 – Deep Nets.pdf" → "smith-2021-deep-nets".
 *  Leaves room for a "-2" if it's taken. */
export function nameFromFile(file: string): string {
	const base = file
		.replace(/\.pdf$/i, '')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 36)
		.replace(/-+$/, '');
	return base.length >= 3 ? base : `pdf-${base || 'note'}`.slice(0, 36);
}

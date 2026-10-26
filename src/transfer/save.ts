// Where transfers read and write files in a browser.
//
// Downloads: each file is saved as it completes, through a Blob and an
// <a download> click (every browser), or straight into a folder the user
// picked, through the File System Access API where there is one
// (Chromium). A Blob download keeps the file in the browser until it is
// saved: the parts are gathered into Blobs of a few MB (which the browser
// may move to disk) and the size is capped (transferMaxFile). A folder
// write streams to disk and is not capped.
//
// Uploads: a File (from the file picker) read a window at a time.
import type { SourceFile } from './types.ts';

export interface SavedFile {
    name: string;
    size: number;
    /** Blob downloads: an object URL to save it again (revoked by release()). */
    url?: string;
    where: 'download' | 'folder';
}

export interface FileSink {
    write(chunk: Uint8Array): void | Promise<void>;
    /** The file is complete (ok) or abandoned; returns what was saved, if anything. */
    end(ok: boolean): SavedFile | null;
}

export interface Saver {
    readonly kind: 'download' | 'folder';
    begin(name: string, size: number | null): FileSink;
    /** Forget the object URLs of earlier downloads. */
    release(): void;
}

/** Gather this much before making a Blob of it. */
const PART = 4 << 20;

export class BlobSaver implements Saver {
    readonly kind = 'download';
    private urls: string[] = [];
    private readonly container: () => HTMLElement;

    /** `container`: where the (hidden, momentary) download link goes. */
    constructor(container: () => HTMLElement) {
        this.container = container;
    }

    begin(name: string): FileSink {
        const parts: Blob[] = [];
        let cur: Uint8Array[] = [];
        let curLen = 0;
        return {
            write: chunk => {
                cur.push(chunk);
                curLen += chunk.length;
                if (curLen >= PART) {
                    parts.push(new Blob(cur as BlobPart[]));
                    cur = [];
                    curLen = 0;
                }
            },
            end: ok => {
                if (!ok) {
                    parts.length = 0;
                    cur = [];
                    return null;
                }
                const blob = new Blob([...parts, ...(cur as BlobPart[])], { type: 'application/octet-stream' });
                cur = [];
                const url = URL.createObjectURL(blob);
                this.urls.push(url);
                saveUrl(this.container(), url, name);
                return { name, size: blob.size, url, where: 'download' };
            },
        };
    }

    release(): void {
        for (const u of this.urls.splice(0)) URL.revokeObjectURL(u);
    }
}

/** Save an object URL as `name` (a momentary <a download> in `container`). */
export function saveUrl(container: HTMLElement, url: string, name: string): void {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.hidden = true;
    container.appendChild(a);
    a.click();
    a.remove();
}

interface DirHandle {
    getFileHandle(name: string, o?: { create?: boolean }): Promise<{ createWritable(): Promise<WritableFile> }>;
    name: string;
}
interface WritableFile {
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
}

/** Whether this browser can write into a folder the user picks. */
export function canPickFolder(): boolean {
    return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/** Ask the user for a folder (call from a click). Null if refused or unsupported. */
export async function pickFolder(): Promise<DirHandle | null> {
    const pick = (globalThis as { showDirectoryPicker?: (o: object) => Promise<DirHandle> }).showDirectoryPicker;
    if (!pick) return null;
    try {
        return await pick({ id: 'enig-term-downloads', mode: 'readwrite' });
    } catch {
        return null;
    }
}

export class FolderSaver implements Saver {
    readonly kind = 'folder';
    readonly dir: DirHandle;
    private readonly log: (s: string) => void;

    constructor(dir: DirHandle, log: (s: string) => void = () => {}) {
        this.dir = dir;
        this.log = log;
    }

    /** A name not used in the folder yet: "a.zip", then "a (1).zip", ... */
    private async unique(name: string): Promise<string> {
        const dot = name.lastIndexOf('.');
        const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
        for (let i = 0; i < 1000; i++) {
            const n = i ? `${stem} (${i})${ext}` : name;
            try {
                await this.dir.getFileHandle(n);
            } catch {
                return n;
            }
        }
        return `${stem} (${Date.now()})${ext}`;
    }

    begin(name: string): FileSink {
        let size = 0;
        let saved = name;
        const w: Promise<WritableFile> = this.unique(name).then(n => {
            saved = n;
            return this.dir.getFileHandle(n, { create: true }).then(h => h.createWritable());
        });
        return {
            write: chunk => {
                size += chunk.length;
                return w.then(f => f.write(chunk));
            },
            end: ok => {
                void w.then(f => (ok ? f.close() : f.abort())).catch(e => this.log(`could not finish ${saved}: ${(e as Error)?.message ?? e}`));
                return ok ? { name: saved, size, where: 'folder' } : null;
            },
        };
    }

    release(): void {}
}

/**
 * Read a File this much at a time, one piece ahead. A Blob read can take
 * tens of milliseconds (more in some Chromium builds), so a protocol that
 * asked for each block would crawl; one read per megabyte, started before it
 * is needed, keeps it busy.
 */
const CHUNK = 1 << 20;

/** A picked File as a transfer source: read a piece at a time, never whole. */
export function fileSource(f: File): SourceFile {
    let cur: { base: number; data: Uint8Array } | null = null;
    let ahead: { base: number; p: Promise<Uint8Array> } | null = null;
    const load = (base: number, n = CHUNK) => f.slice(base, base + n).arrayBuffer().then(b => new Uint8Array(b));
    const covers = (c: { base: number; data: Uint8Array } | null, off: number, len: number) => !!c && off >= c.base && off + len <= c.base + c.data.length;
    return {
        name: f.name,
        size: f.size,
        mtime: f.lastModified,
        read: async (off, len) => {
            if (!covers(cur, off, len)) {
                if (ahead && off >= ahead.base && off < ahead.base + CHUNK) {
                    cur = { base: ahead.base, data: await ahead.p };
                    ahead = null;
                }
                if (!covers(cur, off, len)) {
                    cur = { base: off, data: await load(off, Math.max(len, CHUNK)) };
                    ahead = null;
                }
            }
            const c = cur!;
            const next = c.base + c.data.length;
            if (!ahead && next < f.size) ahead = { base: next, p: load(next) };
            return c.data.subarray(off - c.base, Math.min(c.data.length, off - c.base + len));
        },
    };
}

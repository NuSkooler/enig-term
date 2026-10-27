// The CTerm file cache (`SyncTERM:C;S` stores, `C;L` lists with MD5s,
// `A;Load` reads): one per board, kept in IndexedDB so a returning caller
// does not download a board's sounds again. IndexedDB is per origin (the
// site serving enig-term); within it, files are keyed by the board endpoint.
//
// Bounded: a file larger than `maxFile` is refused, a board keeps at most
// `maxFiles` files, and the whole store (all boards) is kept under `capBytes`;
// both drop the least recently used files. Without IndexedDB (private
// windows, blocked storage, quota) it keeps the same structure in memory for
// the page's lifetime.
//
// A store is O(1): an index of every file (key, size, LRU order) is kept in
// memory, read from IndexedDB once, and eviction walks it from the oldest end.
// Another tab writing the same database says so on a BroadcastChannel and the
// index is read again before the next store; an IndexedDB error moves the
// store to memory (as before) and the index with it.

import { md5hex } from './md5.ts';

export interface CacheEntry {
    name: string;
    md5: string;
    size: number;
}

interface Meta {
    b: string;
    n: string;
    md5: string;
    size: number;
    used: number;
}

export interface StoreLimits {
    capBytes: number;
    maxFile: number;
    /** Files kept per board (default MAX_FILES). */
    maxFiles?: number;
}

/** Files kept per board: a board storing many tiny files cannot grow the index without bound. */
export const MAX_FILES = 4096;

const DB = 'enig-term-audio';

function req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((res, rej) => {
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error ?? new Error('aborted'));
    });
}

/** Recently stored or read files kept in memory as well (IndexedDB is slow: tens to hundreds of ms per transaction). */
const RECENT_BYTES = 32 << 20;

export class AudioStore {
    private db: Promise<IDBDatabase | null> | null = null;
    /** The store itself when IndexedDB is unavailable. */
    private mem = new Map<string, { meta: Meta; data: Uint8Array }>();
    /** Files written or read lately: reads and listings see a store at once, while IndexedDB catches up in order. */
    private recent = new Map<string, { meta: Meta; data: Uint8Array }>();
    private recentBytes = 0;
    private writes: Promise<unknown> = Promise.resolve();
    /** False once IndexedDB failed (files then live in memory only). */
    persistent = true;
    onFallback: ((why: string) => void) | null = null;
    private clock = 0;
    /** Every stored file (all boards), least recently used first. */
    private index = new Map<string, Meta>();
    /** The same files by board, least recently used first. */
    private boards = new Map<string, Map<string, Meta>>();
    private bytes = 0;
    /** The index matches IndexedDB (false until read, and after another tab wrote). */
    private indexed = false;
    private chan: BroadcastChannel | null = null;

    limits: StoreLimits;

    constructor(limits: StoreLimits) {
        this.limits = limits;
    }

    private open(): Promise<IDBDatabase | null> {
        if (!this.db) {
            this.db = new Promise<IDBDatabase | null>(res => {
                try {
                    const idb = globalThis.indexedDB;
                    if (!idb) throw new Error('no IndexedDB');
                    const r = idb.open(DB, 1);
                    r.onupgradeneeded = () => {
                        const db = r.result;
                        const meta = db.createObjectStore('meta', { keyPath: ['b', 'n'] });
                        meta.createIndex('used', 'used');
                        db.createObjectStore('data', { keyPath: ['b', 'n'] });
                    };
                    r.onsuccess = () => {
                        try {
                            this.chan = new BroadcastChannel(DB);
                            this.chan.onmessage = () => {
                                this.indexed = false;
                            };
                        } catch {
                            /* no other tab tells us; the index may run behind theirs */
                        }
                        res(r.result);
                    };
                    r.onerror = () => res(this.fallback(String(r.error?.message ?? r.error)));
                    r.onblocked = () => res(this.fallback('blocked'));
                } catch (e) {
                    res(this.fallback(String((e as Error)?.message ?? e)));
                }
            });
        }
        return this.db;
    }

    private fallback(why: string): null {
        if (this.persistent) {
            this.persistent = false;
            this.onFallback?.(why);
        }
        return null;
    }

    private stamp(): number {
        // Strictly increasing, so LRU order is exact even within one millisecond.
        this.clock = Math.max(this.clock + 1, Date.now());
        return this.clock;
    }

    private get maxFiles(): number {
        return this.limits.maxFiles ?? MAX_FILES;
    }

    private remember(key: string, meta: Meta, data: Uint8Array): void {
        const old = this.recent.get(key);
        if (old) this.recentBytes -= old.data.length;
        this.recent.delete(key);
        this.recent.set(key, { meta, data });
        this.recentBytes += data.length;
        for (const [k, v] of this.recent) {
            if (this.recentBytes <= RECENT_BYTES && this.recent.size <= this.maxFiles) break;
            this.recent.delete(k);
            this.recentBytes -= v.data.length;
        }
    }

    // --- the index ----------------------------------------------------------------------

    private idxDel(key: string): Meta | undefined {
        const m = this.index.get(key);
        if (!m) return undefined;
        this.index.delete(key);
        const b = this.boards.get(m.b);
        b?.delete(key);
        if (b && !b.size) this.boards.delete(m.b);
        this.bytes -= m.size;
        return m;
    }

    /** Add a file, or move it to the most recently used end. */
    private idxAdd(key: string, m: Meta): void {
        this.idxDel(key);
        this.index.set(key, m);
        let b = this.boards.get(m.b);
        if (!b) this.boards.set(m.b, (b = new Map()));
        b.set(key, m);
        this.bytes += m.size;
    }

    private idxReset(): void {
        this.index.clear();
        this.boards.clear();
        this.bytes = 0;
    }

    private async idxLoad(db: IDBDatabase): Promise<void> {
        this.indexed = true; // a message from another tab during the read marks it stale again
        const all = (await req(db.transaction('meta', 'readonly').objectStore('meta').getAll())) as Meta[];
        all.sort((a, b) => a.used - b.used);
        this.idxReset();
        for (const m of all) this.idxAdd(`${m.b}\n${m.n}`, m);
    }

    /** Take out of the index what must go to make room for `meta` (not in it): the board's oldest past maxFiles, then the oldest of all past capBytes. */
    private victims(meta: Meta): [string, Meta][] {
        const out: [string, Meta][] = [];
        const take = (k: string) => {
            const m = this.idxDel(k)!;
            out.push([k, m]);
            // A copy in `recent` of what is dropped goes too, or a listing keeps showing it.
            const r = this.recent.get(k);
            if (r && r.meta.md5 === m.md5) {
                this.recent.delete(k);
                this.recentBytes -= r.data.length;
            }
        };
        const b = this.boards.get(meta.b);
        while (b?.size && b.size >= this.maxFiles) take(b.keys().next().value!);
        while (this.index.size && this.bytes + meta.size > this.limits.capBytes) take(this.index.keys().next().value!);
        return out;
    }

    /**
     * Store a file. False if it is too large. Reads and listings see it at
     * once; IndexedDB is written in the background, in order.
     */
    async put(board: string, name: string, data: Uint8Array): Promise<boolean> {
        if (data.length > this.limits.maxFile) return false;
        const copy = data.slice();
        if (this.limits.capBytes === 0) {
            // No persistent cache: this page's memory only.
            this.remember(`${board}\n${name}`, { b: board, n: name, md5: md5hex(copy), size: copy.length, used: this.stamp() }, copy);
            return true;
        }
        if (data.length > this.limits.capBytes) return false;
        const meta: Meta = { b: board, n: name, md5: md5hex(copy), size: copy.length, used: this.stamp() };
        this.remember(`${board}\n${name}`, meta, copy);
        const w = this.writes.then(() => this.write(meta, copy));
        this.writes = w.catch(() => {});
        return true;
    }

    /** Everything stored so far is in IndexedDB (tests). */
    flushed(): Promise<unknown> {
        return this.writes;
    }

    private async write(meta: Meta, data: Uint8Array): Promise<boolean> {
        const board = meta.b;
        const name = meta.n;
        const key = `${board}\n${name}`;
        const db = await this.open();
        if (db) {
            try {
                if (!this.indexed) await this.idxLoad(db);
                this.idxDel(key);
                const gone = this.victims(meta);
                this.idxAdd(key, meta);
                const tx = db.transaction(['meta', 'data'], 'readwrite');
                const ms = tx.objectStore('meta');
                const ds = tx.objectStore('data');
                for (const [, m] of gone) {
                    ms.delete([m.b, m.n]);
                    ds.delete([m.b, m.n]);
                }
                ms.put(meta);
                ds.put({ b: board, n: name, data: data.buffer });
                await done(tx);
                this.chan?.postMessage(0);
                return true;
            } catch (e) {
                // The files now live in memory (empty so far), and the index with them.
                this.indexed = false;
                this.idxReset();
                this.db = Promise.resolve(this.fallback(String((e as Error)?.message ?? e)));
            }
        }
        this.idxDel(key);
        for (const [k] of this.victims(meta)) this.mem.delete(k);
        this.idxAdd(key, meta);
        this.mem.set(key, { meta, data });
        return true;
    }

    async get(board: string, name: string): Promise<Uint8Array | null> {
        const key = `${board}\n${name}`;
        const hot = this.recent.get(key);
        if (hot) {
            this.touch(hot.meta);
            this.remember(key, hot.meta, hot.data);
            return hot.data;
        }
        const db = await this.open();
        if (db) {
            try {
                const tx = db.transaction(['meta', 'data'], 'readonly');
                const rec = (await req(tx.objectStore('data').get([board, name]))) as { data: ArrayBuffer } | undefined;
                const meta = (await req(tx.objectStore('meta').get([board, name]))) as Meta | undefined;
                if (!rec || !meta) return null;
                const data = new Uint8Array(rec.data);
                this.touch(meta);
                this.remember(key, meta, data);
                return data;
            } catch {
                return null;
            }
        }
        const e = this.mem.get(key);
        if (!e) return null;
        e.meta.used = this.stamp();
        if (this.index.get(key) === e.meta) this.idxAdd(key, e.meta);
        return e.data;
    }

    /** Mark a file used (LRU), in the background. */
    private touch(meta: Meta): void {
        meta.used = this.stamp();
        const m = { ...meta };
        const key = `${m.b}\n${m.n}`;
        const w = this.writes.then(async () => {
            const db = await this.open();
            const idx = this.index.get(key);
            if (!db) {
                if (idx && idx.md5 === m.md5) this.idxAdd(key, idx);
                return;
            }
            const tx = db.transaction('meta', 'readwrite');
            // Only if it is still there (an eviction or a clear may have removed it).
            const cur = (await req(tx.objectStore('meta').get([m.b, m.n]))) as Meta | undefined;
            if (cur && cur.md5 === m.md5) tx.objectStore('meta').put(m);
            await done(tx);
            if (idx && idx.md5 === m.md5 && this.index.get(key) === idx) {
                idx.used = m.used;
                this.idxAdd(key, idx);
            }
        });
        this.writes = w.catch(() => {});
    }

    async list(board: string): Promise<CacheEntry[]> {
        // Writes still in flight are in `recent`; wait for none of them.
        const db = await this.open();
        let metas: Meta[] = [];
        if (db) {
            try {
                const tx = db.transaction('meta', 'readonly');
                metas = (await req(tx.objectStore('meta').getAll(IDBKeyRange.bound([board, ''], [board, String.fromCharCode(0xffff)])))) as Meta[];
            } catch {
                metas = [];
            }
        } else metas = [...this.mem.values()].map(v => v.meta).filter(m => m.b === board);
        const all = new Map(metas.map(m => [m.n, m]));
        for (const v of this.recent.values()) if (v.meta.b === board) all.set(v.meta.n, v.meta);
        metas = [...all.values()];
        return metas.map(m => ({ name: m.n, md5: m.md5, size: m.size })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }

    /** Everything stored (all boards): files and bytes. */
    async usage(): Promise<{ files: number; bytes: number }> {
        await this.writes;
        const db = await this.open();
        let metas: Meta[];
        if (db) {
            try {
                metas = (await req(db.transaction('meta', 'readonly').objectStore('meta').getAll())) as Meta[];
            } catch {
                metas = [];
            }
        } else metas = [...this.mem.values()].map(v => v.meta);
        return { files: metas.length, bytes: metas.reduce((n, m) => n + m.size, 0) };
    }

    /** Forget every stored file (all boards). */
    async clear(): Promise<{ files: number; bytes: number }> {
        const u = await this.usage();
        this.mem.clear();
        this.recent.clear();
        this.recentBytes = 0;
        this.idxReset();
        this.indexed = false;
        const db = await this.open();
        if (db) {
            try {
                const tx = db.transaction(['meta', 'data'], 'readwrite');
                tx.objectStore('meta').clear();
                tx.objectStore('data').clear();
                await done(tx);
                this.chan?.postMessage(0);
            } catch {
                /* nothing more to do */
            }
        }
        return u;
    }
}

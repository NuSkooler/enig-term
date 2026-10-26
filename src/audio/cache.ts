// The CTerm file cache (`SyncTERM:C;S` stores, `C;L` lists with MD5s,
// `A;Load` reads): one per board, kept in IndexedDB so a returning caller
// does not download a board's sounds again. IndexedDB is per origin (the
// site serving enig-term); within it, files are keyed by the board endpoint.
//
// Bounded: a file larger than `maxFile` is refused, and the whole store (all
// boards) is kept under `capBytes` by dropping the least recently used files.
// Without IndexedDB (private windows, blocked storage, quota) it keeps the
// same structure in memory for the page's lifetime.

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
}

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
                    r.onsuccess = () => res(r.result);
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

    private remember(key: string, meta: Meta, data: Uint8Array): void {
        const old = this.recent.get(key);
        if (old) this.recentBytes -= old.data.length;
        this.recent.delete(key);
        this.recent.set(key, { meta, data });
        this.recentBytes += data.length;
        for (const [k, v] of this.recent) {
            if (this.recentBytes <= RECENT_BYTES) break;
            this.recent.delete(k);
            this.recentBytes -= v.data.length;
        }
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
        const db = await this.open();
        if (db) {
            try {
                const tx = db.transaction(['meta', 'data'], 'readwrite');
                const ms = tx.objectStore('meta');
                const ds = tx.objectStore('data');
                const all = (await req(ms.getAll())) as Meta[];
                let total = 0;
                for (const m of all) if (!(m.b === board && m.n === name)) total += m.size;
                all.sort((a, b) => a.used - b.used);
                for (const m of all) {
                    if (total + data.length <= this.limits.capBytes) break;
                    if (m.b === board && m.n === name) continue;
                    ms.delete([m.b, m.n]);
                    ds.delete([m.b, m.n]);
                    total -= m.size;
                }
                ms.put(meta);
                ds.put({ b: board, n: name, data: data.buffer });
                await done(tx);
                return true;
            } catch (e) {
                this.db = Promise.resolve(this.fallback(String((e as Error)?.message ?? e)));
            }
        }
        const key = `${board}\n${name}`;
        let total = 0;
        for (const [k, v] of this.mem) if (k !== key) total += v.meta.size;
        for (const [k, v] of [...this.mem].sort((a, b) => a[1].meta.used - b[1].meta.used)) {
            if (total + data.length <= this.limits.capBytes) break;
            if (k === key) continue;
            this.mem.delete(k);
            total -= v.meta.size;
        }
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
        return e.data;
    }

    /** Mark a file used (LRU), in the background. */
    private touch(meta: Meta): void {
        meta.used = this.stamp();
        const m = { ...meta };
        const w = this.writes.then(async () => {
            const db = await this.open();
            if (!db) return;
            const tx = db.transaction('meta', 'readwrite');
            // Only if it is still there (an eviction or a clear may have removed it).
            const cur = (await req(tx.objectStore('meta').get([m.b, m.n]))) as Meta | undefined;
            if (cur && cur.md5 === m.md5) tx.objectStore('meta').put(m);
            await done(tx);
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
        const db = await this.open();
        if (db) {
            try {
                const tx = db.transaction(['meta', 'data'], 'readwrite');
                tx.objectStore('meta').clear();
                tx.objectStore('data').clear();
                await done(tx);
            } catch {
                /* nothing more to do */
            }
        }
        return u;
    }
}

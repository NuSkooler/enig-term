// Loads the WASM core and wraps it with a typed API that survives engine
// panics.
//
// A Rust panic in wasm32 is a trap (`RuntimeError: unreachable`). The instance
// cannot be trusted afterwards: the shadow stack pointer and wasm-bindgen's
// borrow flags are left as they were mid-call. So recovery replaces the whole
// instance: the compiled module is instantiated again (cheap: no recompile),
// every EngineCore on the page rebuilds its Core on it, and the connection
// above carries on. The screen contents and scrollback of the dead instance
// are lost.
import init, { Core, last_panic, __enigModule, __enigReset } from '../build/wasm/enig_term_core.js';
import type { CoreEvent } from './replies.ts';

export type { Core };

/** Errors that mean the instance is gone, as opposed to a normal thrown JsError. */
export function isTrap(e: unknown): boolean {
    if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) return true;
    const m = String((e as Error)?.message ?? e);
    return /recursive use of an object|null pointer passed to rust|unreachable|memory access out of bounds/.test(m);
}

class WasmHost {
    memory: WebAssembly.Memory | null = null;
    generation = 0;
    private loading: Promise<WebAssembly.Memory> | null = null;
    private recovering: Promise<void> | null = null;
    private readonly cores = new Set<EngineCore>();
    /** Recent trap times, to stop recovering from a host that traps us in a loop. */
    private traps: number[] = [];

    load(wasmUrl?: string | URL): Promise<WebAssembly.Memory> {
        if (!this.loading) {
            const url = wasmUrl ?? defaultWasmUrl();
            this.loading = init({ module_or_path: url }).then(ex => (this.memory = ex.memory));
        }
        return this.loading;
    }

    register(c: EngineCore): void {
        this.cores.add(c);
    }
    unregister(c: EngineCore): void {
        this.cores.delete(c);
    }

    /** Called by the EngineCore that caught a trap. Recovers every core once. */
    recover(message: string): Promise<void> {
        if (this.recovering) return this.recovering;
        const now = Date.now();
        this.traps = this.traps.filter(t => now - t < 60_000);
        this.traps.push(now);
        for (const c of this.cores) c.invalidate();
        if (this.traps.length > 5) {
            for (const c of this.cores) {
                c.fail('the terminal engine failed repeatedly; reload the page');
                c.onTrap?.({ message, recovered: false });
            }
            return Promise.reject(new Error('too many engine failures'));
        }
        const module = __enigModule();
        __enigReset();
        this.recovering = init({ module_or_path: module ?? defaultWasmUrl() })
            .then(ex => {
                this.memory = ex.memory;
                this.generation++;
                // Every terminal on the page lost its screen: rebuild and tell each.
                for (const c of this.cores) {
                    c.rebuild();
                    c.onTrap?.({ message, recovered: true });
                }
            })
            .finally(() => (this.recovering = null));
        return this.recovering;
    }
}

function defaultWasmUrl(): URL {
    // Relative to this bundle, so the terminal works from any page that loads
    // it. The build stamps the WASM's hash into the query so a cached bundle
    // never pairs with a different WASM (file names carry no hash).
    return new URL(`./enig_term_core_bg.wasm${WASM_QUERY}`, import.meta.url);
}
declare const __ENIG_TERM_WASM_HASH__: string | undefined;
const WASM_QUERY = typeof __ENIG_TERM_WASM_HASH__ === 'string' && __ENIG_TERM_WASM_HASH__ ? `?v=${__ENIG_TERM_WASM_HASH__}` : '';

export const wasmHost = new WasmHost();

/** Initialise the WASM module once. `wasmUrl` defaults to the file next to the bundle. */
export function loadCore(wasmUrl?: string | URL): Promise<WebAssembly.Memory> {
    return wasmHost.load(wasmUrl);
}

export interface RenderResult {
    kind: 0 | 1 | 2; // nothing, band, full
    pixels: Uint8Array | null; // view into WASM memory: copy or upload before the next core call
    frameW: number;
    frameH: number;
    y: number;
    h: number;
}

export interface CoreSettings {
    cols: number;
    rows: number;
    scrollback: number;
    scrollbackOnClear: boolean;
    /** Test hook: let CSI ? 2026 h reach the engine, which panics on wasm32. */
    debugPanic?: boolean;
}

export interface TrapInfo {
    message: string;
    recovered: boolean;
}

const NONE: RenderResult = { kind: 0, pixels: null, frameW: 0, frameH: 0, y: 0, h: 0 };
const MAX_QUEUED = 1 << 20;

/**
 * One terminal's engine. Every call is guarded: after a trap the methods
 * return neutral values, bytes fed meanwhile are queued, and once the host has
 * a fresh instance the core is rebuilt and the queue replayed (the chunk that
 * trapped is dropped, so it cannot trap again).
 */
export class EngineCore {
    core!: Core;
    private dead = false;
    private failed = false;
    private queue: Uint8Array[] = [];
    private queued = 0;
    private lastMessage = '';
    onTrap: ((info: TrapInfo) => void) | null = null;
    onRebuilt: (() => void) | null = null;
    /** Events produced while replaying queued bytes after a rebuild. */
    onEvents: ((ev: CoreEvent[]) => void) | null = null;

    constructor(private settings: CoreSettings) {
        this.create();
        wasmHost.register(this);
    }

    get memory(): WebAssembly.Memory {
        return wasmHost.memory!;
    }

    get alive(): boolean {
        return !this.dead;
    }

    private create(): void {
        const s = this.settings;
        this.core = new Core(s.cols, s.rows, 'ansi');
        this.core.set_scrollback_lines(s.scrollback);
        this.core.set_capture_on_clear(s.scrollbackOnClear);
        if (s.debugPanic) this.core.debug_passthrough_sync(true);
    }

    /** Run `fn` on the core; a trap starts recovery and yields `fallback`. */
    call<T>(fn: (c: Core) => T, fallback: T): T {
        if (this.dead) return fallback;
        try {
            return fn(this.core);
        } catch (e) {
            if (!isTrap(e)) throw e;
            this.trapped(e);
            return fallback;
        }
    }

    private trapped(e: unknown): void {
        let msg = '';
        try {
            msg = last_panic();
        } catch {
            /* the dead instance may not even manage that */
        }
        this.lastMessage = msg || String((e as Error)?.message ?? e);
        console.error(`enig-term: engine trapped: ${this.lastMessage}`);
        wasmHost.recover(this.lastMessage).catch(() => {});
    }

    /** The instance is gone: forget the Core without calling into WASM. */
    invalidate(): void {
        if (this.dead) return;
        this.dead = true;
        // Unregisters wasm-bindgen's finalizer, which would otherwise free the
        // old pointer inside the *new* instance when this object is collected.
        (this.core as unknown as { __destroy_into_raw?: () => number }).__destroy_into_raw?.();
    }

    rebuild(): void {
        if (this.failed) return;
        this.create();
        this.dead = false;
        this.onRebuilt?.();
        const q = this.queue;
        this.queue = [];
        this.queued = 0;
        for (const b of q) {
            const ev = this.feed(b);
            if (ev.length) this.onEvents?.(ev);
        }
    }

    fail(reason: string): void {
        this.failed = true;
        this.lastMessage = reason;
    }

    /** Feed host bytes; returns the events they produced (usually none). */
    feed(bytes: Uint8Array): CoreEvent[] {
        if (this.dead) {
            if (!this.failed && this.queued + bytes.length <= MAX_QUEUED) {
                this.queue.push(bytes.slice());
                this.queued += bytes.length;
            }
            return [];
        }
        return this.call(c => {
            const n = c.feed(bytes);
            return n ? (JSON.parse(c.take_events()) as CoreEvent[]) : [];
        }, []);
    }

    render(full = false): RenderResult {
        return this.call(c => {
            const kind = c.render(full) as 0 | 1 | 2;
            const frameW = c.frame_width();
            const frameH = c.frame_height();
            if (!kind) return { kind, pixels: null, frameW, frameH, y: 0, h: 0 };
            const pixels = new Uint8Array(this.memory.buffer, c.frame_ptr(), c.frame_len());
            return { kind, pixels, frameW, frameH, y: c.region_y(), h: c.region_h() };
        }, NONE);
    }

    resize(cols: number, rows: number): void {
        this.settings.cols = cols;
        this.settings.rows = rows;
        this.call(c => c.resize(cols, rows), undefined);
    }

    setScrollback(lines: number): void {
        this.settings.scrollback = lines;
        this.call(c => c.set_scrollback_lines(lines), undefined);
    }

    destroy(): void {
        wasmHost.unregister(this);
        if (!this.dead) this.call(c => c.free(), undefined);
        this.dead = true;
    }

    get cols(): number {
        return this.call(c => c.cols(), this.settings.cols);
    }
    get rows(): number {
        return this.call(c => c.rows(), this.settings.rows);
    }
}

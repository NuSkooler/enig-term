// Loads the WASM core and wraps it with a typed, allocation-light API.
import init, { Core } from '../build/wasm/enig_term_core.js';
import type { CoreEvent } from './replies.js';

export type { Core };

let ready: Promise<WebAssembly.Memory> | null = null;

/** Initialise the WASM module once. `wasmUrl` defaults to the file next to the bundle. */
export function loadCore(wasmUrl?: string | URL): Promise<WebAssembly.Memory> {
    if (!ready) {
        const url = wasmUrl ?? new URL('./enig_term_core_bg.wasm', import.meta.url);
        ready = init({ module_or_path: url }).then(exports => exports.memory);
    }
    return ready;
}

export interface RenderResult {
    kind: 0 | 1 | 2; // nothing, band, full
    pixels: Uint8Array | null; // view into WASM memory: copy or upload before the next core call
    frameW: number;
    frameH: number;
    y: number;
    h: number;
}

export class EngineCore {
    readonly core: Core;
    constructor(
        private readonly memory: WebAssembly.Memory,
        cols: number,
        rows: number,
        emulation = 'ansi',
    ) {
        this.core = new Core(cols, rows, emulation);
    }

    /** Feed host bytes; returns the events they produced (usually none). */
    feed(bytes: Uint8Array): CoreEvent[] {
        const n = this.core.feed(bytes);
        return n ? (JSON.parse(this.core.take_events()) as CoreEvent[]) : [];
    }

    render(full = false): RenderResult {
        const kind = this.core.render(full) as 0 | 1 | 2;
        const frameW = this.core.frame_width();
        const frameH = this.core.frame_height();
        if (!kind) return { kind, pixels: null, frameW, frameH, y: 0, h: 0 };
        const pixels = new Uint8Array(this.memory.buffer, this.core.frame_ptr(), this.core.frame_len());
        return { kind, pixels, frameW, frameH, y: this.core.region_y(), h: this.core.region_h() };
    }

    get cols(): number {
        return this.core.cols();
    }
    get rows(): number {
        return this.core.rows();
    }
}

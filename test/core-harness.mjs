// Shared loader for Node-side tests of the WASM core.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WASM_DIR = path.join(here, '..', 'build', 'wasm');

export const ESC = String.fromCharCode(0x1b);
export const CSI = ESC + '[';
export const ST = ESC + '\\';

/** Latin-1 string to bytes (every char code 0..255 maps to one byte). */
export function bytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}

export async function loadCore() {
    const glue = await import(path.join(WASM_DIR, 'enig_term_core.js'));
    const wasm = await glue.default({ module_or_path: fs.readFileSync(path.join(WASM_DIR, 'enig_term_core_bg.wasm')) });
    return { Core: glue.Core, memory: wasm.memory, glue };
}

/** Copy of the current frame/region pixels. */
export function framePixels(core, memory) {
    return new Uint8Array(memory.buffer, core.frame_ptr(), core.frame_len()).slice();
}

/** A deterministic raw 8x16 test font: glyph g has row r = (g + r) & 0xff. */
export function testFont8x16() {
    const f = new Uint8Array(256 * 16);
    for (let g = 0; g < 256; g++) for (let r = 0; r < 16; r++) f[g * 16 + r] = (g + r * 37) & 0xff;
    return f;
}

// Shared loader for Node-side tests of the WASM core.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WASM_DIR = process.env.ENIG_TERM_WASM_DIR ?? path.join(here, '..', 'build', 'wasm');

export const ESC = String.fromCharCode(0x1b);
export const CSI = ESC + '[';
export const ST = ESC + '\\';

/** Latin-1 string to bytes (every char code 0..255 maps to one byte). */
export function bytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}

let n = 0;
/**
 * Load the core. `fresh` imports a separate copy of the glue (its own
 * instance), for tests that trap the WASM on purpose.
 */
export async function loadCore({ fresh = false } = {}) {
    const url = new URL('file://' + path.join(WASM_DIR, 'enig_term_core.js'));
    if (fresh) url.search = `?n=${++n}`;
    const glue = await import(url.href);
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

export const FONT_DIR = path.join(here, '..', 'fonts');
/** Amiga fonts installed for tests (npm run fonts:amiga), or null. */
export const AMIGA_FONT_DIR = fs.existsSync(path.join(here, 'amiga-fonts', 'manifest.json')) ? path.join(here, 'amiga-fonts') : null;

/** One of our PC fonts (fonts/pc/<codepage>-8x<height>.psf). */
export function pcFont(cp = 'cp437', h = 16) {
    return new Uint8Array(fs.readFileSync(path.join(FONT_DIR, 'pc', `${cp}-8x${h}.psf`)));
}

/** An installed Amiga font for SyncTERM slot 37-42, or null when none are installed. */
export function amigaFont(slot, h = 16) {
    if (!AMIGA_FONT_DIR) return null;
    const m = JSON.parse(fs.readFileSync(path.join(AMIGA_FONT_DIR, 'manifest.json'), 'utf8'));
    const f = m.slots[slot]?.files?.[h];
    return f ? new Uint8Array(fs.readFileSync(path.join(AMIGA_FONT_DIR, f))) : null;
}

/** A core with CP437 in slot 0 (the engine has no fonts of its own), plus `extra` {slot: bytes}. */
export function withFonts(core, extra = {}) {
    const h = core.mode_font_height();
    core.load_font(0, 'Codepage 437 English', pcFont('cp437', h));
    for (const [slot, data] of Object.entries(extra)) core.load_font(Number(slot), `slot ${slot}`, data);
    return core;
}

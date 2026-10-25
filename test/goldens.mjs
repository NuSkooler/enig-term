// Golden engine frames: SHA-256 of the full RGBA frame the core renders for
// each fixture. The same WASM must produce the same bytes in Node and in every
// browser; a change here means the engine's output changed (review the
// screenshots, then regenerate with: node test/goldens.mjs --write).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCore, framePixels } from './core-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_FILE = path.join(here, 'goldens.json');
export const FIXTURES = [
    { name: 'cp437-testcard', file: 'cp437-testcard.ans', mode: 'stream' },
    { name: 'sauce-ice-9px', file: 'sauce-ice-9px.ans', mode: 'sauce' },
    { name: 'amiga-topaz-latin1', file: 'amiga-topaz-latin1.ans', mode: 'stream' },
];

export async function computeGoldens() {
    const { Core, memory } = await loadCore();
    const out = {};
    for (const f of FIXTURES) {
        const c = new Core(80, 25, 'ansi');
        const data = fs.readFileSync(path.join(here, 'fixtures', f.file));
        if (f.mode === 'sauce') c.load_sauce_art(data);
        else c.feed(data);
        c.set_blink(true);
        c.render(true);
        out[f.name] = { w: c.frame_width(), h: c.frame_height(), sha256: crypto.createHash('sha256').update(framePixels(c, memory)).digest('hex') };
        c.free();
    }
    return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const g = await computeGoldens();
    if (process.argv.includes('--write')) fs.writeFileSync(GOLDEN_FILE, JSON.stringify(g, null, 2) + '\n');
    console.log(JSON.stringify(g, null, 2));
}

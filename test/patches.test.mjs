// The icy_tools patch is the only place a font could creep back into the
// WASM or a panic could come from a missing one. These checks read the patch
// itself; its own Rust test (run with `cargo test -p icy_engine
// --no-default-features --lib bgi_fonts_absent` in build/icy_tools) covers
// the behaviour.
// Run: node --test test/patches.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'patches', 'icy_tools');
const patches = fs.readdirSync(dir).filter(f => f.endsWith('.patch'));
const added = f =>
    fs
        .readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(l => l.startsWith('+') && !l.startsWith('+++'));

test('the BGI font patch leaves the stroke fonts out and does not panic without them', () => {
    assert.deepEqual(patches, ['0001-bgi-fonts-follow-embedded-fonts.patch']);
    const lines = added(patches[0]);
    const loads = lines.filter(l => /Font::load\(/.test(l));
    assert.equal(loads.length, 11, 'all 11 stroke fonts');
    for (const l of loads) {
        assert.match(l, /font_bytes!\("fonts\/\w+\.CHR"\)/, `routed through font_bytes!: ${l}`);
        assert.doesNotMatch(l, /\.unwrap\(\)/, `an absent font must not panic: ${l}`);
    }
    assert.ok(lines.some(l => /fn empty\(\)/.test(l)), 'Font::empty exists');
    assert.ok(lines.some(l => /fn bgi_fonts_absent_do_not_panic/.test(l)), 'the Rust test ships with the patch');
});

test('no patch brings an include_bytes!/include_str! back', () => {
    for (const f of patches) for (const l of added(f)) assert.doesNotMatch(l, /include_(bytes|str)!/, l);
});

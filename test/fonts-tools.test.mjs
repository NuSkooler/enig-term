// The font tooling and the shell's font helpers: the operator's Amiga font
// fetch script (checksums, nothing written on failure), the font-selection
// scanner the terminal holds the stream with, the Amiga palettes and the
// Phase 2 config keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, FILES } from '../scripts/fetch-amiga-fonts.mjs';
import { FontSelectScan, modeHeight, AMIGA_SLOTS } from '../src/fonts.ts';
import { amigaPalette, AMIGA_PALETTE_NAMES } from '../src/palettes.ts';
import { sanitize, resolve, DEFAULTS, USER_KEYS } from '../src/config.ts';
import { AMIGA_FONT_DIR } from './core-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'scripts', 'fetch-amiga-fonts.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'enig-term-fonts-'));

/** A mirror of the source tree with the given file contents. */
function mirror(contents) {
    const dir = tmp();
    for (const [rel, data] of Object.entries(contents)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), data);
    }
    return dir;
}

test('fetch-amiga-fonts: a checksum mismatch fails before anything is written', async () => {
    const fake = Object.fromEntries(Object.keys(FILES).map(rel => [rel, Buffer.alloc(rel === 'README' ? 100 : 4096, 0x55)]));
    const src = mirror(fake);
    await assert.rejects(build({ from: src }), /checksum mismatch for README/);
    const out = path.join(tmp(), 'amiga');
    const r = spawnSync(process.execPath, [SCRIPT, '--from', src, '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /checksum mismatch/);
    assert.match(r.stderr, /nothing was written/);
    assert.equal(fs.existsSync(out), false);
});

test('fetch-amiga-fonts: one tampered font among good files still fails', { skip: !AMIGA_FONT_DIR && 'needs npm run fonts:amiga' }, async () => {
    const contents = { README: fs.readFileSync(path.join(AMIGA_FONT_DIR, 'README-amigafonts.txt')) };
    const m = JSON.parse(fs.readFileSync(path.join(AMIGA_FONT_DIR, 'manifest.json'), 'utf8'));
    for (const e of Object.values(m.slots)) contents[e.source] = fs.readFileSync(path.join(AMIGA_FONT_DIR, e.files[16])).subarray(32);
    // Untampered, the mirror rebuilds the same files.
    const ok = await build({ from: mirror(contents) });
    assert.deepEqual(Object.keys(ok.manifest.slots), ['37', '38', '39', '40', '41', '42']);
    assert.deepEqual(Buffer.from(ok.files['topaz-8x16.psf']), fs.readFileSync(path.join(AMIGA_FONT_DIR, 'topaz-8x16.psf')));
    const tampered = Buffer.from(contents['raw/Topaz_a1200_v1.0.raw']);
    tampered[100] ^= 1;
    const bad = { ...contents, 'raw/Topaz_a1200_v1.0.raw': tampered };
    await assert.rejects(build({ from: mirror(bad) }), /checksum mismatch for raw\/Topaz_a1200_v1\.0\.raw/);
});

// The entry-point checks compared paths in ways Windows could not resolve
// (fetch-amiga-fonts failed on import; build-fonts silently did nothing), and
// a symlinked script never matched. Each case is run as a command.
const BUILD_FONTS = path.join(here, '..', 'scripts', 'build-fonts.mjs');
const runs = {
    // --help exits 0 and writes nothing.
    'fetch-amiga-fonts': [SCRIPT, ['--help'], r => {
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /install the Amiga fonts/);
    }],
    // A file that is not the font pack fails its checksum before anything is written.
    'build-fonts': [BUILD_FONTS, [fileURLToPath(import.meta.url)], r => {
        assert.equal(r.status, 1, r.stderr);
        assert.match(r.stderr, /build-fonts: font pack SHA-256 mismatch/);
    }],
};

for (const [name, [script, args, check]] of Object.entries(runs)) {
    test(`${name}: runs as a command by a relative path`, () => {
        // From test/, so the path stays relative even when the temp directory is on another drive.
        check(spawnSync(process.execPath, [path.relative(here, script), ...args], { cwd: here, encoding: 'utf8' }));
    });

    test(`${name}: runs as a command through a symlink`, t => {
        const cwd = tmp();
        try {
            fs.symlinkSync(script, path.join(cwd, 'link.mjs'));
        } catch (e) {
            if (e.code === 'EPERM') return t.skip('symlinks need Developer Mode or admin on Windows');
            throw e;
        }
        check(spawnSync(process.execPath, ['link.mjs', ...args], { cwd, encoding: 'utf8' }));
    });
}

test('fetch-amiga-fonts: bad usage exits 2', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--kickstart', '3'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
});

test('font-select scanner: finds CSI Ps1 ; Ps2 SP D across chunks, ignores look-alikes', () => {
    const scan = new FontSelectScan();
    const found = [];
    const feed = s => {
        for (const ch of s) {
            const r = scan.step(ch.charCodeAt(0));
            if (r) found.push(r);
        }
    };
    feed('\x1b[0;4');
    feed('2 D text \x1b[1;24 D \x1b[ D \x1b[5D \x1b[0;37 E \x1b[?0;42 D \x1b[42 D');
    assert.deepEqual(found, [[0, 42], [1, 24], [0, 0], [42, 0]]);
});

test('mode height: as the core decides it', () => {
    assert.deepEqual([25, 24, 32, 28, 43, 50].map(modeHeight), [16, 16, 16, 14, 14, 8]);
    assert.deepEqual([...AMIGA_SLOTS], [37, 38, 39, 40, 41, 42]);
});

test('Amiga palettes: NComm (sourced, ANSI order) and Term 4.8, 12-bit values times 17', () => {
    const hex = p => Array.from({ length: 16 }, (_, i) => '#' + Array.from(p.subarray(i * 3, i * 3 + 3), v => v.toString(16).padStart(2, '0')).join(''));
    assert.deepEqual(hex(amigaPalette('ncomm')), [
        '#000000', '#cc0000', '#00bb00', '#bbaa00', '#0000cc', '#bb00bb', '#00dddd', '#dddddd',
        '#666666', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
    ]);
    assert.deepEqual(hex(amigaPalette('term-ega')).slice(0, 8), ['#000000', '#aa0000', '#00aa00', '#aa6600', '#0000aa', '#aa00aa', '#00aaaa', '#bbbbbb']);
    assert.deepEqual(AMIGA_PALETTE_NAMES, ['ncomm', 'term-ega']);
});

test('config: Phase 2 keys (profile auto, font directories, Amiga look) validate; v1 stays compatible', () => {
    const warn = [];
    const o = sanitize(
        { profile: 'amiga', fonts: '/static/fonts/', amigaFonts: false, amigaPalette: 'term-ega', amigaAspect: '2.2', amigaRows: 32, amigaIce: 'on', amigaBlink: false, amigaCursor: 'host', amigaFont: 40 },
        m => warn.push(m),
    );
    assert.deepEqual(o, { profile: 'amiga', fonts: '/static/fonts/', amigaFonts: '', amigaPalette: 'term-ega', amigaAspect: 2.2, amigaRows: 32, amigaIce: true, amigaBlink: false, amigaCursor: 'host', amigaFont: 40 });
    assert.deepEqual(warn, []);
    sanitize({ profile: 'c64', amigaPalette: 'x', amigaAspect: 9, amigaRows: 5, amigaFont: 12, amigaCursor: 'bar' }, m => warn.push(m));
    assert.equal(warn.length, 6);
    assert.equal(DEFAULTS.profile, 'auto');
    assert.deepEqual([DEFAULTS.fonts, DEFAULTS.amigaFonts, DEFAULTS.amigaAspect, DEFAULTS.amigaRows, DEFAULTS.amigaIce, DEFAULTS.amigaBlink], ['fonts/', 'fonts/amiga/', 'pal', null, false, true]);
    // A Phase 1 config ("profile": "pc") now locks the PC look, as it did then.
    assert.equal(resolve({ config: sanitize({ version: 1, profile: 'pc' }) }).profile, 'pc');
    // The user may pick a profile unless the config locks it.
    assert.ok(USER_KEYS.includes('profile'));
    assert.equal(resolve({ config: { lock: ['profile'] }, user: { profile: 'amiga' } }).profile, 'auto');
    assert.equal(resolve({ user: { profile: 'amiga' } }).profile, 'amiga');
});

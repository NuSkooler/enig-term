#!/usr/bin/env node
// enig-term: install the Amiga fonts (SyncTERM font slots 37-42).
//
// enig-term does not ship Amiga fonts. This script downloads them for an
// operator, checks each file's SHA-256 against the values pinned below,
// converts them to the PSF2 files enig-term loads, and writes them with a
// manifest into the directory enig-term reads them from: fonts/amiga/ next
// to enig-term.js (config.json "amigaFonts" moves it). No root needed; Node 18+.
//
//   cd /path/to/enig-term          # the directory holding enig-term.js
//   node tools/fetch-amiga-fonts.mjs
//
// Options:
//   --out DIR        where to write (default: ./fonts/amiga)
//   --kickstart 1|2  Topaz and Topaz Plus from Kickstart 1.x (A500) or 2.x+ (A1200); default 2
//   --from URL|DIR   fetch the source files from a mirror (same layout) instead of GitHub
//   --dry-run        download and verify only
//
// Source: TrueSchool's "Multi Platform Amiga Fonts" v1.02 by dMG/t!s^dS!,
// https://github.com/rewtnull/amigafonts at commit d42987535d94..., released
// under the GPL with the font exception (GPL-FE). Its README also states:
// "Topaz is (c) AmigaInc." (the TrueSchool versions are remakes), and names
// the original authors of P0T-NOoDLE, MicroKnight and mO'sOul. The README is
// installed next to the fonts. Whether you may serve these fonts on your
// site is your call; enig-term only points to them.
//
// Exit status: 0 done, 1 a download or checksum failed (nothing written), 2 bad usage.
// This file is self-contained (BSD-2-Clause, part of enig-term).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SOURCE = {
    name: 'Multi Platform Amiga Fonts v1.02 (TrueSchool)',
    repo: 'https://github.com/rewtnull/amigafonts',
    commit: 'd42987535d94ebbfb51e64fee76f9974c6ae145a',
    base: 'https://raw.githubusercontent.com/rewtnull/amigafonts/d42987535d94ebbfb51e64fee76f9974c6ae145a/',
    license: 'GPL with font exception (GPL-FE), per the source README; Topaz (c) Amiga Inc., remade by dMG/t!s^dS!',
};

/** Pinned files: path in the source tree -> SHA-256. */
export const FILES = {
    README: 'eb2a92ecf5d371c786a6505aa8f6784b3f55faa2c8d9b323f45ead4124edccae',
    "raw/P0T-NOoDLE_v1.0.raw": '0c6d62f679b5cc8e492f3f095478fc90db453362f1221e28d75a13e1a3297b56',
    "raw/mO'sOul_v1.0.raw": '91d201d377de0d06845633e687406e149ef765b6e92d49af534e9993a53b7960',
    'raw/MicroKnightPlus_v1.0.raw': 'fc4f7b0926c90a1f5d53e2a890a9eb270877880537976d7aa8179c273013af97',
    'raw/MicroKnight_v1.0.raw': 'ff224dab280b2b14860f0ec1bcca269db97d1c028068499af575f99c90d3d8c2',
    'raw/TopazPlus_a1200_v1.0.raw': '60e9f94ca39ee4a688920c6cc96496af0ad10fa21b3cc7971aae18383d8a1437',
    'raw/TopazPlus_a500_v1.0.raw': '57898a97bddbe3186483ce57f0f3388422aee5b66782fa62a81219d8de1dbd00',
    'raw/Topaz_a1200_v1.0.raw': '82ba4991ef753b4788f089885d824cc5509ddd179aa940d550e4a67c1eb6cb09',
    'raw/Topaz_a500_v1.0.raw': 'a2eb9796b82bcad885211e14684960352aaaca559ea82cb3cbd7dec3fdbaafb0',
};

/** SyncTERM slot -> [name, source file (ks 2), source file (ks 1), output base name]. */
const SLOTS = {
    37: ['P0T NOoDLE (Amiga)', "raw/P0T-NOoDLE_v1.0.raw", null, 'p0t-noodle'],
    38: ["mO'sOul (Amiga)", "raw/mO'sOul_v1.0.raw", null, 'mosoul'],
    39: ['MicroKnight Plus (Amiga)', 'raw/MicroKnightPlus_v1.0.raw', null, 'microknight-plus'],
    40: ['Topaz Plus (Amiga)', 'raw/TopazPlus_a1200_v1.0.raw', 'raw/TopazPlus_a500_v1.0.raw', 'topaz-plus'],
    41: ['MicroKnight (Amiga)', 'raw/MicroKnight_v1.0.raw', null, 'microknight'],
    42: ['Topaz (Amiga)', 'raw/Topaz_a1200_v1.0.raw', 'raw/Topaz_a500_v1.0.raw', 'topaz'],
};

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

/** PSF2, 8 wide, 256 glyphs, no Unicode table. */
function psf2(glyphs, h) {
    const out = new Uint8Array(32 + 256 * h);
    const dv = new DataView(out.buffer);
    [0x864ab572, 0, 32, 0, 256, h, h, 8].forEach((v, i) => dv.setUint32(i * 4, v, true));
    glyphs.forEach((g, i) => out.set(g, 32 + i * h));
    return out;
}

function parseArgs(argv) {
    const o = { out: path.join('fonts', 'amiga'), kickstart: '2', from: null, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const val = () => {
            if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
            return argv[++i];
        };
        if (a === '--out') o.out = val();
        else if (a === '--kickstart') o.kickstart = val();
        else if (a === '--from') o.from = val();
        else if (a === '--dry-run') o.dryRun = true;
        else if (a === '-h' || a === '--help') o.help = true;
        else throw new Error(`unknown option ${a}`);
    }
    if (!['1', '2'].includes(o.kickstart)) throw new Error('--kickstart must be 1 or 2');
    return o;
}

async function get(from, rel) {
    if (from && !/^https?:\/\//.test(from)) return new Uint8Array(fs.readFileSync(path.join(from, rel)));
    const url = new URL(rel.split('/').map(encodeURIComponent).join('/'), from ? (from.endsWith('/') ? from : from + '/') : SOURCE.base);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url.href}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
}

/**
 * Download, verify and convert. Returns { files: name -> bytes, manifest }.
 * Throws on any download or checksum failure, before anything is written.
 */
export async function build({ kickstart = '2', from = null, log = () => {} } = {}) {
    const want = new Set(['README']);
    for (const [, ks2, ks1] of Object.values(SLOTS)) want.add(kickstart === '1' && ks1 ? ks1 : ks2);
    const got = {};
    for (const rel of want) {
        const data = await get(from, rel);
        const h = sha256(data);
        if (h !== FILES[rel]) throw new Error(`checksum mismatch for ${rel}: got ${h}, expected ${FILES[rel]}`);
        log(`ok  ${rel}`);
        got[rel] = data;
    }
    const files = { 'README-amigafonts.txt': got.README };
    const manifest = {
        version: 1,
        comment: 'Amiga fonts for enig-term (SyncTERM slots 37-42), written by fetch-amiga-fonts.mjs. Not part of enig-term.',
        source: { ...SOURCE, kickstart: Number(kickstart), readme: 'README-amigafonts.txt' },
        slots: {},
        files: {},
    };
    for (const [slot, [name, ks2, ks1, base]] of Object.entries(SLOTS)) {
        const rel = kickstart === '1' && ks1 ? ks1 : ks2;
        const raw = got[rel];
        if (raw.length !== 4096) throw new Error(`${rel}: expected an 8x16 raw font`);
        // The source is drawn in "Amiga aspect": 8x8 glyphs line-doubled to
        // 8x16, which is what 25-row screens use. The 8-row (50-line) variant
        // keeps the even rows (a few "Plus" glyphs have real 16-row detail,
        // which that loses).
        const g16 = Array.from({ length: 256 }, (_, i) => raw.subarray(i * 16, i * 16 + 16));
        const g8 = g16.map(g => Uint8Array.from({ length: 8 }, (_, r) => g[2 * r]));
        const slotFiles = {};
        for (const [h, glyphs] of [[16, g16], [8, g8]]) {
            const fname = `${base}-8x${h}.psf`;
            const data = psf2(glyphs, h);
            files[fname] = data;
            manifest.files[fname] = { sha256: sha256(data), bytes: data.length, source: rel };
            slotFiles[h] = fname;
        }
        manifest.slots[slot] = { name, codepage: 'iso-8859-1', files: slotFiles, source: rel, license: 'GPL-FE (see README-amigafonts.txt)' };
    }
    files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n');
    return { files, manifest };
}

async function main() {
    let o;
    try {
        o = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`fetch-amiga-fonts: ${e.message} (see --help)`);
        process.exit(2);
    }
    if (o.help) {
        console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 25).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
        return;
    }
    let res;
    try {
        res = await build({ kickstart: o.kickstart, from: o.from, log: m => console.log(m) });
    } catch (e) {
        console.error(`fetch-amiga-fonts: ${e.message}`);
        console.error('fetch-amiga-fonts: nothing was written');
        process.exit(1);
    }
    if (o.dryRun) {
        console.log('dry run: verified, nothing written');
        return;
    }
    fs.mkdirSync(o.out, { recursive: true });
    // The manifest last: enig-term only sees a complete set.
    const names = Object.keys(res.files).filter(n => n !== 'manifest.json');
    for (const n of [...names, 'manifest.json']) {
        const tmp = path.join(o.out, `.${n}.tmp`);
        fs.writeFileSync(tmp, res.files[n]);
        fs.renameSync(tmp, path.join(o.out, n));
    }
    console.log(`wrote ${names.length + 1} files to ${o.out}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) await main();

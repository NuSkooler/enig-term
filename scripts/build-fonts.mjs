#!/usr/bin/env node
// Builds enig-term's PC fonts from VileR's Ultimate Oldschool PC Font Pack
// (int10h.org, CC BY-SA 4.0) into fonts/: one PSF2 file per code page and
// cell height, plus fonts/manifest.json (SyncTERM slot -> files, code page,
// source, licence). The output is committed, so a normal build needs no
// network; run this only to regenerate it:
//
//   node scripts/build-fonts.mjs [path/to/oldschool_pc_font_pack_v2.2_FULL.zip]
//
// Without a path the pack is downloaded (once) into build/font-src/ and its
// SHA-256 checked. Glyphs come from the "PxPlus" TrueType fonts (pixel
// outlines, Unicode-mapped), sampled at their native pixel grid, so every
// code page the pack's repertoire covers can be built from one design:
//   16-row cells: IBM VGA 8x16; 14-row: IBM VGA 8x14; 8-row: IBM VGA 9x8
//   (its first 8 columns; the 9th is the VGA's duplicated column).
// C0 controls and DEL are drawn with the CP437 graphics in every code page,
// as DOS code page fonts do. Code pages the pack cannot cover are left out
// and the slot is refused by the terminal.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readZip } from './fonts/zip.mjs';
import { pixelFont } from './fonts/sfnt.mjs';
import { writePsf2 } from './fonts/psf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'fonts');

export const PACK = {
    name: 'The Ultimate Oldschool PC Font Pack',
    version: '2.2',
    author: 'VileR',
    url: 'https://int10h.org/oldschool-pc-fonts/download/oldschool_pc_font_pack_v2.2_FULL.zip',
    home: 'https://int10h.org/oldschool-pc-fonts/',
    sha256: '21b3c0a3770ef0afc46564760613d7b078f4fcc9ed93db4b829a440b68822e08',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
};

const PX = 'ttf - Px (pixel outline)/';
const SOURCES = {
    16: { files: ['Px437_IBM_VGA_8x16.ttf', 'PxPlus_IBM_VGA_8x16.ttf'], name: 'IBM VGA 8x16', w: 8 },
    14: { files: ['Px437_IBM_VGA_8x14.ttf', 'PxPlus_IBM_VGA_8x14.ttf'], name: 'IBM VGA 8x14', w: 8 },
    8: { files: ['Px437_IBM_VGA_9x8.ttf', 'PxPlus_IBM_VGA_9x8.ttf'], name: 'IBM VGA 9x8 (first 8 columns)', w: 9 },
};
/** DOS code pages: draw every glyph CP437 has exactly as the CP437 font does. */
const DOS = new Set(['cp437', 'cp850', 'cp865', 'cp866', 'cp1125']);
/**
 * Px437 is the CP437 repertoire as the ROM drew it (it matches the pack's
 * Windows bitmap fonts); PxPlus adds the rest of Unicode and redraws a few
 * glyphs (real Greek letters for CP437's alpha, sigma ...). So: Px437 first,
 * except for Greek and Cyrillic letters outside the DOS code pages.
 */
function glyphFor(cp, u, px437, pxplus) {
    const greekOrCyrillic = u >= 0x370 && u < 0x500;
    if (DOS.has(cp) || !greekOrCyrillic) return px437.glyph(u) ?? pxplus.glyph(u);
    return pxplus.glyph(u) ?? px437.glyph(u);
}

// SyncTERM font slots (CTerm manual, CSI Ps1 ; Ps2 SP D, Table 3).
// cp: the code page to build; substitute: the slot names a style variant
// (thin, swiss, (b)/(c), wide) that we draw with the IBM VGA design;
// refused: why the slot has no font.
export const SLOTS = [
    [0, 'Codepage 437 English', 'cp437'],
    [1, 'Codepage 1251 Cyrillic, (swiss)', 'cp1251', 'swiss'],
    [2, 'Russian koi8-r', 'koi8-r'],
    [3, 'ISO-8859-2 Central European', 'iso-8859-2'],
    [4, 'ISO-8859-4 Baltic wide (VGA 9bit mapped)', 'iso-8859-4', 'wide, 9bit mapped'],
    [5, 'Codepage 866 (c) Russian', 'cp866', '(c)'],
    [6, 'ISO-8859-9 Turkish', 'iso-8859-9'],
    [7, 'haik8 codepage (use only with armscii8 screenmap)', null, null, 'no Armenian glyphs in the licensed font set'],
    [8, 'ISO-8859-8 Hebrew', 'iso-8859-8'],
    [9, 'Ukrainian font koi8-u', 'koi8-u'],
    [10, 'ISO-8859-15 West European, (thin)', 'iso-8859-15', 'thin'],
    [11, 'ISO-8859-4 Baltic (VGA 9bit mapped)', 'iso-8859-4', '9bit mapped'],
    [12, 'Russian koi8-r (b)', 'koi8-r', '(b)'],
    [13, 'ISO-8859-4 Baltic wide', 'iso-8859-4', 'wide'],
    [14, 'ISO-8859-5 Cyrillic', 'iso-8859-5'],
    [15, 'ARMSCII-8 Character set', null, null, 'no Armenian glyphs in the licensed font set'],
    [16, 'ISO-8859-15 West European', 'iso-8859-15'],
    [17, 'Codepage 850 Multilingual Latin I, (thin)', 'cp850', 'thin'],
    [18, 'Codepage 850 Multilingual Latin I', 'cp850'],
    [19, 'Codepage 865 Norwegian, (thin)', 'cp865', 'thin'], // the manual says "885"
    [20, 'Codepage 1251 Cyrillic', 'cp1251'],
    [21, 'ISO-8859-7 Greek', 'iso-8859-7'],
    [22, 'Russian koi8-r (c)', 'koi8-r', '(c)'],
    [23, 'ISO-8859-4 Baltic', 'iso-8859-4'],
    [24, 'ISO-8859-1 West European', 'iso-8859-1'],
    [25, 'Codepage 866 Russian', 'cp866'],
    [26, 'Codepage 437 English, (thin)', 'cp437', 'thin'],
    [27, 'Codepage 866 (b) Russian', 'cp866', '(b)'],
    [28, 'Codepage 865 Norwegian', 'cp865'],
    [29, 'Ukrainian font cp866u', 'cp1125'],
    [30, 'ISO-8859-1 West European, (thin)', 'iso-8859-1', 'thin'],
    [31, 'Codepage 1131 Belarusian, (swiss)', null, null, 'no code page 1131 table to build it from'],
    [32, 'Commodore 64 (UPPER)', null, null, 'no licensed Commodore font'],
    [33, 'Commodore 64 (Lower)', null, null, 'no licensed Commodore font'],
    [34, 'Commodore 128 (UPPER)', null, null, 'no licensed Commodore font'],
    [35, 'Commodore 128 (Lower)', null, null, 'no licensed Commodore font'],
    [36, 'Atari', null, null, 'no licensed Atari font'],
    // 37-42 are the Amiga fonts (the operator's, see fonts/amiga/). 43-45 are
    // built into current CTerm; DCS-loaded fonts start above them, at 46.
    [43, 'Prestel', null, null, 'no licensed Prestel font'],
    [44, 'Atari ST', null, null, 'no licensed Atari ST font'],
    [45, 'RIPterm', null, null, 'no licensed RIPterm font'],
];

/** CP437's graphics for 0x00-0x1F and 0x7F (0x00 is blank). */
const CP437_C0 = [0x0000, ...'☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼'].map(c => (typeof c === 'number' ? c : c.codePointAt(0)));
const CP437_DEL = 0x2302;
/** Invisible format characters that are correctly drawn blank. */
const INVISIBLE = new Set([0x00a0, 0x00ad, 0x200e, 0x200f]);
/** Most glyphs a code page may lack and still be built (blank, listed in the manifest). */
const MAX_MISSING = 2;

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

async function loadPack(arg) {
    let buf;
    if (arg) buf = fs.readFileSync(arg);
    else {
        const cache = path.join(ROOT, 'build', 'font-src', path.basename(PACK.url));
        if (!fs.existsSync(cache)) {
            console.log(`downloading ${PACK.url}`);
            const r = await fetch(PACK.url);
            if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
            fs.mkdirSync(path.dirname(cache), { recursive: true });
            fs.writeFileSync(cache, new Uint8Array(await r.arrayBuffer()));
        }
        buf = fs.readFileSync(cache);
    }
    const got = sha256(buf);
    if (got !== PACK.sha256) throw new Error(`font pack SHA-256 mismatch: got ${got}, want ${PACK.sha256}`);
    return readZip(new Uint8Array(buf));
}

async function main() {
    const zip = await loadPack(process.argv[2]);
    const member = name => {
        const m = zip.get(name);
        if (!m) throw new Error(`font pack has no ${name}`);
        return m();
    };
    const tables = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'fonts', 'codepages.json'), 'utf8')).tables;
    const fonts = Object.fromEntries(
        Object.entries(SOURCES).map(([h, s]) => [h, s.files.map(f => pixelFont(member(PX + f), s.w, Number(h)))]),
    );

    fs.rmSync(path.join(OUT, 'pc'), { recursive: true, force: true });
    fs.mkdirSync(path.join(OUT, 'pc'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'LICENSE'), member('LICENSE.TXT'));

    const files = {};
    const built = {};
    for (const cp of [...new Set(SLOTS.map(s => s[2]).filter(Boolean))]) {
        const table = tables[cp];
        if (!table) throw new Error(`no code page table ${cp}`);
        built[cp] = { files: {}, missing: [] };
        for (const h of [8, 14, 16]) {
            const [px437, pxplus] = fonts[h];
            const missing = [];
            const glyphs = table.map((u, b) => {
                let cp2 = u;
                if (b < 0x20) cp2 = CP437_C0[b];
                else if (b === 0x7f) cp2 = CP437_DEL;
                else if (u !== null && u >= 0x80 && u < 0xa0) cp2 = null; // C1 controls
                if (cp2 === null || cp2 === 0) return new Uint8Array(h);
                const g = glyphFor(cp, cp2, px437, pxplus);
                if (g) return g;
                if (!INVISIBLE.has(cp2)) missing.push(`0x${b.toString(16)} U+${cp2.toString(16).toUpperCase().padStart(4, '0')}`);
                return new Uint8Array(h);
            });
            if (missing.length > MAX_MISSING) throw new Error(`${cp} ${h}: ${missing.length} glyphs missing`);
            built[cp].missing = missing;
            const name = `pc/${cp}-8x${h}.psf`;
            const data = writePsf2(glyphs, h);
            fs.writeFileSync(path.join(OUT, name), data);
            files[name] = { sha256: sha256(data), bytes: data.length, codepage: cp, height: h, source: SOURCES[h].name };
            built[cp].files[h] = name;
        }
    }

    const slots = {};
    for (const [slot, name, cp, substitute, refused] of SLOTS) {
        slots[slot] = cp
            ? {
                  name,
                  codepage: cp,
                  files: built[cp].files,
                  design: 'IBM VGA',
                  ...(substitute ? { substitute: `drawn in the IBM VGA design, not the ${substitute} variant` } : {}),
                  ...(built[cp].missing.length ? { blank: built[cp].missing } : {}),
                  license: PACK.license,
              }
            : { name, refused };
    }
    const manifest = {
        version: 1,
        comment: 'enig-term PC fonts, generated by scripts/build-fonts.mjs. Slots 37-42 (Amiga) are the operator\'s: see fonts/amiga/manifest.json (written by the Amiga font fetch script). DCS-loaded fonts use slots 46-255.',
        source: { ...PACK, files: Object.values(SOURCES).flatMap(s => s.files.map(f => PX + f)) },
        firstLoadableSlot: 46,
        slots,
        files,
    };
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const total = Object.values(files).reduce((n, f) => n + f.bytes, 0);
    console.log(`fonts: ${Object.keys(files).length} files, ${total} bytes; slots built: ${Object.values(slots).filter(s => s.codepage).length}`);
    for (const [cp, b] of Object.entries(built)) if (b.missing.length) console.log(`  ${cp}: blank ${b.missing.join(', ')}`);
}

// pathToFileURL, not `file://${argv[1]}`: a Windows path never matched, so
// main() silently did not run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(e => {
        console.error(`build-fonts: ${e.message}`);
        process.exit(1);
    });
}

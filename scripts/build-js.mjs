// Bundle the TS shell with esbuild and assemble dist/ (layout documented in
// README "dist/ layout"; ENiGMA's /_enig/ws-term/ route serves it as is).
import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const wasm = path.join(root, 'build', 'wasm', 'enig_term_core_bg.wasm');
const zwasm = path.join(root, 'build', 'wasm-zmodem', 'enig_term_zmodem_bg.wasm');
if (!fs.existsSync(wasm) || !fs.existsSync(zwasm)) {
    console.error('build/wasm or build/wasm-zmodem missing: run npm run build:wasm first');
    process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// The bundle asks for the WASM with this hash in the query string, so a cached
// bundle and a different WASM never pair up (dist file names carry no hash).
const wasmHash = crypto.createHash('sha256').update(fs.readFileSync(wasm)).digest('hex').slice(0, 16);
// Same for the font manifest (its entries carry their own hashes).
const fontsDir = path.join(root, 'fonts');
const fontManifest = JSON.parse(fs.readFileSync(path.join(fontsDir, 'manifest.json'), 'utf8'));
const fontsHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(fontsDir, 'manifest.json'))).digest('hex').slice(0, 16);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const hashOf = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, f))).digest('hex').slice(0, 16);
const common = {
    bundle: true,
    format: 'esm',
    target: ['es2022', 'safari16'],
    minify: true,
    sourcemap: process.env.ENIG_TERM_SOURCEMAP === '1',
    legalComments: 'none',
    logLevel: 'warning',
};

// Loaded on demand, in this order of dependence: the Ogg decoders (only
// where the browser cannot decode Ogg Vorbis/Opus itself), then the audio
// engine (the first time a board uses audio), then the main bundle. Each is
// asked for with ?v=<its hash>, stamped into the one that loads it.
await build({
    ...common,
    entryPoints: [path.join(root, 'src', 'audio', 'ogg.ts')],
    outfile: path.join(dist, 'enig-term-ogg.js'),
    banner: { js: `/* enig-term ${pkg.version} Ogg decoders | includes libvorbis, libogg, libopus (BSD-3-Clause) and wasm-audio-decoders (MIT), see NOTICE */` },
});
await build({
    ...common,
    entryPoints: [path.join(root, 'src', 'audio', 'engine.ts')],
    outfile: path.join(dist, 'enig-term-audio.js'),
    define: { __ENIG_TERM_OGG_HASH__: JSON.stringify(hashOf('enig-term-ogg.js')) },
    banner: { js: `/* enig-term ${pkg.version} audio engine | BSD-2-Clause */` },
});

// The transfer engines (X/YModem, and ZModem with its WASM), imported the
// first time a transfer starts.
fs.copyFileSync(zwasm, path.join(dist, 'enig-term-zmodem.wasm'));
await build({
    ...common,
    entryPoints: [path.join(root, 'src', 'transfer', 'index.ts')],
    outfile: path.join(dist, 'enig-term-xfer.js'),
    define: { __ENIG_TERM_ZMODEM_HASH__: JSON.stringify(hashOf('enig-term-zmodem.wasm')) },
    banner: { js: `/* enig-term ${pkg.version} file transfers | BSD-2-Clause | includes icy_net's ZModem (icy_board, Apache-2.0), see NOTICE */` },
    metafile: true,
}).then(r => fs.writeFileSync(path.join(root, 'build', 'meta-xfer.json'), JSON.stringify(r.metafile)));

await build({
    entryPoints: [path.join(root, 'src', 'main.ts')],
    metafile: true,
    bundle: true,
    format: 'esm',
    target: ['es2022', 'safari16'],
    minify: true,
    sourcemap: process.env.ENIG_TERM_SOURCEMAP === '1',
    outfile: path.join(dist, 'enig-term.js'),
    define: {
        __ENIG_TERM_VERSION__: JSON.stringify(pkg.version),
        __ENIG_TERM_WASM_HASH__: JSON.stringify(wasmHash),
        __ENIG_TERM_FONTS_HASH__: JSON.stringify(fontsHash),
        __ENIG_TERM_AUDIO_HASH__: JSON.stringify(hashOf('enig-term-audio.js')),
        __ENIG_TERM_XFER_HASH__: JSON.stringify(hashOf('enig-term-xfer.js')),
    },
    legalComments: 'none',
    banner: { js: `/* enig-term ${pkg.version} | BSD-2-Clause | includes icy_tools (MIT OR Apache-2.0), see NOTICE */` },
    logLevel: 'warning',
}).then(r => fs.writeFileSync(path.join(root, 'build', 'meta-main.json'), JSON.stringify(r.metafile)));
fs.copyFileSync(wasm, path.join(dist, 'enig_term_core_bg.wasm'));
for (const f of ['index.html', 'config.example.json', 'LICENSE', 'LICENSE-APACHE-2.0', 'NOTICE']) fs.copyFileSync(path.join(root, f), path.join(dist, f));

// fonts/: the PC fonts and their manifest, licence and README. Never an
// amiga/ directory: Amiga fonts are the operator's (tools/fetch-amiga-fonts.mjs).
fs.mkdirSync(path.join(dist, 'fonts', 'pc'), { recursive: true });
for (const f of ['manifest.json', 'LICENSE', 'README.txt']) fs.copyFileSync(path.join(fontsDir, f), path.join(dist, 'fonts', f));
for (const [name, info] of Object.entries(fontManifest.files)) {
    const b = fs.readFileSync(path.join(fontsDir, name));
    if (crypto.createHash('sha256').update(b).digest('hex') !== info.sha256) throw new Error(`fonts/${name} does not match its manifest`);
    fs.writeFileSync(path.join(dist, 'fonts', name), b);
}
if (fs.existsSync(path.join(dist, 'fonts', 'amiga'))) throw new Error('dist/fonts/amiga must not exist');
fs.mkdirSync(path.join(dist, 'tools'), { recursive: true });
fs.copyFileSync(path.join(root, 'scripts', 'fetch-amiga-fonts.mjs'), path.join(dist, 'tools', 'fetch-amiga-fonts.mjs'));
fs.writeFileSync(path.join(dist, 'credits.html'), creditsPage(pkg.version, fontManifest));
// Never ship a config.json: an operator's copy in the install dir would be
// overridden (or, worse, would override the board's generated one).
if (fs.existsSync(path.join(dist, 'config.json'))) throw new Error('dist/config.json must not exist');

function creditsPage(version, m) {
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const pcRows = Object.entries(m.slots).map(([slot, e]) => {
        const what = e.refused ? `<td colspan="2" class="no">not available: ${esc(e.refused)}</td>` : `<td>IBM VGA, ${esc(e.codepage)}${e.substitute ? ` <span class="note">(${esc(e.substitute)})</span>` : ''}</td><td>${esc(e.license)}</td>`;
        return [Number(slot), `<tr><td>${slot}</td><td>${esc(e.name)}</td>${what}</tr>`];
    });
    const amigaRows = [37, 38, 39, 40, 41, 42].map(n => [n, `<tr><td>${n}</td><td>${esc(['P0T NOoDLE', "mO'sOul", 'MicroKnight Plus', 'Topaz Plus', 'MicroKnight', 'Topaz'][n - 37])} (Amiga)</td><td colspan="2">installed by the site operator, if at all (see below)</td></tr>`]);
    const rows = [...pcRows, ...amigaRows]
        .sort((a, b) => a[0] - b[0])
        .map(r => r[1])
        .join('\n');
    const loadable = `<tr><td>${m.firstLoadableSlot}-255</td><td colspan="3">loaded by the board (DCS CTerm:Font), if at all</td></tr>`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>enig-term credits</title>
<style>
  :root { --bg: #0b0b0e; --fg: #d6d6de; --dim: #9a9aa6; --edge: #2a2a33; --link: #8fb8ff; }
  @media (prefers-color-scheme: light) { :root { --bg: #fafafa; --fg: #1c1c22; --dim: #5a5a66; --edge: #d8d8e0; --link: #1f5fbf; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 16px; }
  a { color: var(--link); }
  h1 { font-size: 1.5em; } h2 { font-size: 1.15em; margin-top: 1.6em; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  td, th { border-bottom: 1px solid var(--edge); padding: 4px 6px; text-align: left; vertical-align: top; }
  .table { overflow-x: auto; }
  .no, .note { color: var(--dim); }
</style>
</head>
<body><main>
<h1>enig-term ${esc(version)}: credits and licences</h1>
<p>enig-term is a browser terminal for ANSI BBSes, by Bryan D. Ashby, under the
<a href="LICENSE">BSD 2-Clause licence</a>. Third-party notices: <a href="NOTICE">NOTICE</a>.</p>

<h2>Emulation engine</h2>
<p><a href="https://github.com/mkrueger/icy_tools">icy_tools</a> (icy_engine, icy_parser_core) by Mike Krueger and
contributors, MIT OR Apache-2.0 (used under MIT), compiled to WebAssembly with its embedded fonts removed. The CRT
effect ports functions from icy_tools' crt_shader.wgsl under the same licence. Its Rust dependencies are under their
own permissive licences (Cargo.lock in the source).</p>

<h2>PC fonts</h2>
<p>From <a href="${esc(m.source.home)}">${esc(m.source.name)}</a> v${esc(m.source.version)} by ${esc(m.source.author)},
licensed <a href="${esc(m.source.licenseUrl)}">${esc(m.source.license)}</a> (<a href="fonts/LICENSE">licence text</a>,
<a href="fonts/README.txt">what was changed</a>). The terminal draws every PC code page with the IBM VGA design
(8x16, 8x14 and 8x8 cells); style variants that SyncTERM numbers separately (thin, swiss, (b), (c), wide) use the same design.
Fonts the terminal does not have are refused, not substituted.</p>
<div class="table"><table>
<tr><th>Slot</th><th>SyncTERM font</th><th>Drawn with</th><th>Licence</th></tr>
${rows}
${loadable}
</table></div>

<h2>Amiga fonts</h2>
<p>enig-term does not include Amiga fonts. A site operator may install them with <code>tools/fetch-amiga-fonts.mjs</code>,
which downloads TrueSchool's Multi Platform Amiga Fonts (dMG/t!s^dS!, released under the GPL with the font exception;
Topaz is &copy; Amiga Inc.) and records their origin in <a href="fonts/amiga/README-amigafonts.txt">fonts/amiga/</a>
(missing if the operator has not installed them).</p>

<h2>Amiga palettes</h2>
<p>The Amiga profile's colours are the values (only) of NComm 3.0/3.09's ANSI pens and of Term 4.8's EGA-style table
(Olaf Barthel); no code from either.</p>

<h2>Audio</h2>
<p>CTerm audio and "ANSI" music follow the <a href="https://syncterm.bbsdev.net/cterm.html">CTerm manual</a>; the
Synth waveforms reproduce what SyncTERM's tone generator makes. Browsers that cannot decode Ogg Vorbis or Opus
themselves load <code>enig-term-ogg.js</code>: <a href="https://github.com/eshaz/wasm-audio-decoders">wasm-audio-decoders</a>
by Ethan Halsall (MIT), which compiles <a href="https://xiph.org/vorbis/">libvorbis</a> and libogg (Xiph.Org Foundation)
and <a href="https://opus-codec.org/">libopus</a> (Xiph.Org, Skype, Octasic and others) to WebAssembly, all three
BSD-3-Clause, with Mark Adler's puff (zlib licence). Full notices: <a href="NOTICE">NOTICE</a>.</p>

<h2>File transfers</h2>
<p>ZModem is <a href="https://github.com/mkrueger/icy_board">icy_net</a>'s (crates/icy_net in icy_board) by Mike Krueger and
contributors, under the <a href="LICENSE-APACHE-2.0">Apache License 2.0</a>, compiled to WebAssembly with changes that are
listed in <a href="NOTICE">NOTICE</a> (<code>enig-term-zmodem.wasm</code>, loaded for a transfer). Its constants come from
Chuck Forsberg's ZMODEM.H (Omen Technology). XModem and YModem are enig-term's own, written from Forsberg's protocol
reference.</p>

<h2>Other</h2>
<p>The Telnet layer is ported from the Xibalba web terminal, the author's own code, relicensed under BSD-2-Clause.</p>
</main></body>
</html>
`;
}

const size = f => {
    const b = fs.readFileSync(path.join(dist, f));
    return `${f}: ${b.length} B (gzip ${zlib.gzipSync(b, { level: 9 }).length} B)`;
};
const pc437 = Object.values(fontManifest.slots[0].files).map(f => fontManifest.files[f].bytes);
console.log([size('enig-term.js'), size('enig-term-audio.js'), size('enig-term-ogg.js'), size('enig-term-xfer.js'), size('enig-term-zmodem.wasm'), size('enig_term_core_bg.wasm'), size('fonts/manifest.json'), `fonts: CP437 8x16 ${fontManifest.files['pc/cp437-8x16.psf'].bytes} B (all heights ${pc437.reduce((a, b) => a + b, 0)} B)`, `version ${pkg.version}, wasm ${wasmHash}, fonts ${fontsHash}`].join('\n'));

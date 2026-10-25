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
if (!fs.existsSync(wasm)) {
    console.error('build/wasm missing: run npm run build:wasm first');
    process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// The bundle asks for the WASM with this hash in the query string, so a cached
// bundle and a different WASM never pair up (dist file names carry no hash).
const wasmHash = crypto.createHash('sha256').update(fs.readFileSync(wasm)).digest('hex').slice(0, 16);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await build({
    entryPoints: [path.join(root, 'src', 'main.ts')],
    bundle: true,
    format: 'esm',
    target: ['es2022', 'safari16'],
    minify: true,
    sourcemap: process.env.ENIG_TERM_SOURCEMAP === '1',
    outfile: path.join(dist, 'enig-term.js'),
    define: {
        __ENIG_TERM_VERSION__: JSON.stringify(pkg.version),
        __ENIG_TERM_WASM_HASH__: JSON.stringify(wasmHash),
    },
    legalComments: 'none',
    banner: { js: `/* enig-term ${pkg.version} | BSD-2-Clause | includes icy_tools (MIT OR Apache-2.0), see NOTICE */` },
    logLevel: 'warning',
});
fs.copyFileSync(wasm, path.join(dist, 'enig_term_core_bg.wasm'));
for (const f of ['index.html', 'config.example.json', 'LICENSE', 'NOTICE']) fs.copyFileSync(path.join(root, f), path.join(dist, f));
// Never ship a config.json: an operator's copy in the install dir would be
// overridden (or, worse, would override the board's generated one).
if (fs.existsSync(path.join(dist, 'config.json'))) throw new Error('dist/config.json must not exist');

const size = f => {
    const b = fs.readFileSync(path.join(dist, f));
    return `${f}: ${b.length} B (gzip ${zlib.gzipSync(b, { level: 9 }).length} B)`;
};
console.log([size('enig-term.js'), size('enig_term_core_bg.wasm'), `version ${pkg.version}, wasm ${wasmHash}`].join('\n'));

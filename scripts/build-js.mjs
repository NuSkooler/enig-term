// Bundle the TS shell with esbuild and assemble dist/.
import { build } from 'esbuild';
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
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const res = await build({
    entryPoints: [path.join(root, 'src', 'main.ts')],
    bundle: true,
    format: 'esm',
    target: ['es2022', 'safari16'],
    minify: true,
    sourcemap: true,
    outfile: path.join(dist, 'enig-term.js'),
    metafile: true,
    logLevel: 'warning',
});
for (const f of ['index.html', 'config.json']) fs.copyFileSync(path.join(root, f), path.join(dist, f));
fs.copyFileSync(wasm, path.join(dist, 'enig_term_core_bg.wasm'));
for (const f of ['LICENSE', 'NOTICE']) fs.copyFileSync(path.join(root, f), path.join(dist, f));

const size = f => {
    const b = fs.readFileSync(path.join(dist, f));
    return `${f}: ${b.length} B (gzip ${zlib.gzipSync(b, { level: 9 }).length} B)`;
};
console.log([size('enig-term.js'), size('enig_term_core_bg.wasm')].join('\n'));
void res;

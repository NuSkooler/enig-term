// Minimal static server for dist/ (plus test/fixtures/ under /fixtures/).
// Usage: node scripts/serve.mjs [port]   (default 8090)
//
// /config.json comes from $ENIG_TERM_DEV_CONFIG or ./dev-config.json when
// either exists (both outside dist/, and dev-config.json is gitignored);
// otherwise it is a 404 and the page falls back to its host input.
// Like ENiGMA's /_enig/ws-term/ route: .wasm is application/wasm, dot files
// and empty path segments are refused.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleLog, handleUpgrade } from '../test/fake-bbs.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? process.env.PORT ?? 8090);
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.map': 'application/json',
    '.ans': 'application/octet-stream',
    '.png': 'image/png',
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/fake-bbs/log') {
        handleLog(req, res);
        return;
    }
    let p;
    try {
        p = decodeURIComponent(url.pathname);
    } catch {
        res.writeHead(400).end('bad request');
        return;
    }
    if (/\/\.|\/\//.test(p.replace(/\/$/, ''))) {
        res.writeHead(404).end('not found');
        return;
    }
    let base = path.join(root, 'dist');
    let file;
    // The path ENiGMA serves dist/ under, for the "foreign page" tests.
    if (p === '/_enig/ws-term') {
        res.writeHead(301, { location: '/_enig/ws-term/' + url.search }).end();
        return;
    }
    if (p.startsWith('/_enig/ws-term/')) p = p.slice('/_enig/ws-term'.length);
    if (p === '/config.json') {
        file = process.env.ENIG_TERM_DEV_CONFIG ?? path.join(root, 'dev-config.json');
    } else {
        if (p.startsWith('/fixtures/')) {
            base = path.join(root, 'test', 'fixtures');
            p = p.slice('/fixtures'.length);
        }
        if (p.endsWith('/')) p += 'index.html';
        file = path.normalize(path.join(base, p));
        if (!file.startsWith(base)) file = '';
    }
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
});
server.on('upgrade', handleUpgrade);
server.listen(port, '127.0.0.1', () => console.log(`enig-term: http://127.0.0.1:${port}/`));

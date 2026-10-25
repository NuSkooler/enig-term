// Minimal static server for dist/ (plus test/fixtures/ under /fixtures/).
// Usage: node scripts/serve.mjs [port]   (default 8090)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? process.env.PORT ?? 8090);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json', '.ans': 'application/octet-stream' };

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    let base = path.join(root, 'dist');
    if (p.startsWith('/fixtures/')) {
        base = path.join(root, 'test', 'fixtures');
        p = p.slice('/fixtures'.length);
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.normalize(path.join(base, p));
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`enig-term: http://127.0.0.1:${port}/`));

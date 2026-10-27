// Real remote ends for the transfer tests: Synchronet's sexyz and lrzsz's
// sz/rz/sx/rx/sb/rb, run over pipes (no Telnet: sexyz in stdio mode, -raw).
// The tests skip what is not installed. ENIG_TERM_SEXYZ= points at sexyz.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const which = cmd => {
    if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : null;
    for (const d of (process.env.PATH ?? '').split(':')) {
        const p = path.join(d, cmd);
        if (d && fs.existsSync(p)) return p;
    }
    return null;
};
export const SEXYZ = which(process.env.ENIG_TERM_SEXYZ ?? 'sexyz') ?? which(path.join(os.homedir(), '.local/bin/sexyz'));
export const LRZSZ = which('sz') && which('rz') && which('sb') && which('rb') && which('sx') && which('rx') ? true : false;

export function allBytes(n) {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = i & 0xff;
    // and runs of the bytes the protocols and Telnet treat specially
    const special = [0x18, 0xff, 0x11, 0x13, 0x91, 0x93, 0x10, 0x90, 0x0d, 0x8d, 0x40, 0x7f, 0x01, 0x02, 0x04, 0x06, 0x15, 0x1a, 0x43];
    for (let i = 0; i < 2048 && 256 + i < n; i++) b[256 + i] = special[i % special.length];
    return b;
}
export const random = n => new Uint8Array(crypto.randomBytes(n));
export const sha = b => crypto.createHash('sha256').update(b).digest('hex');

export function tmpdir(prefix = 'enig-term-xfer-') {
    return fs.mkdtempSync(path.join(process.env.ENIG_TERM_TMP ?? os.tmpdir(), prefix));
}

/**
 * The remote command for a case. `dir`: files to send (peer sends) or the
 * directory to receive into (peer receives). Returns [cmd, args, cwd].
 */
export function peerCommand(peer, dir, { recvName, telnet = false } = {}) {
    const files = () => fs.readdirSync(dir).sort().map(f => path.join(dir, f));
    // sexyz in stdio mode: -raw over pipes; -telnet does its own IAC escaping, as under ENiGMA.
    const T = telnet ? '-telnet' : '-raw';
    const list = () => {
        const l = path.join(path.dirname(dir), `${path.basename(dir)}.list`);
        fs.writeFileSync(l, files().join('\n'));
        return `@${l}`;
    };
    switch (peer) {
        // the board sends (we receive)
        case 'sexyz sX': return [SEXYZ, [T, 'sX', list()], dir];
        case 'sexyz sx': return [SEXYZ, [T, 'sx', list()], dir];
        case 'sexyz sY': return [SEXYZ, [T, 'sY', list()], dir];
        case 'sexyz sz': return [SEXYZ, [T, '-8', 'sz', list()], dir];
        case 'sx': return ['sx', ['-k', ...files()], dir];
        case 'sb': return ['sb', ['-k', ...files()], dir];
        case 'sz': return ['sz', ['--zmodem', '--try-8k', '--binary', '--restricted', ...files()], dir];
        // the board receives (we send)
        case 'sexyz rC': return [SEXYZ, [T, 'rC', path.join(dir, recvName ?? 'upload.bin')], dir];
        case 'sexyz ry': return [SEXYZ, [T, 'ry', dir + '/'], dir];
        case 'sexyz rz': return [SEXYZ, [T, '-8', 'rz', dir + '/'], dir];
        case 'rx': return ['rx', ['-c', recvName ?? 'upload.bin'], dir];
        case 'rb': return ['rb', [], dir];
        case 'rz': return ['rz', ['--zmodem', '--binary', '--restricted', '--keep-uppercase'], dir];
        default: throw new Error(`unknown peer ${peer}`);
    }
}

/**
 * Run `engine(io)` against the peer process. `io.send` writes to it; the
 * engine's feed() gets what it writes. Resolves when both have finished.
 * `onBytes(total)` sees the running byte count (for cancel tests).
 */
export function runPeer([cmd, args, cwd], makeEngine, { timeout = 120_000, tickMs = 20, onBytes, mergeStderr = false } = {}) {
    return new Promise(resolve => {
        const t0 = Date.now();
        // mergeStderr: the status text in the stream, in order (one pipe), as on a pty.
        const p = mergeStderr ? spawn('sh', ['-c', 'exec "$0" "$@" 2>&1', cmd, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] }) : spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        let result = null;
        let exit = null;
        let bytes = 0;
        let engine = null;
        const finish = () => {
            if (result === null || exit === null) return;
            clearInterval(ticker);
            clearTimeout(guard);
            resolve({ result, exit, stderr, ms: Date.now() - t0, engine });
        };
        const io = {
            send: u8 => {
                bytes += u8.length;
                if (!p.stdin.destroyed) p.stdin.write(Buffer.from(u8));
            },
            done: r => {
                if (result !== null) return;
                result = r;
                setTimeout(() => exit === null && p.kill('SIGTERM'), 15_000);
                finish();
            },
            kill: sig => p.kill(sig),
        };
        engine = makeEngine(io);
        const ticker = setInterval(() => {
            engine.tick();
            onBytes?.(bytes, io, engine);
        }, tickMs);
        const guard = setTimeout(() => {
            stderr += '\n[test] timeout';
            p.kill('SIGKILL');
            if (result === null) result = { ok: false, error: 'test timeout' };
            finish();
        }, timeout);
        p.stdout.on('data', d => {
            bytes += d.length;
            engine.feed(new Uint8Array(d));
            onBytes?.(bytes, io, engine);
        });
        p.stdin.on('error', () => {});
        p.stderr.on('data', d => (stderr += d));
        p.on('exit', (code, sig) => {
            exit = { code, sig };
            setTimeout(() => {
                if (result === null) {
                    result = { ok: false, error: 'peer exited, engine still running', hung: true };
                    finish();
                }
            }, 5000);
            finish();
        });
    });
}

export function haveCmd(cmd) {
    return spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
}

// A hand-made ZModem sender (no peer needed): ZRQINIT, then per file ZFILE
// (name, announced size), ZDATA and the data in 1 KB subpackets, ZEOF; ZFIN.
export function craftedZmodem(files) {
    const ZDLE = 0x18;
    const crc16 = (b, c = 0) => {
        for (const x of b) {
            c ^= x << 8;
            for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
        }
        return c;
    };
    const ESCAPED = new Set([0x18, 0x10, 0x90, 0x11, 0x91, 0x13, 0x93]);
    const esc = b => b.flatMap(x => (ESCAPED.has(x) ? [ZDLE, x ^ 0x40] : [x]));
    const pos4 = n => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
    const hexHdr = (type, p) => {
        const h = [type, ...p];
        const c = crc16(h);
        return [...Buffer.from(`**\x18B${Buffer.from([...h, c >> 8, c & 0xff]).toString('hex')}\r\n\x11`, 'latin1')];
    };
    const binHdr = (type, p) => {
        const h = [type, ...p];
        const c = crc16(h);
        return [0x2a, ZDLE, 0x41, ...esc([...h, c >> 8, c & 0xff])];
    };
    const sub = (data, end) => {
        const c = crc16([...data, end]);
        return [...esc([...data]), ZDLE, end, ...esc([c >> 8, c & 0xff])];
    };
    const chunks = [hexHdr(0, [0, 0, 0, 0])];
    for (const { name, announce, total } of files) {
        chunks.push([...binHdr(4, [0, 0, 0, 0]), ...sub([...Buffer.from(`${name}\0${announce}\0`)], 0x6b)], binHdr(10, pos4(0)));
        const block = new Uint8Array(1024).fill(0x42);
        for (let sent = 0; sent < total; sent += 1024) chunks.push(sub(block.subarray(0, Math.min(1024, total - sent)), sent + 1024 >= total ? 0x68 : 0x69));
        chunks.push(hexHdr(11, pos4(total)));
    }
    chunks.push(hexHdr(8, [0, 0, 0, 0]), [0x4f, 0x4f]);
    return chunks.map(c => new Uint8Array(c));
}

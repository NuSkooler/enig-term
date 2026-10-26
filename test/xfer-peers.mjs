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
export function peerCommand(peer, dir, { recvName } = {}) {
    const files = () => fs.readdirSync(dir).sort().map(f => path.join(dir, f));
    const list = () => {
        const l = path.join(path.dirname(dir), `${path.basename(dir)}.list`);
        fs.writeFileSync(l, files().join('\n'));
        return `@${l}`;
    };
    switch (peer) {
        // the board sends (we receive)
        case 'sexyz sX': return [SEXYZ, ['-raw', 'sX', list()], dir];
        case 'sexyz sx': return [SEXYZ, ['-raw', 'sx', list()], dir];
        case 'sexyz sY': return [SEXYZ, ['-raw', 'sY', list()], dir];
        case 'sexyz sz': return [SEXYZ, ['-raw', '-8', 'sz', list()], dir];
        case 'sx': return ['sx', ['-k', ...files()], dir];
        case 'sb': return ['sb', ['-k', ...files()], dir];
        case 'sz': return ['sz', ['--zmodem', '--try-8k', '--binary', '--restricted', ...files()], dir];
        // the board receives (we send)
        case 'sexyz rC': return [SEXYZ, ['-raw', 'rC', path.join(dir, recvName ?? 'upload.bin')], dir];
        case 'sexyz ry': return [SEXYZ, ['-raw', 'ry', dir + '/'], dir];
        case 'sexyz rz': return [SEXYZ, ['-raw', '-8', 'rz', dir + '/'], dir];
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
export function runPeer([cmd, args, cwd], makeEngine, { timeout = 120_000, tickMs = 20, onBytes } = {}) {
    return new Promise(resolve => {
        const t0 = Date.now();
        const p = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
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

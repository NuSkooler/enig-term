// Prepare a throwaway ENiGMA for test/transfer-live.spec.ts: a config, the
// stock menus (from ENiGMA's own templates) plus an "xferTests" menu, the
// files it sends, a file area for uploads, and a test user. Everything is
// written under <dir>; the ENiGMA checkout is only read.
//
//   node test/live-xfer-board.mjs <enigma checkout> <dir> [ws port, default 18910]
//
// Then, from the ENiGMA checkout, with sexyz (and lrzsz) on PATH:
//   NODE_ENV=production node main.js --config <dir>/config/
// and:
//   ENIG_TERM_LIVE_XFER=ws://127.0.0.1:<port> ENIG_TERM_LIVE_XFER_DIR=<dir> \
//     npx playwright test test/transfer-live.spec.ts
//
// Ports other than the WebSocket one are disabled or bound to 127.0.0.1
// (ENiGMA ignores `enabled: false` for Telnet, so it gets an address too).
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { allBytes, random } from './xfer-peers.mjs';

const [enigma, dirArg, portArg] = process.argv.slice(2);
if (!enigma || !dirArg) {
    console.error('usage: node test/live-xfer-board.mjs <enigma checkout> <dir> [ws port]');
    process.exit(2);
}
const E = path.resolve(dirArg);
const W = path.resolve(enigma);
const port = Number(portArg ?? 18910);
const USER = process.env.ENIG_TERM_LIVE_USER ?? 'xfertest';
const PASS = process.env.ENIG_TERM_LIVE_PASS ?? 'Xfer-Test-2026';

for (const d of ['config/menus', 'config/security', 'db/mods', 'logs', 'drop', 'mail', 'file_base/uploads', 'src', 'www']) fs.mkdirSync(path.join(E, d), { recursive: true });

const p = (...a) => path.join(E, ...a);
fs.writeFileSync(
    p('config', 'config.hjson'),
    JSON.stringify(
        {
            general: { boardName: 'enig-term xfer test', menuFile: p('config', 'menus', 'xfer-main.hjson') },
            paths: { config: p('config') + '/', security: p('config', 'security'), db: p('db') + '/', modsDb: p('db', 'mods') + '/', logs: p('logs') + '/', dropFiles: p('drop') + '/', emailInbound: p('mail') + '/' },
            users: { requireActivation: false, preAuthIdleLogoutSeconds: 600, idleLogoutSeconds: 3600, newUserNames: ['newxfer'] },
            fileBase: {
                areaStoragePrefix: p('file_base') + '/',
                estimatedTransferCps: 0, // no download time check: these are tests
                storageTags: { xfer_uploads: 'uploads' },
                areas: { xfer_area: { name: 'Transfer Tests', desc: 'Uploads from enig-term', storageTags: ['xfer_uploads'], acs: { write: 'GM[users]' } } },
            },
            loginServers: {
                telnet: { port: port + 13, enabled: false, address: '127.0.0.1' },
                ssh: { port: port + 12, enabled: false },
                webSocket: { ws: { port, enabled: true, address: '127.0.0.1' }, wss: { port: port + 1, enabled: false } },
            },
            contentServers: {
                web: { domain: 'localhost', staticRoot: p('www'), http: { enabled: false, port: port + 70, address: '127.0.0.1' }, https: { enabled: false, port: port + 33 } },
                gopher: { enabled: false, port: port + 60, publicPort: port + 60 },
                nntp: { nntp: { enabled: false, port: port + 9 }, nntps: { enabled: false, port: port + 53 } },
            },
            chatServers: { mrc: { enabled: false, multiplexerPort: port - 310 } },
            scannerTossers: { ftn_bso: { binkp: { inbound: { enabled: false, port: port + 744 } } } },
        },
        null,
        4,
    ),
);

// The stock menus, as `oputil.js config new` writes them, plus ours.
const includes = ['message_base', 'private_mail', 'login', 'new_user', 'doors', 'file_base', 'activitypub'];
for (const f of includes) fs.copyFileSync(path.join(W, 'misc', 'menu_templates', `${f}.in.hjson`), p('config', 'menus', `xfer-${f}.hjson`));
let main = fs.readFileSync(path.join(W, 'misc', 'menu_templates', 'main.in.hjson'), 'utf8').replace('%INCLUDE_FILES%', [...includes.map(f => `xfer-${f}.hjson`), 'xfer-tests.hjson'].join('\n\t\t'));
const anchor = /(mainMenu: \{[\s\S]*?submit: \[\n)/;
if (!anchor.test(main)) throw new Error('main menu template: no mainMenu submit list');
main = main.replace(anchor, `$1                {\n                    value: { command: "XT" }\n                    action: @menu:xferTests\n                }\n`);
fs.writeFileSync(p('config', 'menus', 'xfer-main.hjson'), main);

// What the board sends.
const sets = {
    small: [['hello.txt', Buffer.from('hello, world\r\n')]],
    all: [['allbytes.bin', Buffer.from(allBytes(70000))]],
    batch: [['one.bin', Buffer.from(random(3000))], ['all2.bin', Buffer.from(allBytes(66000))], ['three.txt', Buffer.from('three\r\n'.repeat(400))]],
    big: [['big.bin', Buffer.from(random(10 << 20))]],
    empty: [['empty.bin', Buffer.alloc(0)]],
};
const manifest = {};
for (const [set, files] of Object.entries(sets)) {
    fs.mkdirSync(p('src', set), { recursive: true });
    manifest[set] = files.map(([n, b]) => {
        fs.writeFileSync(p('src', set, n), b);
        return { name: n, size: b.length, sha: crypto.createHash('sha256').update(b).digest('hex'), path: p('src', set, n) };
    });
}
fs.writeFileSync(p('src', 'manifest.json'), JSON.stringify(manifest, null, 1));

// D<proto>-<SET>: send a set with file_transfer. The settings go in
// extraArgs: a menu reached from a prompt gets the form data as extraArgs,
// and file_transfer then ignores its own config block.
const protos = { ZS: 'zmodem8kSexyz', ZL: 'zmodem8kSz', YS: 'ymodemSexyz', XS: 'xmodemSexyz' };
const menus = { xferTests: { desc: 'Transfer Tests', art: 'FMENU', prompt: 'menuCommand', config: { interrupt: 'realtime' }, submit: [{ value: { command: 'Q' }, action: '@systemMethod:prevMenu' }] } };
for (const [k, proto] of Object.entries(protos))
    for (const set of Object.keys(sets)) {
        if (k === 'XS' && (set === 'batch' || set === 'empty')) continue;
        const id = `xferD${k}${set}`;
        const args = { protocol: proto, direction: 'send', sendQueue: manifest[set].map(f => f.path) };
        menus.xferTests.submit.push({ value: { command: `D${k}-${set.toUpperCase()}` }, action: `@menu:${id}`, extraArgs: args });
        menus[id] = { desc: 'Downloading', module: 'file_transfer', config: args };
    }
fs.writeFileSync(p('config', 'menus', 'xfer-tests.hjson'), JSON.stringify({ menus }, null, 4));

// The test user (the first user is also the sysop).
const require = createRequire(path.join(W, 'main.js'));
process.argv.push('--config', p('config') + '/');
const common = require(path.join(W, 'core', 'oputil', 'oputil_common.js'));
common.argv.config = p('config') + '/';
common.initConfigAndDatabases(err => {
    if (err) throw err;
    const User = require(path.join(W, 'core', 'user.js'));
    const u = new User();
    u.username = USER;
    u.create({ password: PASS }, e => {
        if (e && !/exists|UNIQUE/i.test(e.message)) throw e;
        console.log(`board ready in ${E}: ws://127.0.0.1:${port}, user ${USER}${e ? ' (already there)' : ''}`);
        process.exit(0);
    });
});

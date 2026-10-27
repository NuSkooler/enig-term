// Unit tests for the TS shell modules that need no DOM: Telnet negotiation,
// host-query replies, the keymap, encodings, selection text, the link policy,
// config precedence, the scrollback controller and SAUCE font names. Node 22 strips the types.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TelnetClient, IAC } from '../src/telnet.ts';
import { replyFor, daReply, ctdaReply, parseVersion, ESC, CTDA_FEATURES } from '../src/replies.ts';
import { encode, cellToUnicode, chunk, charsetForFont } from '../src/encoding.ts';
import { mapKey, keySequence, ctrlChar } from '../src/keymap.ts';
import { normalize, contains, selectionText, wordAt } from '../src/selection.ts';
import { checkLink } from '../src/links.ts';
import { sanitize, resolve, checkEndpoint, fromUrlParams, userMayChange, DEFAULTS } from '../src/config.ts';
import { ScrollbackView } from '../src/scrollback.ts';
import { sauceFont, sauceFontName } from '../src/fonts.ts';

const DO = 253, DONT = 254, WILL = 251, WONT = 252, SB = 250, SE = 240;
const CSI = ESC + '[';
const codes = s => [...s].map(c => c.charCodeAt(0));

// --- Telnet -----------------------------------------------------------------

test('telnet: ENiGMA opening volley gets the answers Xibalba sent', () => {
    const t = new TelnetClient({ getSize: () => ({ cols: 80, rows: 25 }) });
    const volley = [IAC, DONT, 1, IAC, WILL, 1, IAC, WILL, 3, IAC, DO, 3, IAC, DO, 0, IAC, WILL, 0, IAC, DO, 24, IAC, DO, 31, IAC, DO, 39];
    const { data, reply } = t.receive(new Uint8Array(volley));
    assert.equal(data.length, 0);
    assert.deepEqual([...reply], [
        IAC, WONT, 1, // DONT ECHO (first answer goes out)
        IAC, DO, 1, // WILL ECHO
        IAC, DO, 3, // WILL SGA
        IAC, WILL, 3, // DO SGA
        IAC, WILL, 0, // DO BINARY
        IAC, DO, 0, // WILL BINARY
        IAC, WILL, 24, // DO TTYPE
        IAC, WILL, 31, IAC, SB, 31, 0, 80, 0, 25, IAC, SE, // DO NAWS + size
        IAC, WONT, 39, // DO NEW-ENVIRON refused
    ]);
    // repeated identical request is not answered again
    assert.equal(t.receive(new Uint8Array([IAC, DO, 3])).reply.length, 0);
});

test('telnet: TTYPE ansi-bbs, escaped 0xFF data, IAC split across chunks, unknown options refused', () => {
    const t = new TelnetClient({ termType: 'ansi-bbs', getSize: () => ({ cols: 80, rows: 25 }) });
    const r = t.receive(new Uint8Array([IAC, SB, 24, 1, IAC, SE])).reply;
    assert.equal(Buffer.from(r.slice(4, -2)).toString('latin1'), 'ansi-bbs');
    assert.deepEqual([...t.receive(new Uint8Array([0x41, IAC])).data], [0x41]);
    assert.deepEqual([...t.receive(new Uint8Array([IAC, 0x42])).data], [0xff, 0x42]);
    assert.deepEqual([...TelnetClient.escape(new Uint8Array([1, 0xff, 2]))], [1, 0xff, 0xff, 2]);
    assert.deepEqual([...t.receive(new Uint8Array([IAC, DO, 5])).reply], [IAC, WONT, 5]);
    assert.deepEqual([...t.receive(new Uint8Array([IAC, WILL, 200])).reply], [IAC, DONT, 200]);
    // Subnegotiation split over three chunks, with an escaped 0xFF inside.
    const u = new TelnetClient({ getSize: () => ({ cols: 80, rows: 25 }) });
    u.receive(new Uint8Array([IAC, SB]));
    u.receive(new Uint8Array([24, 1, IAC]));
    assert.equal(u.receive(new Uint8Array([SE, 0x58])).data[0], 0x58);
});

test('telnet: NAWS on every resize once negotiated; 255 escaped; refusable for tests', () => {
    let size = { cols: 80, rows: 25 };
    const t = new TelnetClient({ getSize: () => size });
    assert.equal(t.buildResize(), null);
    t.receive(new Uint8Array([IAC, DO, 31]));
    size = { cols: 255, rows: 50 };
    assert.deepEqual([...t.buildResize()], [IAC, SB, 31, 0, 255, 255, 0, 50, IAC, SE]);
    size = { cols: 100, rows: 31 };
    assert.deepEqual([...t.buildResize()], [IAC, SB, 31, 0, 100, 0, 31, IAC, SE]);
    const n = new TelnetClient({ getSize: () => size, naws: false });
    assert.deepEqual([...n.receive(new Uint8Array([IAC, DO, 31])).reply], [IAC, WONT, 31]);
    assert.equal(n.buildResize(), null);
});

// --- replies -------------------------------------------------------------------

test('DA: "enig-term" in decimal ASCII plus the package version', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const v = parseVersion(pkg.version);
    assert.equal(daReply(v), `${CSI}=101;110;105;103;45;116;101;114;109;${v.major};${v.minor};${v.patch}c`);
    assert.deepEqual(parseVersion('1.12.3-beta.1'), { major: 1, minor: 12, patch: 3 });
});

test('CTDA claims only verified features, numbered per the current CTerm manual', () => {
    assert.deepEqual(CTDA_FEATURES, [1, 2, 3, 5]);
    assert.equal(ctdaReply(), `${CSI}<0;1;2;3;5c`);
});

test('CPR, 5n, 255n, CTerm state reports', () => {
    assert.equal(replyFor({ t: 'req', k: 'cpr', row: 5, col: 10 }), `${CSI}5;10R`);
    assert.equal(replyFor({ t: 'req', k: 'dsr' }), `${CSI}0n`);
    assert.equal(replyFor({ t: 'req', k: 'size', rows: 25, cols: 80 }), `${CSI}25;80R`);
    assert.equal(replyFor({ t: 'req', k: 'ctsmrr', n: 6 }, { links: true }), `${CSI}=6;1n`);
    assert.equal(replyFor({ t: 'req', k: 'ctsmrr', n: 6 }, { links: false }), `${CSI}=6;0n`);
    assert.equal(replyFor({ t: 'req', k: 'ctsmrr', n: 4 }, { lastColumnFlag: true }), `${CSI}=4;1n`);
    assert.equal(replyFor({ t: 'req', k: 'ctsmrr', n: 5 }), `${CSI}=5;0n`);
    assert.equal(replyFor({ t: 'req', k: 'ctsmrr', n: 7 }), null, 'no audio: no report');
    assert.equal(replyFor({ t: 'req', k: 'ctsmrr', n: 99 }), null);
    assert.equal(replyFor({ t: 'req', k: 'fontstate', first: 46, result: 0, slots: [42, 0, 0, 0] }), `${CSI}=1;46;0;42;0;0;0n`);
    assert.equal(replyFor({ t: 'req', k: 'fontmode', modes: [] }), `${CSI}=2;n`);
    assert.equal(replyFor({ t: 'req', k: 'fontmode', modes: [7, 25, 33] }), `${CSI}=2;7;25;33n`);
    assert.equal(replyFor({ t: 'req', k: 'fontdim', h: 16, w: 8 }), `${CSI}=3;16;8n`);
    assert.equal(replyFor({ t: 'bell' }), null);
    assert.equal(replyFor({ t: 'req', k: 'da' }, { debugCtermDa: true }), `${CSI}=67;84;101;114;109;1;0c`);
});

// --- keymap --------------------------------------------------------------------

test('keymap: ANSI-BBS sequences for the named keys', () => {
    const k = key => mapKey({ key });
    assert.equal(k('ArrowUp'), `${CSI}A`);
    assert.equal(k('ArrowDown'), `${CSI}B`);
    assert.equal(k('ArrowRight'), `${CSI}C`);
    assert.equal(k('ArrowLeft'), `${CSI}D`);
    assert.equal(k('Home'), `${CSI}H`);
    assert.equal(k('End'), `${CSI}K`);
    assert.equal(k('Insert'), `${CSI}@`);
    assert.equal(k('PageUp'), `${CSI}V`);
    assert.equal(k('PageDown'), `${CSI}U`);
    assert.deepEqual(['F1', 'F2', 'F3', 'F4'].map(k), [`${ESC}OP`, `${ESC}OQ`, `${ESC}OR`, `${ESC}OS`]);
    assert.deepEqual(['F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].map(k), ['15', '17', '18', '19', '20', '21', '23', '24'].map(n => `${CSI}${n}~`));
    assert.equal(k('Enter'), '\r');
    assert.equal(k('Tab'), '\t');
    assert.equal(mapKey({ key: 'Tab', shiftKey: true }), `${CSI}Z`);
    assert.equal(k('Escape'), ESC);
    assert.equal(k('a'), undefined, 'printable text comes through the textarea');
    assert.equal(k('Shift'), undefined);
});

test('keymap: Backspace ^H and Delete DEL (DOS/SyncTERM), swappable', () => {
    assert.deepEqual(codes(mapKey({ key: 'Backspace' })), [8]);
    assert.deepEqual(codes(mapKey({ key: 'Delete' })), [0x7f]);
    assert.deepEqual(codes(mapKey({ key: 'Backspace' }, { backspace: 'del' })), [0x7f]);
    assert.deepEqual(codes(mapKey({ key: 'Delete' }, { backspace: 'del' })), [8]);
    assert.deepEqual(codes(keySequence('Backspace')), [8]);
});

test('keymap: Ctrl letters and symbols, Alt as an ESC prefix, Meta left alone', () => {
    assert.deepEqual(codes(mapKey({ key: 'c', ctrlKey: true })), [3]);
    assert.deepEqual(codes(mapKey({ key: 'A', ctrlKey: true, shiftKey: true })), [1]);
    assert.deepEqual(codes(mapKey({ key: '[', ctrlKey: true })), [0x1b]);
    assert.deepEqual(codes(mapKey({ key: ' ', ctrlKey: true })), [0]);
    assert.deepEqual(codes(ctrlChar('ф', 'KeyA')), [1], 'non-Latin layout: the physical key');
    assert.equal(mapKey({ key: 'x', altKey: true }), `${ESC}x`);
    assert.equal(mapKey({ key: 'ArrowUp', altKey: true }), `${ESC}${CSI}A`);
    assert.equal(mapKey({ key: 'é', altKey: true }), undefined, 'macOS Option characters type through');
    assert.equal(mapKey({ key: '@', ctrlKey: true, altKey: true }), undefined, 'AltGr+q = @ on a German layout');
    assert.equal(mapKey({ key: 'c', metaKey: true }), undefined);
});

// --- encoding --------------------------------------------------------------------

test('encoding: CP437 by default, Latin-1 under Amiga fonts, CR for line breaks', () => {
    const s = 'A' + String.fromCharCode(0xe9, 0xfc, 0x2591, 0x20ac);
    assert.deepEqual([...encode(s, 'cp437')], [0x41, 0x82, 0x81, 0xb0, 0x3f]);
    assert.deepEqual([...encode(s, 'latin1')], [0x41, 0xe9, 0xfc, 0x3f, 0x3f]);
    assert.deepEqual([...encode('a\r\nb\nc', 'cp437')], [0x61, 13, 0x62, 13, 0x63]);
    assert.equal(charsetForFont(42), 'latin1');
    assert.equal(charsetForFont(37), 'latin1');
    assert.equal(charsetForFont(0), 'cp437');
});

test('encoding: cells copy out as Unicode (CP437 glyphs, or Latin-1)', () => {
    assert.equal(cellToUnicode(0xdb, 'cp437'), String.fromCharCode(0x2588));
    assert.equal(cellToUnicode(0xc9, 'cp437'), String.fromCharCode(0x2554));
    assert.equal(cellToUnicode(0x01, 'cp437'), String.fromCharCode(0x263a));
    assert.equal(cellToUnicode(0x7f, 'cp437'), String.fromCharCode(0x2302));
    assert.equal(cellToUnicode(0, 'cp437'), ' ');
    assert.equal(cellToUnicode(0xe9, 'latin1'), String.fromCharCode(0xe9));
    assert.equal(cellToUnicode(0xe9, 'cp437'), String.fromCharCode(0x398));
    // Round trip for every printable CP437 byte.
    for (let b = 0x20; b < 0x100; b++) {
        if (b === 0x7f) continue;
        assert.deepEqual([...encode(cellToUnicode(b, 'cp437'), 'cp437')], [b], `byte ${b}`);
    }
});

test('encoding: paste chunks never split CR LF', () => {
    const b = new Uint8Array([1, 2, 3, 13, 10, 4]);
    assert.deepEqual(chunk(b, 4).map(c => [...c]), [[1, 2, 3, 13, 10], [4]]);
    assert.deepEqual(chunk(new Uint8Array(600), 256).map(c => c.length), [256, 256, 88]);
});

// --- selection -----------------------------------------------------------------

test('selection: normalised stream ranges and text from packed cells', () => {
    const r = normalize({ x: 5, y: 2 }, { x: 3, y: 0 });
    assert.deepEqual(r, { x0: 3, y0: 0, x1: 5, y1: 2 });
    assert.ok(contains(r, 3, 0) && !contains(r, 2, 0) && contains(r, 0, 1) && contains(r, 5, 2) && !contains(r, 6, 2));
    const pack = (s, font = 0) => Uint32Array.from([...s].map(c => c.charCodeAt(0) | (font << 16)));
    const rows = [pack('hello world   '), pack('\xc9\xcd\xbb box   '), pack('caf\xe9  ', 42)];
    const text = selectionText({ x0: 6, y0: 0, x1: 4, y1: 2 }, y => rows[y], 14);
    assert.equal(text, `world\n${String.fromCharCode(0x2554, 0x2550, 0x2557)} box\ncaf${String.fromCharCode(0xe9)}`);
    assert.deepEqual(wordAt(rows[0], 7), [6, 10]);
    assert.deepEqual(wordAt(rows[0], 5), [5, 5]);
});

// --- links ---------------------------------------------------------------------

test('links: only absolute http(s) by default; shown normalised', () => {
    assert.deepEqual(checkLink('https://example.com/a b'), { ok: false, href: 'https://example.com/a b', reason: 'malformed link' });
    assert.equal(checkLink('https://example.com/x?y=1').ok, true);
    assert.equal(checkLink('HTTP://Example.COM').href, 'http://example.com/');
    assert.equal(checkLink('javascript:alert(1)').ok, false);
    assert.equal(checkLink('data:text/html,hi').ok, false);
    assert.equal(checkLink('/relative').ok, false);
    assert.equal(checkLink('https://user:pw@example.com/').ok, false);
    assert.equal(checkLink('https://xn--80ak6aa92e.com/').href, 'https://xn--80ak6aa92e.com/');
    assert.equal(checkLink('https://аpple.com/').href, 'https://xn--pple-43d.com/', 'IDN shown in punycode');
    assert.equal(checkLink('gopher://x.example/', ['gopher']).ok, true);
    assert.equal(checkLink('https://x.example/' + 'a'.repeat(3000)).ok, false);
});

// --- config --------------------------------------------------------------------

test('config: sanitize keeps valid keys, drops invalid ones with a warning', () => {
    const warnings = [];
    const c = sanitize(
        { version: 1, endpoint: 'wss://x', title: 'T', cols: 80, rows: 9, crt: 'on', aspect: false, keyBar: true, scrollback: '500', autoReconnect: 'nope', extra: 1, profile: 'amiga' },
        m => warnings.push(m),
    );
    assert.deepEqual(c, { version: 1, endpoint: 'wss://x', title: 'T', cols: 80, crt: true, aspect: false, keyBar: 'on', scrollback: 500, profile: 'amiga' });
    assert.equal(warnings.length, 2, warnings.join('\n')); // rows, autoReconnect
    assert.deepEqual(sanitize({ endpoint: null }), { endpoint: null });
    const w2 = [];
    assert.equal(sanitize({ version: 2 }, m => w2.push(m)).version, 2);
    assert.match(w2[0], /newer/);
});

test('config: precedence defaults < config.json < page < URL < user', () => {
    const o = resolve({
        config: { endpoint: 'wss://cfg', crt: true, aspect: false, title: 'Cfg' },
        page: { title: 'Page', urlParams: true },
        url: { endpoint: 'wss://url', crt: false },
        user: { crt: true, aspect: true },
    });
    assert.equal(o.title, 'Page');
    assert.equal(o.endpoint, 'wss://url');
    assert.equal(o.crt, true, 'user setting wins');
    assert.equal(o.aspect, true);
    assert.equal(o.cols, DEFAULTS.cols);
    // URL parameters only count when enabled
    assert.equal(resolve({ config: { endpoint: 'wss://cfg' }, url: { endpoint: 'wss://url' } }).endpoint, 'wss://cfg');
});

test('config: lockEndpoint and lock[] stop URL and user overrides', () => {
    const o = resolve({
        config: { endpoint: 'wss://cfg', lockEndpoint: true, lock: ['crt'], crt: false },
        page: { urlParams: true },
        url: { endpoint: 'wss://evil', crt: true, lockEndpoint: false, lock: [] },
        user: { crt: true },
    });
    assert.equal(o.endpoint, 'wss://cfg');
    assert.equal(o.lockEndpoint, true);
    assert.equal(o.crt, false);
    assert.equal(userMayChange(o, 'crt'), false);
    assert.equal(userMayChange(o, 'aspect'), true);
    assert.equal(userMayChange(o, 'endpoint'), false);
});

test('config: URL parameter names (the v1 contract) map to options', () => {
    const { opts, hooks } = fromUrlParams(new URLSearchParams('endpoint=ws://127.0.0.1:18810&connect=1&crt=0&keys=on&naws=0&debugDa=cterm&bogus=1'));
    assert.deepEqual(sanitize(opts), { endpoint: 'ws://127.0.0.1:18810', autoConnect: true, crt: false, keyBar: 'on' });
    assert.deepEqual(hooks, { naws: '0', debugDa: 'cterm' });
});

test('endpoints: wss only, ws only for loopback or with allowInsecure', () => {
    assert.deepEqual(checkEndpoint('bbs.example.com:8443'), { ok: true, url: 'wss://bbs.example.com:8443/' });
    assert.equal(checkEndpoint('wss://bbs.example.com/ws').ok, true);
    assert.equal(checkEndpoint('ws://bbs.example.com').ok, false);
    assert.equal(checkEndpoint('ws://bbs.example.com', true).ok, true);
    for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]']) assert.equal(checkEndpoint(`ws://${h}:8810`).ok, true, h);
    assert.equal(checkEndpoint('http://x').ok, false);
    assert.equal(checkEndpoint('').ok, false);
});

// --- scrollback controller ---------------------------------------------------------

test('scrollback view: wheel, pages, drag and return to live', () => {
    let offset = 0;
    const len = 100;
    const target = { scrollback_len: () => len, set_view_offset: n => (offset = Math.max(0, Math.min(len, n))), view_offset: () => offset, rows: () => 25 };
    const v = new ScrollbackView(() => target);
    const changes = [];
    v.onChange = o => changes.push(o);
    v.wheel(-48, 0, 16); // 3 lines up
    assert.equal(offset, 3);
    v.wheel(-8, 0, 16); // half a line: pending
    assert.equal(offset, 3);
    v.wheel(-8, 0, 16);
    assert.equal(offset, 4);
    v.wheel(-2, 1, 16); // line mode
    assert.equal(offset, 6);
    v.page(1);
    assert.equal(offset, 30);
    v.page(1);
    v.page(1);
    v.page(1);
    v.page(1);
    assert.equal(offset, 100, 'clamped to what is held');
    v.drag(-32, 16); // finger up: towards live
    assert.equal(offset, 98);
    v.toLive();
    assert.equal(offset, 0);
    assert.equal(changes.at(-1), 0);
    v.wheel(500, 0, 16); // down at live: stays
    assert.equal(offset, 0);
});

test('config: transfers, zmodemDetect and transferMaxFile; zmodemDetect is a user setting', () => {
    const warns = [];
    const o = sanitize({ transfers: 'off', zmodemDetect: 'ask', transferMaxFile: 64 }, w => warns.push(w));
    assert.deepEqual(o, { transfers: false, zmodemDetect: 'ask', transferMaxFile: 64 });
    assert.deepEqual(sanitize({ zmodemDetect: 'always', transferMaxFile: 0 }, w => warns.push(w)), {});
    assert.equal(warns.length, 2);
    assert.deepEqual([DEFAULTS.transfers, DEFAULTS.zmodemDetect, DEFAULTS.transferMaxFile], [true, 'auto', 512]);
    assert.equal(userMayChange(resolve({}), 'zmodemDetect'), true);
    assert.equal(userMayChange(resolve({ config: { lock: ['zmodemDetect'] } }), 'zmodemDetect'), false);
    assert.equal(fromUrlParams(new URLSearchParams('zmodemDetect=off')).opts.zmodemDetect, 'off');
});

test('Telnet: every byte value survives escaping out and decoding in (transfers run above Telnet)', () => {
    const data = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
    const wire = TelnetClient.escape(data);
    assert.equal(wire.length, data.length + 2, 'each 0xFF doubled');
    const t = new TelnetClient({ getSize: () => ({ cols: 80, rows: 25 }) });
    // split the stream between the two IACs of a pair, too
    const cut = wire.indexOf(IAC) + 1;
    const a = t.receive(wire.subarray(0, cut));
    const b = t.receive(wire.subarray(cut));
    assert.deepEqual(Array.from([...a.data, ...b.data]), Array.from(data));
});

// --- SAUCE font names --------------------------------------------------------

test('SAUCE fonts: IBM names map to our font of that code page, with the height they name', () => {
    assert.deepEqual(sauceFont('IBM VGA'), { slot: 0, height: 16 });
    assert.deepEqual(sauceFont('IBM VGA50'), { slot: 0, height: 8 });
    assert.deepEqual(sauceFont('IBM VGA25G'), { slot: 0, height: 19 });
    assert.deepEqual(sauceFont('IBM EGA'), { slot: 0, height: 14 });
    assert.deepEqual(sauceFont('IBM EGA43'), { slot: 0, height: 8 });
    assert.deepEqual(sauceFont('IBM VGA 437'), { slot: 0, height: 16 });
    assert.deepEqual(sauceFont('IBM VGA 850'), { slot: 18, height: 16 });
    assert.deepEqual(sauceFont('IBM VGA50 858'), { slot: 18, height: 8 });
    assert.deepEqual(sauceFont('IBM EGA 865'), { slot: 28, height: 14 });
    assert.deepEqual(sauceFont('IBM EGA43 866'), { slot: 25, height: 8 });
    assert.deepEqual(sauceFont('IBM VGA25G 819'), { slot: 24, height: 19 });
});

test('SAUCE fonts: case, spacing, underscores and hyphens do not matter', () => {
    for (const n of ['ibm vga 850', 'IBM  VGA  850', ' IBM VGA 850 ', 'IBM_VGA_850', 'IBM-VGA-850', 'IBMVGA 850']) assert.deepEqual(sauceFont(n), { slot: 18, height: 16 }, n);
    assert.deepEqual(sauceFont('ibm vga 50'), { slot: 0, height: 8 });
    assert.deepEqual(sauceFont('IBM EGA 43 866'), { slot: 25, height: 8 });
    assert.deepEqual(sauceFont('ibm vga25g'), { slot: 0, height: 19 });
});

test('SAUCE fonts: Amiga names, in the spellings seen in the wild', () => {
    const want = {
        'Amiga Topaz 1': 42,
        'Amiga Topaz 2': 42,
        'Amiga Topaz 1+': 40,
        'Amiga Topaz 2+': 40,
        'amiga topaz 2 plus': 40,
        'Amiga P0T-NOoDLE': 37,
        'Amiga Pot-Noodle': 37,
        'AMIGA P0T NOODLE': 37,
        'Amiga MicroKnight': 41,
        'Amiga MicroKnight+': 39,
        'Amiga Micro Knight Plus': 39,
        'Amiga mOsOul': 38,
        "Amiga mO'sOul": 38,
        'Amiga MOSOUL': 38,
        Topaz: 42,
    };
    for (const [n, slot] of Object.entries(want)) assert.deepEqual(sauceFont(n), { slot, height: 8 }, n);
});

test('SAUCE fonts: code pages and machines we have no font for, and unknown names, give the default', () => {
    for (const n of ['IBM VGA 737', 'IBM EGA 852', 'IBM VGA 872', 'IBM VGA MIK', 'IBM VGA KAM', 'IBM VGA50 MAZ']) assert.equal(sauceFont(n).slot, null, n);
    assert.equal(sauceFont('IBM VGA 737').height, 16, 'the height is still known');
    for (const n of ['C64 PETSCII unshifted', 'C64 PETSCII shifted', 'Atari ATASCII', 'Amiga Topaz 3', 'Terminus', '', '   ', 'IBM CGA']) {
        assert.deepEqual(sauceFont(n), { slot: null, height: null }, n);
    }
});

test('SAUCE fonts: the name is read from the record of character and binary text files only', () => {
    const file = (font, dataType = 1, id = 'SAUCE00') => {
        const rec = new Uint8Array(128);
        rec.set(codes(id), 0);
        rec[94] = dataType;
        rec.set(codes(font), 106);
        return new Uint8Array([...codes('art'), 0x1a, ...rec]);
    };
    assert.equal(sauceFontName(file('IBM VGA 850')), 'IBM VGA 850');
    assert.equal(sauceFontName(file('Amiga Topaz 2+', 5)), 'Amiga Topaz 2+');
    assert.equal(sauceFontName(file('A'.repeat(22))), 'A'.repeat(22), 'all 22 bytes, no terminator');
    assert.equal(sauceFontName(file('IBM VGA', 2)), null, 'Bitmap: TInfoS is not a font name');
    assert.equal(sauceFontName(file('')), null);
    assert.equal(sauceFontName(file('IBM VGA', 1, 'SAUCE01')), null);
    assert.equal(sauceFontName(new Uint8Array(100)), null);
});

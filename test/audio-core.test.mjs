// Node tests for the core's audio paths: CTerm "ANSI" music (introducers,
// modes, parsing, state), CSI = 7 requests, audio APC strings taken whole as
// raw bytes, and feed() stopping after music and A;Wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, bytes, ESC, CSI, ST } from './core-harness.mjs';

const { Core } = await loadCore();
const APC = ESC + '_';
const SO = String.fromCharCode(0x0e);

const events = c => JSON.parse(c.take_events());
const row = (c, y) => String.fromCharCode(...Array.from(c.row_cells(y), v => v & 0xffff)).trimEnd();

/** Feed all of `s`, feeding again after every early stop; returns [events, number of stops]. */
function feedAll(c, s) {
    let b = typeof s === 'string' ? bytes(s) : s;
    const out = [];
    let stops = 0;
    for (;;) {
        c.feed(b);
        out.push(...events(c));
        const n = c.fed();
        if (n >= b.length) break;
        stops++;
        b = b.subarray(n);
    }
    return [out, stops];
}

const notes = ev => {
    const n = ev.n;
    const out = [];
    for (let i = 0; i < n.length; i += 3) out.push(n.slice(i, i + 3));
    return out;
};

test('music: CSI | and CSI N play by default, CSI M stays delete line', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${CSI}2;1Hline2${CSI}3;1Hline3${CSI}2;1H`));
    events(c);
    const [ev] = feedAll(c, `${CSI}|T120L4C${SO}${CSI}NE${SO}${CSI}M`);
    const music = ev.filter(e => e.t === 'music');
    assert.equal(music.length, 2);
    assert.deepEqual(notes(music[0]), [[48, 500 - 62, 62]]);
    assert.deepEqual(notes(music[1]), [[52, 438, 62]]);
    assert.equal(row(c, 1), 'line3', 'CSI M deleted line 2 (music mode 1)');
    assert.equal(row(c, 0), '', 'no music text printed');
    assert.equal(c.music_mode(), 1);
});

test('music: CSI = Ps M sets the introducers; CSI M with a parameter is always DL', () => {
    const c = new Core(80, 25, 'ansi');
    feedAll(c, `${CSI}=2M`);
    assert.equal(c.music_mode(), 2);
    c.feed(bytes(`${CSI}1;1Ha${CSI}2;1Hb${CSI}1;1H`));
    let [ev] = feedAll(c, `${CSI}MFC${SO}`);
    assert.equal(ev.filter(e => e.t === 'music').length, 1, 'CSI M is music in mode 2');
    assert.equal(row(c, 0), 'a', 'and did not delete the line');
    [ev] = feedAll(c, `${CSI}1M`);
    assert.equal(row(c, 0), 'b', 'CSI 1 M deletes');
    feedAll(c, `${CSI}=0M`);
    [ev] = feedAll(c, `${CSI}NC${SO}x`);
    assert.equal(ev.filter(e => e.t === 'music').length, 0, 'CSI N is not music in mode 0');
    feedAll(c, `${ESC}c`);
    assert.equal(c.music_mode(), 1, 'RIS restores mode 1');
});

test('music: bad characters end the string unplayed (the byte is swallowed), lower case is fine', () => {
    const c = new Core(80, 25, 'ansi');
    let [ev] = feedAll(c, `${CSI}|cdeXyz${SO}`);
    assert.equal(ev.filter(e => e.t === 'music').length, 0);
    // (the SO that no longer ends anything is printed like any C0 glyph)
    assert.equal(row(c, 0), 'yz\x0e', 'X ended the music and was consumed; the rest prints');
    [ev] = feedAll(c, `${CSI}|mb t200 o3 l8 c d e${SO}`);
    const m = ev.find(e => e.t === 'music');
    assert.equal(m.fg, false, 'MB: background');
    assert.deepEqual(notes(m).map(n => n[0]), [36, 38, 40]);
    assert.equal(notes(m)[0][1] + notes(m)[0][2], Math.floor(240000 / 200 / 8));
});

test('music: state persists between strings and resets with RIS; foreground is the default', () => {
    const c = new Core(80, 25, 'ansi');
    let [ev] = feedAll(c, `${CSI}|T60 O2 MS${SO}${CSI}|C${SO}`);
    const second = ev.filter(e => e.t === 'music')[1];
    assert.equal(second.fg, true);
    assert.deepEqual(notes(second), [[24, 1000 - 250, 250]], 'tempo 60, octave 2, staccato kept');
    [ev] = feedAll(c, `${ESC}c${CSI}|C${SO}`);
    assert.deepEqual(notes(ev.find(e => e.t === 'music')), [[48, 438, 62]]);
});

test('music: a string split over feeds, and feed() stops after it', () => {
    const c = new Core(80, 25, 'ansi');
    const s = `ab${CSI}|C D${SO}cd`;
    const b = bytes(s);
    // one byte at a time
    let got = [];
    for (let i = 0; i < b.length; i++) {
        c.feed(b.subarray(i, i + 1));
        got.push(...events(c));
        assert.equal(c.fed(), 1);
    }
    assert.equal(got.filter(e => e.t === 'music').length, 1);
    assert.equal(row(c, 0), 'abcd');
    // whole: stops right after SO
    const c2 = new Core(80, 25, 'ansi');
    c2.feed(b);
    assert.equal(c2.fed(), s.indexOf(SO) + 1);
    assert.equal(row(c2, 0), 'ab', 'nothing after the music yet');
    c2.feed(b.subarray(c2.fed()));
    assert.equal(row(c2, 0), 'abcd');
});

test('music: long strings are capped at CTerm\'s buffer size', () => {
    const c = new Core(80, 25, 'ansi');
    const [ev] = feedAll(c, `${CSI}|L64T255${'C'.repeat(5000)}${SO}`);
    const m = ev.find(e => e.t === 'music');
    assert.ok(m.n.length / 3 <= 1022 && m.n.length / 3 > 1000, `${m.n.length / 3} notes`);
});

test('CSI = 7 requests carry their parameters (and no ctsmrr duplicate)', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${CSI}6n${CSI}=7n${CSI}=7;3n${CSI}=7;100n${CSI}=6n`));
    const ev = events(c).filter(e => e.t === 'req');
    assert.deepEqual(ev.map(e => e.k), ['cpr', 'audio', 'audio', 'audio', 'ctsmrr']);
    assert.deepEqual(ev.slice(1, 4).map(e => e.params), [[7], [7, 3], [7, 100]]);
});

test('audio APCs arrive whole as raw bytes, in order; others stay log-only', () => {
    const c = new Core(80, 25, 'ansi');
    const big = 'A'.repeat(300000);
    const s = `${APC}SyncTERM:C;S;sfx/x.wav;${big}${ST}${APC}SyncTERM:Q;libsndfile${ST}${APC}other${ST}${APC}SyncTERM:C;L${ST}`;
    const b = bytes(s);
    // in 1000-byte chunks
    const ev = [];
    for (let i = 0; i < b.length; i += 1000) {
        c.feed(b.subarray(i, i + 1000));
        ev.push(...events(c));
    }
    const apc = ev.filter(e => e.t === 'apc');
    assert.equal(apc.length, 4);
    assert.equal(apc[0].n, 'SyncTERM:C;S;sfx/x.wav;'.length + big.length);
    assert.equal(apc[2].data, 'other');
    const first = c.take_apc();
    assert.equal(first.length, apc[0].n);
    assert.equal(Buffer.from(first.subarray(0, 23)).toString('latin1'), 'SyncTERM:C;S;sfx/x.wav;');
    assert.equal(Buffer.from(c.take_apc()).toString('latin1'), 'SyncTERM:Q;libsndfile');
    assert.equal(Buffer.from(c.take_apc()).toString('latin1'), 'SyncTERM:C;L');
    assert.equal(c.take_apc(), undefined);
});

test('audio APCs over the limit are reported and dropped', () => {
    const c = new Core(80, 25, 'ansi');
    c.set_apc_limit(1000);
    c.feed(bytes(`${APC}SyncTERM:A;LoadBlob;S=1;${'Q'.repeat(2000)}${ST}`));
    const ev = events(c);
    assert.deepEqual(ev, [{ t: 'apc', n: 2000 + 'SyncTERM:A;LoadBlob;S=1;'.length, over: true }]);
    assert.equal(c.take_apc(), undefined);
});

test('A;Wait stops the feed right after it; other APCs do not', () => {
    const c = new Core(80, 25, 'ansi');
    const s = `${APC}SyncTERM:A;Queue;C=2;S=0${ST}x${APC}SyncTERM:A;Wait;C=2${ST}after`;
    c.feed(bytes(s));
    assert.equal(c.fed(), s.indexOf('after'));
    assert.equal(row(c, 0), 'x');
    assert.equal(events(c).filter(e => e.t === 'apc').length, 2);
    c.feed(bytes('after'));
    assert.equal(row(c, 0), 'xafter');
});

test('sequences inside strings are not music or reports', () => {
    const c = new Core(80, 25, 'ansi');
    const [ev] = feedAll(c, `${ESC}]0;${CSI}|C${SO}${ST}${ESC}P0;0;0!z${CSI}=7n${ST}${APC}SyncTERM:Q;x${ESC}x${CSI}|${ST}ok`);
    assert.equal(ev.filter(e => e.t === 'music' || (e.t === 'req' && e.k === 'audio')).length, 0);
    assert.equal(row(c, 0), 'ok');
});

test('APC SyncTERM:Q;JXL is a request (answered "no": inline images are off)', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${APC}SyncTERM:Q;JXL${ST}`));
    assert.deepEqual(events(c), [{ t: 'req', k: 'jxl' }]);
});

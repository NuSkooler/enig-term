// Unit tests for the TS shell modules that need no DOM: Telnet negotiation,
// host-query replies and input encoding. Node 22 strips the TS types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TelnetClient, IAC } from '../src/telnet.ts';
import { replyFor, daReply, ctdaReply, ESC } from '../src/replies.ts';
import { encode } from '../src/encoding.ts';

const DO = 253, DONT = 254, WILL = 251, WONT = 252, SB = 250, SE = 240;
const CSI = ESC + '[';

test('ENiGMA opening volley gets the same answers Xibalba sent', () => {
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

test('TTYPE send, escaped 0xFF data, IAC split across chunks', () => {
    const t = new TelnetClient({ termType: 'ansi-bbs', getSize: () => ({ cols: 80, rows: 25 }) });
    const r = t.receive(new Uint8Array([IAC, SB, 24, 1, IAC, SE])).reply;
    assert.equal(Buffer.from(r.slice(4, -2)).toString('latin1'), 'ansi-bbs');
    assert.deepEqual([...t.receive(new Uint8Array([0x41, IAC])).data], [0x41]);
    assert.deepEqual([...t.receive(new Uint8Array([IAC, 0x42])).data], [0xff, 0x42]);
    assert.deepEqual([...TelnetClient.escape(new Uint8Array([1, 0xff, 2]))], [1, 0xff, 0xff, 2]);
});

test('NAWS on resize only after NAWS was negotiated; 255 escaped', () => {
    let size = { cols: 80, rows: 25 };
    const t = new TelnetClient({ getSize: () => size });
    assert.equal(t.buildResize(), null);
    t.receive(new Uint8Array([IAC, DO, 31]));
    size = { cols: 255, rows: 50 };
    assert.deepEqual([...t.buildResize()], [IAC, SB, 31, 0, 255, 255, 0, 50, IAC, SE]);
});

test('DA reply is "enig-term" in decimal ASCII plus 0;1;0', () => {
    assert.equal(daReply(), `${CSI}=101;110;105;103;45;116;101;114;109;0;1;0c`);
    assert.equal(replyFor({ t: 'req', k: 'da' }), daReply());
    assert.equal(ctdaReply(), `${CSI}<0;1;2;4c`);
});

test('CPR, 255n, CTerm reports', () => {
    assert.equal(replyFor({ t: 'req', k: 'cpr', row: 5, col: 10 }), `${CSI}5;10R`);
    assert.equal(replyFor({ t: 'req', k: 'size', rows: 25, cols: 80 }), `${CSI}25;80R`);
    assert.equal(replyFor({ t: 'req', k: 'ctsmrr', n: 6 }), `${CSI}=6;1n`);
    assert.equal(replyFor({ t: 'req', k: 'ctsmrr', n: 9 }), `${CSI}=9;0n`);
    assert.equal(replyFor({ t: 'req', k: 'fontstate', result: 0, slots: [42, 0, 0, 0] }), `${CSI}=1;43;0;42;0;0;0n`);
    assert.equal(replyFor({ t: 'req', k: 'fontmode', modes: [] }), `${CSI}=2;n`);
    assert.equal(replyFor({ t: 'req', k: 'fontdim', h: 16, w: 8 }), `${CSI}=3;16;8n`);
    assert.equal(replyFor({ t: 'bell' }), null);
});

test('input encoding: CP437 by default, Latin-1 under Amiga fonts', () => {
    const s = 'A' + String.fromCharCode(0xe9, 0xfc, 0x2591, 0x20ac);
    assert.deepEqual([...encode(s, 'cp437')], [0x41, 0x82, 0x81, 0xb0, 0x3f]);
    assert.deepEqual([...encode(s, 'latin1')], [0x41, 0xe9, 0xfc, 0x3f, 0x3f]);
});

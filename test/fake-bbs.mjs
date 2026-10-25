// A fake BBS for the browser tests: a minimal RFC 6455 WebSocket server that
// speaks Telnet the way ENiGMA's WebSocket login server does (IAC negotiation
// inside binary frames), runs a small script per connection, and records what
// the client sent. Mounted by scripts/serve.mjs at /fake-bbs.
//
//   ws://127.0.0.1:<port>/fake-bbs?script=<name>&id=<test id>
//   GET /fake-bbs/log?id=<test id>   -> JSON: [{ conn, sent: number[], events: string[] }]
//
// Scripts: "probe" (ENiGMA-like volley and probes), "echo" (echoes data),
// "close" (closes after the greeting), "panic" (sends CSI ? 2026 h when the
// client types "p"), "links" (OSC 8 text), "flood" (many lines).
import crypto from 'node:crypto';

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const ESC = '\x1b';
const CSI = ESC + '[';
const ST = ESC + '\\';

const logs = new Map(); // id -> [{ conn, sent, events }]

function frame(payload, opcode = 2) {
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x80 | opcode;
        head[1] = 126;
        head.writeUInt16BE(len, 2);
    } else {
        head = Buffer.alloc(10);
        head[0] = 0x80 | opcode;
        head[1] = 127;
        head.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([head, payload]);
}

function bytes(s) {
    return Buffer.from(s, 'latin1');
}

/** Parse client frames out of `buf`; returns [frames, rest]. */
function parseFrames(buf) {
    const out = [];
    let off = 0;
    for (;;) {
        if (buf.length - off < 2) break;
        const b0 = buf[off];
        const b1 = buf[off + 1];
        let len = b1 & 0x7f;
        let p = off + 2;
        if (len === 126) {
            if (buf.length - p < 2) break;
            len = buf.readUInt16BE(p);
            p += 2;
        } else if (len === 127) {
            if (buf.length - p < 8) break;
            len = Number(buf.readBigUInt64BE(p));
            p += 8;
        }
        const masked = (b1 & 0x80) !== 0;
        const mask = masked ? buf.subarray(p, p + 4) : null;
        if (masked) p += 4;
        if (buf.length - p < len) break;
        const data = Buffer.from(buf.subarray(p, p + len));
        if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
        out.push({ opcode: b0 & 0x0f, data });
        off = p + len;
    }
    return [out, buf.subarray(off)];
}

export function handleLog(req, res) {
    const id = new URL(req.url, 'http://x').searchParams.get('id') ?? '';
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(logs.get(id) ?? []));
}

export function handleUpgrade(req, socket) {
    const url = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    if (!key || url.pathname !== '/fake-bbs') {
        socket.destroy();
        return;
    }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const protos = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(s => s.trim());
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n` +
            (protos.includes('telnet') ? 'Sec-WebSocket-Protocol: telnet\r\n' : '') +
            '\r\n',
    );
    const id = url.searchParams.get('id') ?? '';
    const script = url.searchParams.get('script') ?? 'probe';
    const list = logs.get(id) ?? [];
    logs.set(id, list);
    const rec = { conn: list.length, sent: [], events: [] };
    list.push(rec);
    const send = s => {
        if (!socket.destroyed) socket.write(frame(typeof s === 'string' ? bytes(s) : s));
    };
    const close = () => {
        if (!socket.destroyed) {
            socket.write(frame(Buffer.from([0x03, 0xe8]), 8));
            socket.end();
        }
    };
    let rest = Buffer.alloc(0);
    // Telnet de-framing of what the client sends, to log negotiation separately.
    let tstate = 0;
    let sb = [];
    const onClientBytes = data => {
        for (const b of data) {
            if (tstate === 0) {
                if (b === IAC) tstate = 1;
                else {
                    rec.sent.push(b);
                    onData(b);
                }
            } else if (tstate === 1) {
                if (b === IAC) {
                    rec.sent.push(255);
                    tstate = 0;
                } else if (b >= WILL && b <= DONT) {
                    tstate = 10 + (b - WILL);
                } else if (b === SB) {
                    sb = [];
                    tstate = 2;
                } else tstate = 0;
            } else if (tstate >= 10) {
                rec.events.push(`${['WILL', 'WONT', 'DO', 'DONT'][tstate - 10]} ${b}`);
                tstate = 0;
            } else if (tstate === 2) {
                if (b === IAC) tstate = 3;
                else sb.push(b);
            } else if (tstate === 3) {
                if (b === SE) {
                    if (sb[0] === 31) rec.events.push(`NAWS ${(sb[1] << 8) | sb[2]}x${(sb[3] << 8) | sb[4]}`);
                    else if (sb[0] === 24) rec.events.push(`TTYPE ${Buffer.from(sb.slice(2)).toString('latin1')}`);
                    else rec.events.push(`SB ${sb.join(',')}`);
                    tstate = 0;
                } else {
                    sb.push(b);
                    tstate = 2;
                }
            }
        }
    };
    const onData = b => {
        if (script === 'echo') send(Buffer.from([b]));
        if (script === 'panic' && b === 0x70) {
            send(`${CSI}?2026h`);
            setTimeout(() => send(`${CSI}5;1Hafter the panic`), 300);
        }
    };
    socket.on('data', chunk => {
        const [frames, r] = parseFrames(Buffer.concat([rest, chunk]));
        rest = r;
        for (const f of frames) {
            if (f.opcode === 8) {
                rec.events.push('client close');
                close();
            } else if (f.opcode === 2 || f.opcode === 1) onClientBytes(f.data);
        }
    });
    socket.on('error', () => {});
    socket.on('close', () => rec.events.push('closed'));

    // ENiGMA's opening volley, then the connect probes.
    send(Buffer.from([IAC, DONT, 1, IAC, WILL, 1, IAC, WILL, 3, IAC, DO, 3, IAC, DO, 0, IAC, WILL, 0, IAC, DO, 24, IAC, DO, 31, IAC, DO, 39]));
    send(Buffer.from([IAC, SB, 24, 1, IAC, SE]));
    setTimeout(() => {
        send(`${CSI}0c${CSI}<c${CSI}6n${CSI}5n${CSI}=6n${CSI}999;999H${CSI}255n${CSI}H${CSI}2J`);
        send(`${CSI}1;37mfake-bbs${CSI}0m script=${script}\r\n`);
        if (script === 'close') setTimeout(close, 200);
        if (script === 'links') send(`see ${ESC}]8;;https://example.com/some/long/path?q=1${ST}the docs${ESC}]8;;${ST} or ${ESC}]8;;javascript:alert(1)${ST}this${ESC}]8;;${ST}\r\n`);
        if (script === 'flood') for (let i = 0; i < 100; i++) send(`flood line ${i}\r\n`);
        if (script === 'panic') send('type p to panic\r\n');
    }, 50);
}

// Read members of a ZIP archive (stored or deflated), enough for the font
// packs the build and the Amiga-font fetch script download. Our own code
// (BSD-2-Clause).
import { inflateRawSync } from 'node:zlib';

/** Map of member name -> () => Uint8Array. */
export function readZip(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('zip: no end of central directory');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = new Map();
    for (let n = 0; n < count; n++) {
        if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip: bad central directory');
        const method = dv.getUint16(p + 10, true);
        const csize = dv.getUint32(p + 20, true);
        const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
        const local = dv.getUint32(p + 42, true);
        const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        out.set(name, () => {
            const lNameLen = dv.getUint16(local + 26, true), lExtraLen = dv.getUint16(local + 28, true);
            const data = buf.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + csize);
            if (method === 0) return data.slice();
            if (method === 8) return new Uint8Array(inflateRawSync(data));
            throw new Error(`zip: ${name}: unsupported method ${method}`);
        });
    }
    return out;
}

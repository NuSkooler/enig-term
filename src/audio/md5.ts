// MD5 (RFC 1321), for the CTerm cache listing (`SyncTERM:C;L` reports an MD5
// per file, which hosts compare to decide whether to upload). Web Crypto has
// no MD5. Not used for anything security related.

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;

/** Lower-case hex MD5 of `data`. */
export function md5hex(data: Uint8Array): string {
    const len = data.length;
    // Padding: 0x80, zeros to 56 mod 64, then the bit length (little endian).
    const total = (((len + 8) >>> 6) + 1) << 6;
    const tail = new Uint8Array(total - (len & ~63));
    tail.set(data.subarray(len & ~63));
    tail[len & 63] = 0x80;
    const bits = len * 8;
    const dv = new DataView(tail.buffer);
    dv.setUint32(tail.length - 8, bits >>> 0, true);
    dv.setUint32(tail.length - 4, Math.floor(bits / 2 ** 32), true);

    let a0 = 0x67452301 | 0;
    let b0 = 0xefcdab89 | 0;
    let c0 = 0x98badcfe | 0;
    let d0 = 0x10325476 | 0;
    const M = new Int32Array(16);
    const full = len & ~63;
    const blocks = full / 64 + tail.length / 64;
    for (let blk = 0; blk < blocks; blk++) {
        const off = blk * 64;
        if (off < full) {
            for (let j = 0; j < 16; j++) {
                const p = off + j * 4;
                M[j] = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24);
            }
        } else {
            const o = off - full;
            for (let j = 0; j < 16; j++) M[j] = dv.getInt32(o + j * 4, true);
        }
        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;
        for (let i = 0; i < 64; i++) {
            let f: number;
            let g: number;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            } else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) & 15;
            } else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) & 15;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) & 15;
            }
            const x = (f + a + K[i] + M[g]) | 0;
            a = d;
            d = c;
            c = b;
            b = (b + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
        }
        a0 = (a0 + a) | 0;
        b0 = (b0 + b) | 0;
        c0 = (c0 + c) | 0;
        d0 = (d0 + d) | 0;
    }
    let hex = '';
    for (const w of [a0, b0, c0, d0]) for (let i = 0; i < 4; i++) hex += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    return hex;
}

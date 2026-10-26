// Tone generation: the CTerm `Synth` verb's waveforms, and CTerm "ANSI"
// music notes. Pure functions that return mono PCM (Float32Array, -1..1).
//
// `Synth` shapes reproduce what SyncTERM's tone generator makes for each
// name (they are part of what the BBS asked to hear): SIN, SAW (a downward
// ramp), SQ, and the four "noisy" shapes, which SyncTERM computes in 8-bit
// unsigned arithmetic that wraps (SINE_HARM, for instance, comes out close
// to a square wave at three times F). Like SyncTERM, a tone ends on a whole
// wave and the first and last few zero crossings are softened, so it does
// not click.

import type { Shape } from './apc.ts';

const TAU = Math.PI * 2;

/** Equal-tempered frequency of CTerm note number n (0 = C in octave 0, 65.406 Hz; 33 = A, 440 Hz). */
export function noteHz(n: number): number {
    return 440 * Math.pow(2, (n - 33) / 12);
}

/** 8-bit wrap the way a C double -> unsigned char conversion does on common targets. */
const u8 = (x: number) => Math.trunc(x) & 0xff;

export function synthShape(shape: Shape, freq: number, seconds: number, rate: number): Float32Array {
    const n = Math.max(0, Math.round(seconds * rate));
    const out = new Float32Array(n);
    if (!n || shape === 'SILENCE' || !(freq > 0)) return out;
    const inc = (TAU * freq) / rate;
    for (let i = 0; i < n; i++) {
        let pos = inc * i;
        pos -= Math.floor(pos / TAU) * TAU;
        let v: number;
        switch (shape) {
            case 'SIN':
                v = Math.sin(pos);
                break;
            case 'SAW':
                v = 1 - (pos / TAU) * 2;
                break;
            case 'SQ':
                v = pos < Math.PI ? 1 : -1;
                break;
            case 'SINE_HARM': {
                // Only the last of SyncTERM's three assignments survives.
                const b = u8(Math.sin(inc * 3 * i) * 16);
                v = (b - 128) / 128;
                break;
            }
            case 'SINE_SAW': {
                const b = u8((Math.sin(pos) * 127 + 128 + (TAU - pos) * 40.5) / 2);
                v = (b - 128) / 128;
                break;
            }
            case 'SINE_SAW_CHORD': {
                let b = u8((Math.sin(pos) * 64 + 128 + (TAU - pos) * 6.2) / 2);
                b = u8(b + Math.sin((inc / 2) * i) * 24);
                b = u8(b + Math.sin((inc / 3) * i) * 16);
                v = (b - 128) / 128;
                break;
            }
            case 'SINE_SAW_HARM':
            default: {
                let b = u8((Math.sin(pos) * 64 + 128 + (TAU - pos) * 6.2) / 2);
                b = u8(b + Math.sin(inc * 2 * i) * 24);
                b = u8(b + Math.sin(inc * 3 * i) * 16);
                v = (b - 128) / 128;
                break;
            }
        }
        out[i] = v;
    }
    declick(out, freq);
    return out;
}

/** End on a whole wave, and soften the first and last ~freq/100 zero crossings. */
function declick(w: Float32Array, freq: number): void {
    const n = w.length;
    if (n < 4) return;
    const mid = n >> 1;
    const endHigh = w[n - 1] > 0;
    if (w[n - 1] !== 0) {
        for (let i = n - 1; i > mid; i--) {
            if (endHigh ? w[i] < 0 : w[i] > 0) break;
            w[i] = 0;
        }
    }
    const cross = Math.floor(freq / 100);
    if (!cross) return;
    let c = 0;
    for (let i = 0; i < n - 1; i++) {
        if (i > 2 && ((w[i] < 0 && w[i + 1] >= 0) || (w[i] > 0 && w[i + 1] <= 0)) && ++c >= cross) break;
        const d = cross - c;
        w[i] /= d * d;
    }
    c = 0;
    for (let i = n - 1; i > 0; i--) {
        if (i > 2 && ((w[i] < 0 && w[i - 1] >= 0) || (w[i] > 0 && w[i - 1] <= 0)) && ++c >= cross) break;
        const d = cross - c;
        w[i] /= d * d;
    }
}

export type MusicTone = 'square' | 'syncterm' | 'sine';

/** Longest stretch of "ANSI" music rendered from one string (seconds). */
export const MUSIC_MAX_SECONDS = 120;

/**
 * Render CTerm music notes (flat [note, on ms, off ms, ...]; note -1 is a
 * rest) to mono PCM. "square" is a band-limited square (the PC speaker the
 * music was written for), "syncterm" SyncTERM's SINE_SAW_HARM timbre, "sine"
 * a plain sine. Durations use CTerm's integer milliseconds per note, as
 * whole frames, so long strings do not drift.
 */
export function renderMusic(notes: readonly number[], rate: number, tone: MusicTone = 'square'): Float32Array {
    let frames = 0;
    const max = Math.floor(MUSIC_MAX_SECONDS * rate);
    const spans: [number, number, number][] = [];
    for (let i = 0; i + 2 < notes.length; i += 3) {
        const on = Math.floor((rate * Math.max(0, notes[i + 1])) / 1000);
        const off = Math.floor((rate * Math.max(0, notes[i + 2])) / 1000);
        if (frames + on + off > max) break;
        spans.push([notes[i], on, off]);
        frames += on + off;
    }
    const out = new Float32Array(frames);
    let at = 0;
    const ramp = Math.max(1, Math.round(rate * 0.002));
    for (const [n, on, off] of spans) {
        if (n >= 0 && on > 0) {
            const f = noteHz(n);
            if (tone === 'syncterm') {
                out.set(synthShape('SINE_SAW_HARM', f, on / rate, rate).subarray(0, on), at);
            } else {
                const dt = f / rate;
                let ph = 0;
                for (let i = 0; i < on; i++) {
                    let v: number;
                    if (tone === 'sine') v = Math.sin(TAU * ph) * 0.8;
                    else {
                        // PolyBLEP square: the edges are band-limited, so high notes do not alias harshly.
                        v = ph < 0.5 ? 1 : -1;
                        v += blep(ph, dt);
                        v -= blep((ph + 0.5) % 1, dt);
                        v *= 0.5;
                    }
                    const edge = Math.min(1, i / ramp, (on - 1 - i) / ramp);
                    out[at + i] = v * edge;
                    ph += dt;
                    if (ph >= 1) ph -= 1;
                }
            }
        }
        at += on + off;
    }
    return out;
}

function blep(t: number, dt: number): number {
    if (t < dt) {
        t /= dt;
        return t + t - t * t - 1;
    }
    if (t > 1 - dt) {
        t = (t - 1) / dt;
        return t * t + t + t + 1;
    }
    return 0;
}

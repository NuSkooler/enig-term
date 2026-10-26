// The key interop evidence: ansi-bbs-utils 0.2.1's own host side (Terminal,
// term.probeAudio(), term.audio.asset/play/volume/stop: what a BBS using the
// library calls) drives enig-term over a real WebSocket with Telnet
// (test/fake-bbs.mjs, script "abu"). The page records what it played (a tap
// on the mix) and the test checks the tones were heard when the host played
// them, the host got its probe, format and idle answers, and a reconnect
// uploads nothing again (the cache is in IndexedDB).
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { open, SHOTS } from './helpers';

const PORT = Number(process.env.ENIG_TERM_PORT ?? 8090);

async function hostLog(page: Page, id: string): Promise<{ conn: number; events: string[] }[]> {
    return page.evaluate(async id => (await fetch(`/fake-bbs/log?id=${id}`)).json(), id);
}

/** Wait for the engine, then record the mix in blocks with their audio time. */
async function record(page: Page) {
    await page.waitForFunction(() => !!(window as any).enigTerm.sound.engine, null, { timeout: 15_000 });
    await page.evaluate(() => {
        const e = (window as any).enigTerm.sound.engine;
        const ctx = e.out.ctx as AudioContext;
        const sp = ctx.createScriptProcessor(4096, 1, 1);
        const blocks: { t: number; wall: number; d: Float32Array }[] = [];
        sp.onaudioprocess = ev => blocks.push({ t: ev.playbackTime, wall: Date.now(), d: ev.inputBuffer.getChannelData(0).slice() });
        e.out.mix.connect(sp);
        sp.connect(ctx.destination);
        (window as any).blocks = blocks;
        (window as any).keep = sp;
        // When the engine actually queued and flushed (wall clock), to line up with the host's log.
        const q: string[] = ((window as any).played = []);
        const m = e.mixer;
        const queue = m.queue.bind(m);
        m.queue = (o: { ch: number }) => (q.push(`${Date.now()} queue ${o.ch}`), queue(o));
        const flush = m.flush.bind(m);
        m.flush = (ch: number, f: number) => (q.push(`${Date.now()} flush ${ch}`), flush(ch, f));
        const volume = m.volume.bind(m);
        m.volume = (ch: number, l: number, r: number, t: number) => (q.push(`${Date.now()} volume ${ch}`), volume(ch, l, r, t));
    });
}

/** Amplitude of `f` Hz in the recording between wall-clock times a and b (ms). */
function toneBetween(page: Page, f: number, a: number, b: number) {
    return page.evaluate(
        ({ f, a, b }) => {
            const blocks = (window as any).blocks as { t: number; wall: number; d: Float32Array }[];
            const rate = ((window as any).enigTerm.sound.engine.out.ctx as AudioContext).sampleRate;
            const sel = blocks.filter(x => x.wall >= a && x.wall <= b);
            if (!sel.length) return -1;
            const k = (2 * Math.PI * f) / rate;
            let s1 = 0;
            let s2 = 0;
            let n = 0;
            for (const blk of sel)
                for (const v of blk.d) {
                    const s0 = v + 2 * Math.cos(k) * s1 - s2;
                    s2 = s1;
                    s1 = s0;
                    n++;
                }
            return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - 2 * Math.cos(k) * s1 * s2))) / n;
        },
        { f, a, b },
    );
}

test('ansi-bbs-utils 0.2.1 (host) <-> enig-term over WebSocket: probe, formats, upload once, music, effects, idle, stop', async ({ page }, ti) => {
    test.setTimeout(90_000);
    const id = `abu-${ti.project.name}-${Date.now()}`;
    await open(page);
    // A clean cache, so the first session uploads.
    await page.evaluate(() => (window as any).enigTerm.sound.clearCache());
    const url = `ws://127.0.0.1:${PORT}/fake-bbs?script=abu&id=${id}`;
    await page.evaluate(u => (window as any).enigTerm.connect(u), url);
    await record(page);
    await expect.poll(async () => (await hostLog(page, id))[0]?.events.some(e => e.endsWith(' done') || e.includes('abu error')), { timeout: 30_000 }).toBe(true);
    const ev = (await hostLog(page, id))[0].events.filter(e => /^\d+ /.test(e));
    const at = (name: string) => Number(ev.find(e => e.endsWith(` ${name}`))?.split(' ')[0] ?? NaN);
    const names = ev.map(e => e.slice(e.indexOf(' ') + 1));
    const clientLog = await page.evaluate(() => (window as any).enigTerm.log.filter((l: string) => /audio|sound/.test(l)));
    fs.writeFileSync(path.join(SHOTS, `${ti.project.name}-abu-client-log.txt`), clientLog.join('\n') + '\n');
    const played: string[] = await page.evaluate(() => (window as any).played);
    fs.writeFileSync(path.join(SHOTS, `${ti.project.name}-abu-host-log.txt`), ev.join('\n') + '\n--- client\n' + played.join('\n') + '\n');
    expect(names).toContain('probe cterm files=true');
    expect(names).toContain('vorbis true');
    expect(names).toContain('mp3 true');
    expect(names.filter(n => n === 'idle 3').length, 'the effect on channel 3 reported idle').toBeGreaterThanOrEqual(1);
    expect(names).toContain('idle 2'); // the music channel after stop()
    expect(names).toContain('uploads 3');
    expect(names.some(n => n.startsWith('abu error'))).toBe(false);

    // When the terminal acted on them (after the upload, decode and so on).
    const acted = (what: string, nth = 0) => Number(played.filter(p => p.endsWith(` ${what}`))[nth]?.split(' ')[0] ?? NaN);
    const t = { music: acted('queue 2'), sfx: acted('queue 3'), ogg: acted('queue 4'), volume: acted('volume 2'), cross: acted('queue 2', 1), flush: acted('flush 2') };
    const lag = { music: t.music - at('music'), sfx: t.sfx - at('sfx'), ogg: t.ogg - at('ogg'), volume: t.volume - at('volume'), cross: t.cross - at('crossfade'), flush: t.flush - at('stop') };
    // What was heard (the mix, before master volume), then.
    const music = await toneBetween(page, 440, t.music + 200, t.sfx - 50);
    const hit = await toneBetween(page, 880, t.sfx + 20, t.sfx + 180);
    const quiet = await toneBetween(page, 440, t.volume + 400, t.cross - 50);
    const crossed = await toneBetween(page, 440, t.cross + 500, t.flush - 50);
    const after = await toneBetween(page, 440, t.flush + 450, at('done'));
    fs.writeFileSync(path.join(SHOTS, `${ti.project.name}-abu-heard.json`), JSON.stringify({ music, hit, quiet, crossed, after, lagMs: lag }, null, 1));
    // The WAVs peak at 0.61; per-play volume 100 (0 dB) on the channel's default -12 dB: 0.153.
    expect(music).toBeGreaterThan(0.13);
    expect(music).toBeLessThan(0.17);
    expect(hit).toBeGreaterThan(0.05);
    // music.volume(10): the channel base goes to -20 dB, 8 dB below the default.
    expect(quiet / music).toBeGreaterThan(0.36);
    expect(quiet / music).toBeLessThan(0.44);
    // The crossfaded loop plays on the same channel, still at -20 dB.
    expect(crossed / music).toBeGreaterThan(0.36);
    expect(crossed / music).toBeLessThan(0.44);
    expect(after).toBeLessThan(0.005);

    // Reconnect: the board finds its files in the cache and uploads nothing.
    await page.evaluate(() => (window as any).enigTerm.disconnect());
    await page.evaluate(u => (window as any).enigTerm.connect(u), url);
    await expect.poll(async () => (await hostLog(page, id))[1]?.events.some(e => e.endsWith(' done') || e.includes('abu error')), { timeout: 30_000 }).toBe(true);
    const names2 = (await hostLog(page, id))[1].events.map(e => e.slice(e.indexOf(' ') + 1));
    expect(names2).toContain('probe cterm files=true');
    expect(names2).toContain('uploads 0');
    expect(names2).toContain('idle 3');
});

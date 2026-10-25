// Measurements: full-frame cost (engine raster + upload + draw), small
// incremental updates, scrolling, and feed throughput. Results go to
// docs/spike/bench-<browser>.json. Not a pass/fail test.
import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'docs', 'spike');

test('bench', async ({ page }, ti) => {
    test.skip(!process.env.ENIG_TERM_BENCH, 'set ENIG_TERM_BENCH=1 (npm run bench)');
    test.setTimeout(180_000);
    await page.goto('/?blink=0');
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    const card = new Uint8Array(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'cp437-testcard.ans')));
    const r = await page.evaluate(async cardBytes => {
        const t = (window as any).enigTerm;
        const core = t.core.core;
        const ESC = String.fromCharCode(27);
        const enc = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);
        const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
        const gl = t.canvas.getContext('webgl2');
        let glRenderer = 'n/a';
        if (gl) {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            glRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        }
        t.write(new Uint8Array(cardBytes));

        // performance.now() is coarsened (0.1 ms Chromium, 1 ms WebKit/Firefox
        // without cross-origin isolation), so every cost is timed over a batch.
        const N = 300;
        const batch = (fn: (i: number) => void) => {
            const a = performance.now();
            for (let i = 0; i < N; i++) fn(i);
            return (performance.now() - a) / N;
        };
        const finish = () => t.renderer.finish();
        // Engine raster, texture upload and GPU draw measured separately.
        // Let the browser present between phases: piling thousands of uploads
        // and draws into one task without a present made SwiftShader's uploads
        // ~1000x slower after a few phases (order-dependent artifact).
        const presented = () => new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 0)));
        const phases = async (setup: (i: number) => void, full: boolean) => {
            await presented();
            // Engine cost = (write + render) minus write alone.
            const writeOnly = batch(i => setup(i));
            t.core.render(true);
            const both = batch(i => {
                setup(i);
                t.core.render(full);
            });
            // One representative render result for the upload measurement.
            setup(0);
            const r1 = t.core.render(full);
            const band = r1.pixels ? r1.pixels.slice() : null;
            await presented();
            const idle = batch(() => finish());
            const upload = band
                ? batch(() => {
                      t.renderer.upload(band, r1.frameW, r1.frameH, r1.y, r1.h);
                      finish();
                  }) - idle
                : 0;
            await presented();
            const draw = batch(() => {
                (t as any).draw();
                finish();
            });
            return { kind: r1.kind, bandHeightPx: r1.h, writeMs: writeOnly, engineMs: Math.max(0, both - writeOnly), uploadMs: Math.max(0, upload), drawMs: draw };
        };
        const tot = (o: any) => ({ ...o, totalMs: o.engineMs + o.uploadMs + o.drawMs });
        for (let i = 0; i < 20; i++) t.renderFrame(true); // warm-up

        const full = tot(await phases(() => {}, true));
        const oneChar = tot(await phases(i => t.write(enc(`${ESC}[12;${(i % 70) + 1}H${String.fromCharCode(65 + (i % 26))}`)), false));
        const oneLine = tot(await phases(i => t.write(enc(`${ESC}[${(i % 24) + 1};1H${'x'.repeat(80)}`)), false));
        const scroll = tot(await phases(i => t.write(enc(`${ESC}[25;1Hline ${i}\r\n`)), false));
        const cursorOnly = tot(await phases(i => t.write(enc(`${ESC}[${(i % 24) + 1};${(i % 79) + 1}H`)), false));
        t.setCrt(true);
        const fullCrt = tot(await phases(() => {}, true));
        t.setCrt(false);
        const frame = (full: boolean) => {
            const res = t.core.render(full);
            if (res.kind && res.pixels) t.renderer.upload(res.pixels, res.frameW, res.frameH, res.y, res.h);
            (t as any).draw();
            finish();
        };
        core.set_scrollback_limit(0); // keep memory flat during the throughput runs

        // Feed throughput, no rendering: synthetic BBS-style ANSI.
        let s = '';
        for (let i = 0; s.length < 2_000_000; i++) {
            s += `${ESC}[${(i % 24) + 1};${(i % 40) + 1}H${ESC}[${i & 1};${30 + (i % 8)};${40 + ((i >> 3) % 8)}m`;
            for (let k = 0; k < 40; k++) s += String.fromCharCode(k % 3 === 0 ? 0xb0 + (k % 4) : 0x41 + ((i + k) % 26));
            if (i % 7 === 0) s += '\r\n';
        }
        const synth = enc(s);
        const chunk = 4096;
        let a = performance.now();
        for (let o = 0; o < synth.length; o += chunk) core.feed(synth.subarray(o, o + chunk));
        const feedMBs = synth.length / 1e6 / ((performance.now() - a) / 1000);

        // Plain text that scrolls (a file listing / chat log).
        let txt = '';
        for (let i = 0; txt.length < 2_000_000; i++) txt += `${String(i).padStart(6)} The quick brown fox jumps over the lazy dog ${ESC}[1;3${i % 8}mOK${ESC}[0m\r\n`;
        const tb = enc(txt);
        a = performance.now();
        for (let o = 0; o < tb.length; o += chunk) core.feed(tb.subarray(o, o + chunk));
        const scrollFeedMBs = tb.length / 1e6 / ((performance.now() - a) / 1000);

        // Realistic: feed a 4 KB chunk then render what changed, as the frame loop does.
        a = performance.now();
        let frames = 0;
        for (let o = 0; o < tb.length; o += chunk) {
            core.feed(tb.subarray(o, o + chunk));
            frame(false);
            frames++;
        }
        const feedRenderMBs = tb.length / 1e6 / ((performance.now() - a) / 1000);

        // The real art file, many times.
        a = performance.now();
        for (let i = 0; i < 200; i++) core.feed(new Uint8Array(cardBytes));
        const artMBs = (cardBytes.length * 200) / 1e6 / ((performance.now() - a) / 1000);

        return {
            userAgent: navigator.userAgent,
            renderer: t.renderer.kind,
            glRenderer,
            canvas: [t.canvas.width, t.canvas.height],
            frame: [core.frame_width(), core.frame_height()],
            full,
            fullCrt,
            oneChar,
            oneLine,
            scroll,
            cursorOnly,
            feed: { synthMB: synth.length / 1e6, feedMBs, scrollFeedMBs, feedRenderMBs, framesInFeedRender: frames, artMBs },
        };
    }, Array.from(card));
    fs.writeFileSync(path.join(OUT, `bench-${ti.project.name}.json`), JSON.stringify(r, null, 2) + '\n');
    console.log(ti.project.name, JSON.stringify(r));
});

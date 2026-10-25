// Live wiring against a running ENiGMA ws:// login server. Skipped unless
// ENIG_TERM_LIVE_WS is set, e.g. ENIG_TERM_LIVE_WS=ws://127.0.0.1:18810
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const WS = process.env.ENIG_TERM_LIVE_WS;
const OUT = path.join(process.cwd(), 'docs', 'spike');

const VARIANTS = [
    { name: 'default', query: '', note: 'NAWS on, enig-term DA' },
    // ENiGMA only asks CSI 255 n when NAWS gave it no size.
    { name: 'no-naws', query: '&naws=0', note: 'NAWS refused: exercises CSI 999;999H + CSI 255 n' },
    // ENiGMA only sends CSI = 6 n to clients it identified as CTerm.
    { name: 'cterm-da', query: '&debugDa=cterm', note: 'test-only CTerm-shaped DA: exercises CSI = 6 n' },
];

for (const v of VARIANTS) test(`live ENiGMA (${v.name}): connect probes, pre-login screen`, async ({ page }, ti) => {
    test.skip(!WS, 'set ENIG_TERM_LIVE_WS to run');
    test.skip(ti.project.name !== 'chromium', 'live run on chromium only');
    test.setTimeout(90_000);
    await page.goto(`/?blink=0${v.query}`);
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    await page.evaluate(ws => (window as any).enigTerm.connect(ws), WS!);

    // Wait until data has flowed and the stream has been quiet for 3 s.
    let last = -1;
    let quietSince = Date.now();
    const start = Date.now();
    for (;;) {
        const n: number = await page.evaluate(() => (window as any).enigTerm.stats.bytesIn);
        if (n !== last) {
            last = n;
            quietSince = Date.now();
        }
        if (n > 2000 && Date.now() - quietSince > 3000) break;
        if (Date.now() - start > 60_000) break;
        await page.waitForTimeout(250);
    }
    const res = await page.evaluate(() => {
        const t = (window as any).enigTerm;
        t.renderFrame(true);
        return { log: t.log as string[], stats: t.stats, connected: t.connected, cols: t.core.cols, rows: t.core.rows };
    });
    fs.writeFileSync(path.join(OUT, `live-enigma-${v.name}-log.txt`), `# ${v.note}\n` + res.log.join('\n') + '\n');
    console.log(JSON.stringify({ ...res, log: res.log.length }));
    await page.locator('canvas').screenshot({ path: path.join(OUT, `chromium-live-enigma-${v.name}.png`) });
    expect(res.connected).toBe(true);
    expect(res.log.some(l => l.includes('"k":"da"'))).toBe(true);
    expect(res.log.some(l => l.includes('"k":"cpr"'))).toBe(true);

    if (v.name === 'no-naws') expect(res.log.some(l => l.includes('"k":"size"'))).toBe(true);
    if (v.name === 'cterm-da') expect(res.log.some(l => l.includes('"k":"ctsmrr"') && l.includes('=6;1n'))).toBe(true);

    // Resize sends NAWS; ENiGMA logs the new size.
    if (v.name === 'default') {
        await page.evaluate(() => (window as any).enigTerm.resize(100, 31));
        await page.waitForTimeout(1500);
    }
    await page.evaluate(() => (window as any).enigTerm.disconnect());
});

// Live wiring against a running ENiGMA ws:// login server (a throwaway
// instance, never the dev board). Skipped unless ENIG_TERM_LIVE_WS is set:
//   ENIG_TERM_LIVE_WS=ws://127.0.0.1:18810 npm run test:live
// The page is opened the way ENiGMA's /_enig/ws-term/ route documents it:
// ?endpoint=<ws url>&connect=1. Logs and screenshots go to test/screenshots/
// (gitignored: they show the board's theme art).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { SHOTS } from './helpers';

const WS = process.env.ENIG_TERM_LIVE_WS;

const VARIANTS = [
    { name: 'default', query: '', note: 'NAWS on, enig-term DA' },
    // ENiGMA only asks CSI 255 n when NAWS gave it no size.
    { name: 'no-naws', query: '&naws=0', note: 'NAWS refused: exercises CSI 999;999H + CSI 255 n' },
    // ENiGMA builds without enig-term support only send CSI = 6 n to CTerm.
    { name: 'cterm-da', query: '&debugDa=cterm', note: 'test-only CTerm-shaped DA: exercises CSI = 6 n' },
];

for (const v of VARIANTS) test(`live ENiGMA (${v.name}): connect probes, pre-login screen`, async ({ page }, ti) => {
    test.skip(!WS, 'set ENIG_TERM_LIVE_WS to run');
    test.skip(ti.project.name !== 'chromium', 'live run on chromium only');
    test.setTimeout(90_000);
    await page.goto(`/?blink=0&endpoint=${encodeURIComponent(WS!)}&connect=1${v.query}`);
    await page.waitForFunction(() => document.body.dataset.ready === '1');

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
        return { log: t.log as string[], stats: t.stats, state: t.state, cols: t.core.cols, rows: t.core.rows };
    });
    fs.writeFileSync(path.join(SHOTS, `live-enigma-${v.name}-log.txt`), `# ${v.note}\n` + res.log.join('\n') + '\n');
    console.log(JSON.stringify({ ...res, log: res.log.length }));
    await page.locator('enig-term').screenshot({ path: path.join(SHOTS, `chromium-live-enigma-${v.name}.png`) });
    expect(res.state).toBe('connected');
    expect(res.log.some(l => l.includes('"k":"da"'))).toBe(true);
    expect(res.log.some(l => l.includes('"k":"cpr"'))).toBe(true);
    if (v.name === 'no-naws') expect(res.log.some(l => l.includes('"k":"size"'))).toBe(true);
    if (v.name === 'cterm-da') expect(res.log.some(l => l.includes('"k":"ctsmrr"') && l.includes('=6;1n'))).toBe(true);

    if (v.name === 'default') {
        // Resize sends NAWS (ENiGMA logs the new size); typing reaches the board.
        await page.evaluate(() => (window as any).enigTerm.resize(100, 31));
        await page.waitForTimeout(1000);
        await page.evaluate(() => (window as any).enigTerm.resize(80, 25));
        await page.waitForTimeout(1000);
        // Scrollback holds what the board cleared.
        const sb = await page.evaluate(() => (window as any).enigTerm.core.core.scrollback_len());
        console.log('scrollback lines after connect:', sb);
    }
    await page.evaluate(() => (window as any).enigTerm.disconnect());
});

// The page as ENiGMA serves it: /_enig/ws-term/ with a generated config.json
// (endpoint, title, client extras such as autoConnect). Needs an ENiGMA with
// enig-term support and wsTerm.root pointing at this dist/:
//   ENIG_TERM_LIVE_PAGE=http://127.0.0.1:18080/_enig/ws-term/ npm run test:live
const PAGE = process.env.ENIG_TERM_LIVE_PAGE;
test('live ENiGMA route: generated config.json, autoConnect, enig-term recognised', async ({ page }, ti) => {
    test.skip(!PAGE, 'set ENIG_TERM_LIVE_PAGE to run');
    test.skip(ti.project.name !== 'chromium', 'live run on chromium only');
    test.setTimeout(90_000);
    const cfg = await (await page.request.get(new URL('config.json', PAGE!).href)).json();
    await page.goto(PAGE!);
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    await expect.poll(() => page.evaluate(() => (window as any).enigTerm.state), { timeout: 15_000 }).toBe('connected');
    expect(await page.title()).toBe(cfg.title);
    expect(await page.locator('enig-term').locator('[data-host]').inputValue()).toBe(new URL(cfg.endpoint).href);
    // An enig-term-aware ENiGMA asks CSI = 6 n of enig-term itself (no test hook).
    await expect.poll(() => page.evaluate(() => ((window as any).enigTerm.log as string[]).some(l => l.includes('"n":6') && l.includes('=6;1n'))), { timeout: 20_000 }).toBe(true);
    await page.waitForTimeout(3000);
    const log = await page.evaluate(() => (window as any).enigTerm.log as string[]);
    fs.writeFileSync(path.join(SHOTS, 'live-enigma-route-log.txt'), `# ${PAGE}\n# config.json: ${JSON.stringify(cfg)}\n` + log.join('\n') + '\n');
    await page.screenshot({ path: path.join(SHOTS, 'chromium-live-enigma-route.png') });
    await page.evaluate(() => (window as any).enigTerm.disconnect());
});

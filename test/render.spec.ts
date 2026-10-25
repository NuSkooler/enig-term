// Headless rendering tests: known CP437 art, a SAUCE file and the Amiga
// Topaz/Latin-1 case, in every configured browser. Screenshots go to
// docs/spike/<browser>-<name>.png and are checked by eye as well.
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'docs', 'spike');
fs.mkdirSync(OUT, { recursive: true });

async function open(page: Page, query = '') {
    page.on('console', m => {
        if (m.type() === 'error') console.log(`[${m.type()}] ${m.text()}`);
    });
    await page.goto(`/?blink=0${query}`);
    await page.waitForFunction(() => document.body.dataset.ready === '1');
}

/** Feed a fixture into the terminal and draw synchronously. */
async function show(page: Page, fixture: string, mode: 'stream' | 'sauce' = 'stream') {
    return page.evaluate(
        async ([name, how]) => {
            const t = (window as any).enigTerm;
            const buf = new Uint8Array(await (await fetch(`/fixtures/${name}`)).arrayBuffer());
            let info: unknown = null;
            if (how === 'sauce') info = t.showSauceArt(buf);
            else t.write(buf);
            t.renderFrame(true);
            return {
                info,
                renderer: t.renderer.kind,
                canvas: [t.canvas.width, t.canvas.height],
                css: [parseFloat(t.canvas.style.width), parseFloat(t.canvas.style.height)],
                frame: [t.core.core.frame_width(), t.core.core.frame_height()],
                cell: [t.core.core.cell_width(), t.core.core.cell_height()],
                fontPage: t.core.core.font_page(),
                font42: t.core.core.font_name(42),
                charset: t.charset,
                yStretch: t.yStretch,
            };
        },
        [fixture, mode] as const,
    );
}

async function snap(page: Page, project: string, name: string) {
    await page.locator('canvas').screenshot({ path: path.join(OUT, `${project}-${name}.png`) });
}

test('CP437 test card at 4:3, sharp-bilinear', async ({ page }, ti) => {
    await open(page);
    const r = await show(page, 'cp437-testcard.ans');
    console.log(ti.project.name, 'testcard', JSON.stringify(r));
    expect(r.frame).toEqual([640, 400]);
    expect(r.canvas[0] / r.canvas[1]).toBeCloseTo(4 / 3, 2);
    await snap(page, ti.project.name, 'cp437-testcard');
});

test('CP437 test card, square pixels (4:3 off)', async ({ page }, ti) => {
    await open(page, '&aspect=0');
    const r = await show(page, 'cp437-testcard.ans');
    expect(r.canvas[0] / r.canvas[1]).toBeCloseTo(640 / 400, 2);
    await snap(page, ti.project.name, 'cp437-testcard-square');
});

test('CP437 test card with CRT', async ({ page }, ti) => {
    await open(page, '&crt=1');
    await show(page, 'cp437-testcard.ans');
    await snap(page, ti.project.name, 'cp437-testcard-crt');
});

test('CP437 test card on the 2D-canvas fallback', async ({ page }, ti) => {
    await open(page, '&renderer=2d');
    const r = await show(page, 'cp437-testcard.ans');
    expect(r.renderer).toBe('2d');
    await snap(page, ti.project.name, 'cp437-testcard-2d');
});

test('SAUCE file: iCE + 9px + font name applied', async ({ page }, ti) => {
    await open(page);
    const r = await show(page, 'sauce-ice-9px.ans', 'sauce');
    console.log(ti.project.name, 'sauce', JSON.stringify(r));
    expect((r.info as any).ice).toBe(true);
    expect((r.info as any).letterSpacing).toBe(true);
    expect(r.frame).toEqual([720, 400]);
    expect(r.canvas[0] / r.canvas[1]).toBeCloseTo(4 / 3, 2);
    await snap(page, ti.project.name, 'sauce-ice-9px');
});

test('Amiga: Topaz via CSI 0;42 SP D, Latin-1 high half', async ({ page }, ti) => {
    await open(page);
    const r = await show(page, 'amiga-topaz-latin1.ans');
    console.log(ti.project.name, 'amiga', JSON.stringify(r));
    expect(r.font42).toMatch(/topaz/i);
    await snap(page, ti.project.name, 'amiga-topaz-latin1');
});

test('real ENiGMA art (local only, not committed)', async ({ page }, ti) => {
    const art = process.env.ENIGMA_ART ?? path.join(process.env.HOME ?? '', 'dev/enigma-bbs/art/themes/luciano_blocktronics/MMENU.ANS');
    test.skip(!fs.existsSync(art), `no art at ${art}`);
    await open(page);
    const b64 = fs.readFileSync(art).toString('base64');
    await page.evaluate(b => {
        const t = (window as any).enigTerm;
        const bin = Uint8Array.from(atob(b), c => c.charCodeAt(0));
        t.showSauceArt(bin);
        t.renderFrame(true);
    }, b64);
    await snap(page, ti.project.name, 'enigma-art');
});

test('device-pixel sizing at DPR 2 keeps css*dpr integral', async ({ browser }, ti) => {
    const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1037, height: 900 } });
    const page = await ctx.newPage();
    await open(page);
    const r = await show(page, 'cp437-testcard.ans');
    console.log(ti.project.name, 'dpr2', JSON.stringify(r));
    expect(Number.isInteger(r.css[0] * 2)).toBe(true);
    expect(r.canvas[0]).toBe(Math.round(r.css[0] * 2));
    await page.locator('canvas').screenshot({ path: path.join(OUT, `${ti.project.name}-cp437-testcard-dpr2.png`) });
    await ctx.close();
});

// Rendering: known CP437 art, a SAUCE file and the Amiga Topaz/Latin-1 case
// in every browser. Three kinds of check:
//   * golden engine frames: the frame the WASM renders must hash to the value
//     Node computes (test/goldens.json);
//   * canvas samples: the colour at the centre of known cells, read back from
//     the canvas, through the WebGL2 pass and the 2D fallback;
//   * screenshots in test/screenshots/ (checked by eye; not committed).
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { open, shot, CSI, loadPcFont, settle, amigaFontsInstalled } from './helpers';

const GOLDENS = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'goldens.json'), 'utf8'));

/** Feed a fixture into the terminal and draw synchronously. */
async function show(page: Page, fixture: string, mode: 'stream' | 'sauce' = 'stream') {
    return page.evaluate(
        async ([name, how]) => {
            const t = (window as any).enigTerm;
            const buf = new Uint8Array(await (await fetch(`/fixtures/${name}`)).arrayBuffer());
            let info: unknown = null;
            if (how === 'sauce') info = await t.showSauceArt(buf);
            else t.write(buf);
            t.renderFrame(true);
            const c = t.core.core;
            // Hash the engine frame (blink phase "on", as in Node).
            c.set_blink(true);
            c.render(true);
            const px = new Uint8Array(t.core.memory.buffer, c.frame_ptr(), c.frame_len()).slice();
            const digest = await crypto.subtle.digest('SHA-256', px);
            const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
            t.renderFrame(true);
            return {
                info,
                sha256,
                renderer: t.renderer.kind,
                canvas: [t.canvas.width, t.canvas.height],
                css: [parseFloat(t.canvas.style.width), parseFloat(t.canvas.style.height)],
                frame: [c.frame_width(), c.frame_height()],
                cell: [c.cell_width(), c.cell_height()],
                font42: c.font_name(42),
                yStretch: t.yStretch,
            };
        },
        [fixture, mode] as const,
    );
}

/** Read back the canvas colour at the centre of cell (x, y). */
async function sample(page: Page, cells: [number, number][]) {
    return page.evaluate(cells => {
        const t = (window as any).enigTerm;
        const src: HTMLCanvasElement = t.canvas;
        const cv = document.createElement('canvas');
        cv.width = src.width;
        cv.height = src.height;
        const ctx = cv.getContext('2d')!;
        ctx.drawImage(src, 0, 0);
        return cells.map(([x, y]) => {
            const px = Math.floor(((x + 0.5) / t.core.cols) * src.width);
            const py = Math.floor(((y + 0.5) / t.core.rows) * src.height);
            return Array.from(ctx.getImageData(px, py, 1, 1).data.slice(0, 3));
        });
    }, cells);
}

const VGA = [
    [0, 0, 0], [0xaa, 0, 0], [0, 0xaa, 0], [0xaa, 0x55, 0], [0, 0, 0xaa], [0xaa, 0, 0xaa], [0, 0xaa, 0xaa], [0xaa, 0xaa, 0xaa],
    [0x55, 0x55, 0x55], [0xff, 0x55, 0x55], [0x55, 0xff, 0x55], [0xff, 0xff, 0x55], [0x55, 0x55, 0xff], [0xff, 0x55, 0xff], [0x55, 0xff, 0xff], [0xff, 0xff, 0xff],
];

for (const renderer of ['webgl2', '2d'] as const) {
    test(`canvas colours match the VGA palette (${renderer}, iCE backgrounds)`, async ({ page }) => {
        await open(page, renderer === '2d' ? '&renderer=2d' : '');
        let s = `${CSI}?33h${CSI}2J${CSI}2;1H`;
        for (let i = 0; i < 16; i++) s += `${CSI}0;${i < 8 ? 40 + i : '5;' + (40 + i - 8)}m    `;
        await page.evaluate(x => {
            const t = (window as any).enigTerm;
            t.write(x);
            t.renderFrame(true);
        }, s);
        const kind = await page.evaluate(() => (window as any).enigTerm.renderer.kind);
        test.skip(renderer === 'webgl2' && kind !== 'webgl2', `no WebGL2 here (${kind})`);
        const got = await sample(page, Array.from({ length: 16 }, (_, i) => [i * 4 + 1, 1] as [number, number]));
        for (let i = 0; i < 16; i++) for (let k = 0; k < 3; k++) expect(Math.abs(got[i][k] - VGA[i][k]), `colour ${i} channel ${k}: ${got[i]}`).toBeLessThanOrEqual(2);
    });
}

test('CP437 test card at 4:3, sharp-bilinear; golden frame', async ({ page }, ti) => {
    await open(page);
    const r = await show(page, 'cp437-testcard.ans');
    console.log(ti.project.name, 'testcard', JSON.stringify({ ...r, info: undefined }));
    expect(r.frame).toEqual([640, 400]);
    expect(r.sha256).toBe(GOLDENS['cp437-testcard'].sha256);
    expect(r.canvas[0] / r.canvas[1]).toBeCloseTo(4 / 3, 2);
    await shot(page, 'cp437-testcard', ti.project.name);
});

test('CP437 test card, square pixels (4:3 off)', async ({ page }, ti) => {
    await open(page, '&aspect=0');
    const r = await show(page, 'cp437-testcard.ans');
    expect(r.canvas[0] / r.canvas[1]).toBeCloseTo(640 / 400, 2);
    await shot(page, 'cp437-testcard-square', ti.project.name);
});

test('CP437 test card with CRT', async ({ page }, ti) => {
    await open(page, '&crt=1');
    await show(page, 'cp437-testcard.ans');
    await shot(page, 'cp437-testcard-crt', ti.project.name);
});

test('CP437 test card on the 2D-canvas fallback', async ({ page }, ti) => {
    await open(page, '&renderer=2d');
    const r = await show(page, 'cp437-testcard.ans');
    expect(r.renderer).toBe('2d');
    await shot(page, 'cp437-testcard-2d', ti.project.name);
});

test('integer scale mode uses whole multiples', async ({ page }) => {
    await open(page, '&scale=integer&aspect=0');
    const r = await show(page, 'cp437-testcard.ans');
    expect(r.canvas[0] % 640).toBe(0);
    expect(r.canvas[1] % 400).toBe(0);
});

test('SAUCE file: iCE + 9px + font name applied; golden frame', async ({ page }, ti) => {
    await open(page);
    const r = await show(page, 'sauce-ice-9px.ans', 'sauce');
    expect((r.info as any).ice).toBe(true);
    expect((r.info as any).letterSpacing).toBe(true);
    expect((r.info as any).sauceFont).toEqual({ name: 'IBM VGA', slot: 0, height: 16 });
    expect(r.frame).toEqual([720, 400]);
    expect(r.sha256).toBe(GOLDENS['sauce-ice-9px'].sha256);
    expect(r.canvas[0] / r.canvas[1]).toBeCloseTo(4 / 3, 2);
    await shot(page, 'sauce-ice-9px', ti.project.name);
});

/** A small ANSI file with a SAUCE record naming `font` (TInfoS). */
function sauceArt(font: string): number[] {
    const body = Buffer.from(`${CSI}0m\xb0\xb1\xb2\xdb \x80\x9b\xd5 SAUCE font: ${font}\r\n`, 'latin1');
    const rec = Buffer.alloc(128, 0);
    rec.write('SAUCE00', 0, 'latin1');
    rec.writeUInt32LE(body.length, 90);
    rec[94] = 1; // Character
    rec[95] = 1; // ANSi
    rec.writeUInt16LE(80, 96);
    rec.writeUInt16LE(25, 98);
    rec.write(font, 106, 'latin1');
    return [...body, 0x1a, ...rec];
}

/** Show `sauceArt(font)`; `noAmiga` makes the Amiga fonts look uninstalled. */
async function showSauceFont(page: Page, font: string, noAmiga = false) {
    return page.evaluate(
        async ([b, noAmiga]) => {
            const t = (window as any).enigTerm;
            if (noAmiga) t.fonts.amiga = null;
            const info = await t.showSauceArt(new Uint8Array(b));
            const c = t.core.core;
            return { sauceFont: info.sauceFont, page: c.font_page(), cellPage: (c.row_cells(0)[0] >> 16) & 0xff, profile: t.activeProfile };
        },
        [sauceArt(font), noAmiga] as const,
    );
}

test('SAUCE font names select our fonts: code pages, unknown names, Amiga fonts not installed', async ({ page }) => {
    await open(page, '&profile=auto');
    expect(await showSauceFont(page, 'IBM VGA 850')).toEqual({ sauceFont: { name: 'IBM VGA 850', slot: 18, height: 16 }, page: 18, cellPage: 18, profile: 'pc' });
    expect(await showSauceFont(page, 'IBM EGA 866')).toMatchObject({ sauceFont: { slot: 25, height: 14 }, cellPage: 25 });
    // Back to CP437 for the next file: the reset drops the previous selection.
    expect(await showSauceFont(page, 'ibm  vga50')).toMatchObject({ sauceFont: { slot: 0, height: 8 }, cellPage: 0 });
    expect(await showSauceFont(page, 'IBM VGA 737')).toMatchObject({ sauceFont: { slot: null }, cellPage: 0 });
    expect(await showSauceFont(page, 'C64 PETSCII shifted')).toMatchObject({ sauceFont: { slot: null }, cellPage: 0 });
    expect(await showSauceFont(page, 'Amiga Topaz 2+', true)).toEqual({ sauceFont: { name: 'Amiga Topaz 2+', slot: null, height: 8 }, page: 0, cellPage: 0, profile: 'pc' });
});

test('SAUCE Amiga font name selects the installed Amiga font (skipped when not installed)', async ({ page }) => {
    await open(page);
    test.skip(!(await amigaFontsInstalled(page)), 'no Amiga fonts (npm run fonts:amiga)');
    expect(await showSauceFont(page, 'Amiga Topaz 2+')).toEqual({ sauceFont: { name: 'Amiga Topaz 2+', slot: 40, height: 8 }, page: 40, cellPage: 40, profile: 'amiga' });
    expect(await showSauceFont(page, "Amiga mO'sOul")).toMatchObject({ sauceFont: { slot: 38 }, cellPage: 38 });
});

test('Latin-1 high half through slot 42 (licensed ISO-8859-1 stand-in); golden frame', async ({ page }, ti) => {
    await open(page, '&profile=pc');
    await loadPcFont(page, 42);
    const r = await show(page, 'amiga-topaz-latin1.ans');
    expect(r.sha256).toBe(GOLDENS['latin1-slot42'].sha256);
    await shot(page, 'latin1-slot42', ti.project.name);
});

test('Amiga profile: Topaz test card from the fetched fonts (skipped when not installed)', async ({ page }, ti) => {
    await open(page);
    test.skip(!(await amigaFontsInstalled(page)), 'no Amiga fonts (npm run fonts:amiga)');
    await page.evaluate(async name => {
        const t = (window as any).enigTerm;
        t.write(new Uint8Array(await (await fetch(`/fixtures/${name}`)).arrayBuffer()));
    }, 'amiga-testcard.ans');
    await settle(page);
    const r = await page.evaluate(() => {
        const t = (window as any).enigTerm;
        return { font: t.core.core.font_name(42), page: t.core.core.font_page(), profile: t.activeProfile, yStretch: t.yStretch, charset: t.charset };
    });
    expect(r).toEqual({ font: 'Topaz (Amiga)', page: 42, profile: 'amiga', yStretch: 0.9375, charset: 'latin1' });
    await shot(page, 'amiga-topaz-testcard', ti.project.name);
});

// ENIGMA_ART=<an ENiGMA checkout>/art/themes/luciano_blocktronics/MMENU.ANS
test('real ENiGMA art (local only: never committed)', async ({ page }, ti) => {
    const art = process.env.ENIGMA_ART ?? '';
    test.skip(!art || !fs.existsSync(art), art ? `no art at ${art}` : 'set ENIGMA_ART to a piece of ANSI art');
    await open(page);
    const b64 = fs.readFileSync(art).toString('base64');
    await page.evaluate(async b => {
        const t = (window as any).enigTerm;
        await t.showSauceArt(Uint8Array.from(atob(b), c => c.charCodeAt(0)));
        t.renderFrame(true);
    }, b64);
    await shot(page, 'enigma-art', ti.project.name);
});

test('device-pixel sizing at DPR 2 keeps css*dpr integral', async ({ browser }, ti) => {
    const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1037, height: 900 } });
    const page = await ctx.newPage();
    await open(page);
    const r = await show(page, 'cp437-testcard.ans');
    expect(Number.isInteger(r.css[0] * 2)).toBe(true);
    expect(r.canvas[0]).toBe(Math.round(r.css[0] * 2));
    await shot(page, 'cp437-testcard-dpr2', ti.project.name);
    await ctx.close();
});

test('blink: real blink with iCE off, bright background with iCE on', async ({ page }) => {
    await open(page);
    // Blinking red-on-black text; read the engine frame in both phases.
    const r = await page.evaluate(([csi]) => {
        const t = (window as any).enigTerm;
        const c = t.core.core;
        t.write(`${csi}2J${csi}1;1H${csi}0;5;31;44m\xdb\xdb${csi}0m`);
        const px = () => Array.from(new Uint8Array(t.core.memory.buffer, c.frame_ptr(), 4));
        c.set_blink(true);
        c.render(true);
        const on = px();
        c.set_blink(false);
        c.render(true);
        const off = px();
        return { on, off };
    }, [CSI]);
    expect(r.on.slice(0, 3)).toEqual([0xaa, 0, 0]); // the glyph, in its on phase
    expect(r.off.slice(0, 3)).toEqual([0, 0, 0xaa]); // off phase: background shows
    // iCE on: SGR 5 is a bright background and nothing blinks. (icy_engine
    // applies it to text written after CSI ? 33 h, not to cells already there.)
    const ice = await page.evaluate(([csi]) => {
        const t = (window as any).enigTerm;
        const c = t.core.core;
        t.write(`${csi}?33h${csi}1;1H${csi}0;5;31;44m  ${csi}0m`);
        const px = () => Array.from(new Uint8Array(t.core.memory.buffer, c.frame_ptr(), 3));
        c.set_blink(true);
        c.render(true);
        const a = px();
        c.set_blink(false);
        c.render(true);
        return [a, px()];
    }, [CSI]);
    expect(ice).toEqual([[0x55, 0x55, 0xff], [0x55, 0x55, 0xff]]);
});

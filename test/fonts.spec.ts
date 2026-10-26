// Fonts and the Amiga profile in the browser: lazy font fetches (and the
// stream held while they load), refusal of fonts we do not have, the CTerm
// font reports through the shell, DCS fonts, the auto / explicit profile with
// its palette, aspect, rows and override, and the credits page.
import { test, expect, type Page } from '@playwright/test';
import { open, captureSent, sent, write, settle, loadPcFont, amigaFontsInstalled, shot, CSI, ESC, ST } from './helpers';

const text = (b: number[]) => String.fromCharCode(...b);

/** Canvas colour at the centre of cell (x, y). */
async function cellColour(page: Page, x: number, y: number) {
    return page.evaluate(
        ([x, y]) => {
            const t = (window as any).enigTerm;
            t.renderFrame(true);
            const src: HTMLCanvasElement = t.canvas;
            const cv = document.createElement('canvas');
            cv.width = src.width;
            cv.height = src.height;
            const ctx = cv.getContext('2d')!;
            ctx.drawImage(src, 0, 0);
            const px = Math.floor(((x + 0.5) / t.core.cols) * src.width);
            const py = Math.floor(((y + 0.5) / t.core.rows) * src.height);
            return Array.from(ctx.getImageData(px, py, 1, 1).data.slice(0, 3));
        },
        [x, y],
    );
}

const fontRequests = (page: Page) =>
    page.evaluate(() => performance.getEntriesByType('resource').map(e => new URL(e.name).pathname).filter(p => p.includes('/fonts/')));

test('a CP437 session fetches the manifest and one font file; other fonts load when the host selects them', async ({ page }) => {
    await open(page);
    expect(await fontRequests(page)).toEqual(['/fonts/manifest.json', '/fonts/pc/cp437-8x16.psf']);
    await captureSent(page);
    // KOI8-R: the stream is held at the selection until the font is in, then the text uses it.
    await page.evaluate(([csi]) => (window as any).enigTerm.write(`${csi}0;2 D${csi}1;1H\xf7\xe1${csi}=1n`), [CSI]);
    await settle(page);
    expect(text(await sent(page))).toBe(`${CSI}=1;46;0;2;0;0;0n`);
    expect(await page.evaluate(() => (window as any).enigTerm.core.core.font_page())).toBe(2);
    expect((await fontRequests(page)).slice(2)).toEqual(['/fonts/pc/koi8-r-8x16.psf']);
});

test('fonts we have no licensed font for are refused (font state report), with no fetch and no hold', async ({ page }) => {
    await open(page);
    await captureSent(page);
    for (const font of [32, 43, 44, 45]) {
        await write(page, `${CSI}0;${font} D${CSI}=1n`);
        expect(await page.evaluate(() => (window as any).enigTerm.holding)).toBe(false);
        expect(text(await sent(page))).toBe(`${CSI}=1;46;1;0;0;0;0n`);
    }
    expect(await fontRequests(page)).toEqual(['/fonts/manifest.json', '/fonts/pc/cp437-8x16.psf']);
});

test('without Amiga fonts on the site, an Amiga font is refused and the look stays PC', async ({ page }) => {
    await page.route('**/fonts/amiga/**', r => r.fulfill({ status: 404, body: 'not found' }));
    await open(page);
    await captureSent(page);
    await page.evaluate(([csi]) => (window as any).enigTerm.write(`${csi}0;42 D${csi}=1n`), [CSI]);
    await settle(page);
    expect(text(await sent(page))).toBe(`${CSI}=1;46;1;0;0;0;0n`);
    const st = await page.evaluate(() => ({ p: (window as any).enigTerm.activeProfile, c: (window as any).enigTerm.charset }));
    expect(st).toEqual({ p: 'pc', c: 'cp437' });
});

test('CSI = 2 n and = 3 n through the shell; Ps1 attribute slots in = 1 n', async ({ page }) => {
    await open(page);
    await captureSent(page);
    await write(page, `${CSI}?31h${CSI}?33h${CSI}=2n${CSI}=3n`);
    expect(text(await sent(page))).toBe(`${CSI}=2;7;25;31;33n${CSI}=3;16;8n`);
    await page.evaluate(([csi]) => (window as any).enigTerm.write(`${csi}1;24 D${csi}=1n`), [CSI]);
    await settle(page);
    expect(text(await sent(page))).toBe(`${CSI}=1;46;0;0;24;0;0n`);
});

test('DCS CTerm:Font into slot 46, selected and drawn', async ({ page }) => {
    await open(page);
    await captureSent(page);
    const b64 = Buffer.from(new Uint8Array(256 * 16).fill(0xff)).toString('base64');
    await write(page, `${ESC}PCTerm:Font:46:${b64}${ST}${CSI}0;46 D${CSI}=1n${CSI}2J${CSI}1;1H${CSI}0;32;40mA`);
    expect(text(await sent(page))).toBe(`${CSI}=1;46;0;46;0;0;0n`);
    const [r, g, b] = await cellColour(page, 0, 0);
    expect([r < 20, g > 150, b < 20]).toEqual([true, true, true]);
});

test('auto profile: an Amiga font switches to the Amiga look (palette, aspect), font 0 switches back', async ({ page }, ti) => {
    await open(page);
    await loadPcFont(page, 42); // stand-in: the profile follows the slot number
    await write(page, `${CSI}2J${CSI}1;1H${CSI}0;41m   ${CSI}1;10H${CSI}0;37;40m`);
    const pcRed = await cellColour(page, 1, 0);
    const pcStretch = await page.evaluate(() => (window as any).enigTerm.yStretch);
    await write(page, `${CSI}0;42 D`);
    const amiga = await page.evaluate(() => ({ p: (window as any).enigTerm.activeProfile, y: (window as any).enigTerm.yStretch }));
    expect(amiga).toEqual({ p: 'amiga', y: 0.9375 });
    const red = await cellColour(page, 1, 0);
    // NComm's ANSI red is $C00 (#cc0000); VGA's is #aa0000. Existing cells take the new palette.
    expect(red.map(v => Math.round(v / 17))).toEqual([12, 0, 0]);
    expect(pcRed.map(v => Math.round(v / 17))).toEqual([10, 0, 0]);
    expect(pcStretch).toBeCloseTo(1.2, 5);
    await shot(page, 'amiga-profile-auto', ti.project.name);
    await write(page, `${CSI}0;0 D`);
    expect(await page.evaluate(() => (window as any).enigTerm.activeProfile)).toBe('pc');
    expect((await cellColour(page, 1, 0)).map(v => Math.round(v / 17))).toEqual([10, 0, 0]);
});

test('Amiga profile: host OSC 4 still changes colours, OSC 104 resets to the Amiga palette', async ({ page }) => {
    await open(page, '&profile=amiga');
    await write(page, `${CSI}2J${CSI}1;1H${CSI}0;42m   ${ESC}]4;2;rgb:12/34/56${ST}`);
    expect(await cellColour(page, 1, 0)).toEqual([0x12, 0x34, 0x56]);
    await write(page, `${ESC}]104;2${ST}`);
    expect(await cellColour(page, 1, 0)).toEqual([0, 0xbb, 0]);
});

test('an explicit profile wins: "pc" ignores Amiga fonts, "amiga" holds without one; the setting persists', async ({ page }) => {
    await open(page, '&profile=pc');
    await loadPcFont(page, 42);
    await write(page, `${CSI}0;42 D`);
    expect(await page.evaluate(() => [(window as any).enigTerm.activeProfile, (window as any).enigTerm.charset])).toEqual(['pc', 'latin1']);
    // The user picks Amiga in the settings panel; it applies at once and is saved.
    await page.evaluate(() => {
        const sel = document.querySelector('enig-term')!.shadowRoot!.querySelector<HTMLSelectElement>('[data-set="profile"]')!;
        sel.value = 'amiga';
        sel.dispatchEvent(new Event('change'));
    });
    expect(await page.evaluate(() => (window as any).enigTerm.activeProfile)).toBe('amiga');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('enig-term:settings:v1')!).profile)).toBe('amiga');
    await write(page, `${CSI}0;0 D`);
    expect(await page.evaluate(() => (window as any).enigTerm.activeProfile)).toBe('amiga');
    await page.evaluate(() => localStorage.clear());
});

test('Amiga profile options: rows (NAWS geometry), NTSC aspect, cursor, iCE off by default', async ({ page }) => {
    await open(page, '&profile=amiga&amigaRows=32&amigaAspect=ntsc');
    const r = await page.evaluate(() => {
        const t = (window as any).enigTerm;
        return { rows: t.core.rows, cols: t.core.cols, y: t.yStretch, frame: [t.core.core.frame_width(), t.core.core.frame_height()] };
    });
    expect(r).toEqual({ rows: 32, cols: 80, y: 1.2, frame: [640, 512] });
    // iCE: the host's CSI ? 33 h does not give bright backgrounds in the Amiga profile.
    await write(page, `${CSI}?33h${CSI}1;1H${CSI}0;5;41m   ${CSI}0m`);
    await page.evaluate(() => (window as any).enigTerm.core.core.set_blink(true));
    expect((await cellColour(page, 1, 0)).map(v => Math.round(v / 17))).toEqual([12, 0, 0]);
    // Back to PC: the configured rows return.
    await page.evaluate(() => (window as any).enigTerm.set('profile', 'pc'));
    expect(await page.evaluate(() => (window as any).enigTerm.core.rows)).toBe(25);
});

test('explicit Amiga profile selects Topaz when the fonts are installed', async ({ page }) => {
    await open(page);
    test.skip(!(await amigaFontsInstalled(page)), 'no Amiga fonts (npm run fonts:amiga)');
    await page.goto('/?blink=0&profile=amiga');
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    await page.waitForFunction(() => (window as any).enigTerm.core.core.font_page() === 42, null, { timeout: 10_000 });
    expect(await page.evaluate(() => (window as any).enigTerm.charset)).toBe('latin1');
});

test('credits page: linked from the settings panel, next to the bundle, with the font licences', async ({ page }) => {
    await open(page);
    const href = await page.evaluate(() => document.querySelector('enig-term')!.shadowRoot!.querySelector<HTMLAnchorElement>('[data-credits]')!.href);
    expect(new URL(href).pathname).toBe('/credits.html');
    const r = await page.request.get(href);
    expect(r.ok()).toBe(true);
    const html = await r.text();
    for (const s of ['CC BY-SA 4.0', 'VileR', 'icy_tools', 'MIT', 'not available: no licensed Commodore font', 'Topaz', 'BSD 2-Clause']) expect(html).toContain(s);
    for (const f of ['/fonts/LICENSE', '/fonts/README.txt', '/tools/fetch-amiga-fonts.mjs']) expect((await page.request.get(f)).ok(), f).toBe(true);
});

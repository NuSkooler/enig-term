// <enig-term> and EnigTerm.mount() on a foreign page (test/fixtures/embed.html):
// hostile page CSS, the bundle loaded from /_enig/ws-term/, two terminals,
// DOM events, and panic recovery with both on the page.
import { test, expect } from '@playwright/test';
import { fakeUrl, CSI, ESC, ST } from './helpers';

test('custom element and mount() on a foreign page: no CSS leakage either way, assets from the script URL', async ({ page }, ti) => {
    page.on('pageerror', e => console.log(`[pageerror] ${e.message}`));
    await page.goto('/fixtures/embed.html');
    await page.waitForFunction(() => (window as any).handles?.length === 2 && (window as any).handles[0]);
    // The page's CSS does not reach inside...
    const canvasDisplay = await page.locator('#el').locator('canvas').evaluate(c => getComputedStyle(c).display);
    expect(canvasDisplay).toBe('block');
    // Inherited page styles (letter-spacing, font) stop at the element too.
    const inner = await page.locator('#el').locator('[data-status]').evaluate(e => ({ ls: getComputedStyle(e).letterSpacing, ff: getComputedStyle(e).fontFamily }));
    expect(inner.ls).toMatch(/^(normal|0px)$/);
    expect(inner.ff).not.toMatch(/Comic/);
    await expect(page.locator('#el').locator('canvas')).toBeVisible();
    // ...and ours does not reach out.
    const btn = await page.locator('#pagebutton').evaluate(b => ({ bg: getComputedStyle(b).backgroundColor, pad: getComputedStyle(b).paddingTop }));
    expect(btn).toEqual({ bg: 'rgb(255, 0, 255)', pad: '30px' });
    expect(await page.evaluate(() => document.querySelectorAll('style').length)).toBe(1);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(240, 240, 200)');
    // The WASM came from next to the script, not next to the page.
    const wasm = await page.evaluate(() => performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('.wasm')));
    expect(wasm.length).toBe(1);
    expect(new URL(wasm[0]).pathname).toBe('/_enig/ws-term/enig_term_core_bg.wasm');
    expect(new URL(wasm[0]).search).toMatch(/^\?v=[0-9a-f]{16}$/);
    // Element attributes applied.
    const o = await page.evaluate(() => {
        const h = (window as any).handles[0];
        return { endpoint: h.getOption('endpoint'), crt: h.getOption('crt'), aspect: h.getOption('aspect'), keyBar: h.getOption('keyBar') };
    });
    expect(o).toEqual({ endpoint: 'wss://elsewhere.example/', crt: true, aspect: false, keyBar: 'off' });
    // Attribute changes apply at run time.
    await page.evaluate(() => document.getElementById('el')!.removeAttribute('crt'));
    expect(await page.evaluate(() => (window as any).handles[0].getOption('crt'))).toBe(false);
    await page.screenshot({ path: `test/screenshots/${ti.project.name}-foreign-page.png`, fullPage: true });

    // DOM events: state, title, bell, link.
    const id = `embed-${ti.project.name}-${Date.now()}-${ti.repeatEachIndex}`;
    await page.evaluate(u => (window as any).handles[0].connect(u), fakeUrl(page, 'probe', id));
    await expect.poll(() => page.evaluate(() => (window as any).events.filter((e: any) => e[0] === 'state').map((e: any) => e[1]))).toEqual(expect.arrayContaining(['connecting', 'connected']));
    // Wait for the host's greeting (it clears the screen) before drawing our own link.
    const row0 = () => page.evaluate(() => String.fromCharCode(...Array.from((window as any).handles[0].terminal.core.core.row_cells(0) as Uint32Array, v => v & 0xffff)).trimEnd());
    await expect.poll(row0).toBe('fake-bbs script=probe');
    await page.evaluate(
        ([esc, st]) => {
            const h = (window as any).handles[0];
            h.write(`${esc}]2;Board Title${st}\x07`);
            h.write(`${esc}[1;1H${esc}]8;;https://l.example/${st}L${esc}]8;;${st}`);
        },
        [ESC, ST],
    );
    await page.evaluate(() => document.getElementById('el')!.addEventListener('link', e => e.preventDefault()));
    // Let layout settle (the status text changes size as the state changes), then click cell (0, 0).
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const pt = await page.evaluate(() => {
        const t = (window as any).handles[0].terminal;
        const r = t.canvas.getBoundingClientRect();
        return { x: r.left + r.width / t.core.cols / 2, y: r.top + r.height / t.core.rows / 2 };
    });
    await page.mouse.click(pt.x, pt.y);
    await expect.poll(() => page.evaluate(() => (window as any).events.map((e: any) => e[0]))).toEqual(expect.arrayContaining(['title', 'bell', 'link']));
    const ev = await page.evaluate(() => (window as any).events);
    expect(ev).toEqual(expect.arrayContaining([['title', 'Board Title'], ['link', 'https://l.example/']]));
    await expect(page.locator('#el').locator('[data-linkdialog]')).toBeHidden(); // the page handled the link
    void CSI;
});

test('an engine panic recovers every terminal on the page', async ({ page }) => {
    await page.goto('/fixtures/embed.html');
    await page.waitForFunction(() => (window as any).handles?.length === 2 && (window as any).handles[0]);
    const r = await page.evaluate(async () => {
        const [a, b] = (window as any).handles;
        a.write('first terminal');
        b.write('second terminal');
        const done = new Promise(res => b.on('recovered', res));
        const prevent = console.error;
        console.error = () => {};
        a.terminal.core.core.debug_passthrough_sync(true);
        a.write(String.fromCharCode(27) + '[?2026h');
        await done;
        console.error = prevent;
        a.write('A ok');
        b.write('B ok');
        const row = (h: any) => String.fromCharCode(...Array.from(h.terminal.core.core.row_cells(0) as Uint32Array, v => v & 0xffff)).trimEnd();
        return [row(a), row(b)];
    });
    expect(r).toEqual(['A ok', 'B ok']);
});

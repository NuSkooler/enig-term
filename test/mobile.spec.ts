// Phones: Pixel 7 (Chromium) and iPhone 14 (WebKit) emulation. Key bar shown
// on coarse pointers and kept at the bottom of the visual viewport, no
// horizontal page scroll, tap to focus, sticky Ctrl, the Fn row, touch-drag
// scrollback.
import { test, expect, type Page } from '@playwright/test';
import { open, captureSent, sent, write, shot, CSI } from './helpers';

const bar = (page: Page) => page.locator('enig-term').locator('[data-keybar]');

test('key bar shows by itself on a touch device and sits at the visual viewport bottom', async ({ page }, ti) => {
    await open(page);
    await expect(bar(page)).toBeVisible();
    const g = await page.evaluate(() => {
        const t = (window as any).enigTerm;
        const b = (document.querySelector('enig-term')!.shadowRoot!.querySelector('[data-keybar]') as HTMLElement).getBoundingClientRect();
        const vv = window.visualViewport!;
        return {
            barBottom: Math.round(b.bottom),
            vvBottom: Math.round(vv.offsetTop + vv.height),
            scrollW: document.documentElement.scrollWidth,
            innerW: window.innerWidth,
            canvasW: t.canvas.getBoundingClientRect().width,
            canvasRight: t.canvas.getBoundingClientRect().right,
        };
    });
    expect(Math.abs(g.barBottom - g.vvBottom)).toBeLessThanOrEqual(1);
    expect(g.scrollW).toBeLessThanOrEqual(g.innerW);
    expect(g.canvasW).toBeLessThanOrEqual(g.innerW);
    expect(g.canvasRight).toBeLessThanOrEqual(g.innerW + 0.5);
    await write(page, `${CSI}2J${CSI}1;1H${CSI}1;33mPhone layout${CSI}0m: 80 columns scaled to fit`);
    await page.evaluate(() => (window as any).enigTerm.renderFrame(true));
    await page.screenshot({ path: `test/screenshots/${ti.project.name}-phone.png` });
});

test('the key bar follows a shrinking visual viewport (soft keyboard)', async ({ page }) => {
    await open(page);
    // Emulation cannot open a soft keyboard; stand in for one by reporting a
    // shorter visual viewport, as iOS does while the layout viewport stays.
    const r = await page.evaluate(() => {
        const vv = window.visualViewport!;
        const h = vv.height - 300;
        Object.defineProperty(vv, 'height', { configurable: true, get: () => h });
        vv.dispatchEvent(new Event('resize'));
        const b = (document.querySelector('enig-term')!.shadowRoot!.querySelector('[data-keybar]') as HTMLElement).getBoundingClientRect();
        return { bottom: Math.round(b.bottom), want: Math.round(vv.offsetTop + h) };
    });
    expect(Math.abs(r.bottom - r.want)).toBeLessThanOrEqual(1);
});

test('tap focuses the input; key bar keys, sticky Ctrl and the Fn row', async ({ page }) => {
    await open(page);
    await captureSent(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('enig-term').locator('canvas').tap();
    expect(await page.evaluate(() => (window as any).enigTerm.input.focused)).toBe(true);
    await bar(page).locator('[data-key="Escape"]').tap();
    await bar(page).locator('[data-key="Tab"]').tap();
    await bar(page).locator('[data-key="ArrowUp"]').tap();
    await bar(page).locator('[data-key="PageDown"]').tap();
    expect(await sent(page)).toEqual([27, 9, 27, 91, 65, 27, 91, 85]);
    await bar(page).locator('[data-mod="ctrl"]').tap();
    await expect(bar(page).locator('[data-mod="ctrl"]')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.type('c');
    expect(await sent(page)).toEqual([3]);
    await expect(bar(page).locator('[data-mod="ctrl"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(bar(page).locator('[data-key="F1"]')).toBeHidden();
    await bar(page).locator('[data-fn]').tap();
    await bar(page).locator('[data-key="F1"]').tap();
    await bar(page).locator('[data-key="F12"]').tap();
    expect(String.fromCharCode(...(await sent(page)))).toBe(`${String.fromCharCode(27)}OP${CSI}24~`);
    expect(await page.evaluate(() => (window as any).enigTerm.input.focused)).toBe(true);
});

test('touch drag scrolls back', async ({ page }, ti) => {
    await open(page);
    await write(page, Array.from({ length: 60 }, (_, i) => `touch line ${i}\r\n`).join(''));
    const off = await page.evaluate(async () => {
        const t = (window as any).enigTerm;
        const r = t.canvas.getBoundingClientRect();
        const x = r.left + r.width / 2;
        let y = r.top + r.height * 0.2;
        const ev = (type: string) => new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 1 });
        t.canvas.dispatchEvent(ev('pointerdown'));
        for (let i = 0; i < 10; i++) {
            y += r.height / 25; // one row per step, finger moving down = look back
            t.canvas.dispatchEvent(ev('pointermove'));
        }
        t.canvas.dispatchEvent(ev('pointerup'));
        return t.scroll.offset;
    });
    expect(off).toBeGreaterThanOrEqual(9);
    await page.evaluate(() => (window as any).enigTerm.renderFrame(false));
    await shot(page, 'touch-scrollback', ti.project.name);
});

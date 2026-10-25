// Scrollback: wheel and Shift+PgUp/PgDn move the view, output while
// scrolled back does not move it, any key returns to live.
import { test, expect, type Page } from '@playwright/test';
import { open, write, rowText, captureSent, sent, shot, CSI } from './helpers';

const lines = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => `${CSI}${31 + ((a + i) % 7)}mline ${a + i}${CSI}0m\r\n`).join('');
const offset = (page: Page) => page.evaluate(() => (window as any).enigTerm.scroll.offset as number);

test('wheel scrolls back; output while scrolled back does not move the view; a key returns', async ({ page }, ti) => {
    await open(page);
    await write(page, lines(0, 60));
    expect(await page.evaluate(() => (window as any).enigTerm.core.core.scrollback_len())).toBe(36);
    const canvas = page.locator('canvas');
    await canvas.hover();
    await page.mouse.wheel(0, -400);
    await expect.poll(() => offset(page)).toBeGreaterThan(5);
    const at = await offset(page);
    const top = await rowText(page, 0);
    expect(top).toBe(`line ${36 - at}`);
    await expect(page.locator('enig-term').locator('[data-scrollmark]')).toBeVisible();
    await page.evaluate(() => (window as any).enigTerm.renderFrame(false));
    await shot(page, 'scrollback-view', ti.project.name);

    // New output while scrolled back: the same lines stay on screen.
    await write(page, lines(60, 70));
    expect(await rowText(page, 0)).toBe(top);
    expect(await offset(page)).toBe(at + 10);

    // Any key returns to live, and the key still goes to the host.
    await captureSent(page);
    await page.keyboard.press('a');
    expect(await offset(page)).toBe(0);
    expect(await sent(page)).toEqual([0x61]);
    expect(await rowText(page, 23)).toBe('line 69');
    await expect(page.locator('enig-term').locator('[data-scrollmark]')).toBeHidden();
});

test('Shift+PgUp / Shift+PgDn page through scrollback and are not sent', async ({ page }) => {
    await open(page);
    await write(page, lines(0, 80));
    await captureSent(page);
    await page.keyboard.press('Shift+PageUp');
    expect(await offset(page)).toBe(24);
    await page.keyboard.press('Shift+PageUp');
    expect(await offset(page)).toBe(48);
    await page.keyboard.press('Shift+PageDown');
    expect(await offset(page)).toBe(24);
    expect(await sent(page)).toEqual([]);
    await page.keyboard.press('PageUp'); // plain PgUp is for the host
    expect(await offset(page)).toBe(0);
    expect(await sent(page)).toEqual([27, 91, 86]);
});

test('the scrollback limit is configurable', async ({ page }) => {
    await open(page, '&scrollback=10');
    await write(page, lines(0, 60));
    expect(await page.evaluate(() => (window as any).enigTerm.core.core.scrollback_len())).toBe(10);
});

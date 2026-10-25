// Input path: hidden textarea + keydown map. Bytes that would go to the host
// are captured through onLocalReply (no connection).
import { test, expect, type Page } from '@playwright/test';

async function capture(page: Page) {
    await page.goto('/?blink=0');
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    await page.evaluate(() => {
        const t = (window as any).enigTerm;
        (window as any).sent = [];
        t.onLocalReply = (b: Uint8Array) => (window as any).sent.push(...b);
        t.input.focus();
    });
}
const sent = (page: Page) => page.evaluate(() => (window as any).sent.splice(0) as number[]);

test('typed text is CP437, special keys are ANSI-BBS sequences', async ({ page }) => {
    await capture(page);
    await page.keyboard.type('Hi é');
    expect(await sent(page)).toEqual([0x48, 0x69, 0x20, 0x82]);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Home');
    await page.keyboard.press('End');
    await page.keyboard.press('PageDown');
    expect(await sent(page)).toEqual([27, 91, 65, 27, 91, 72, 27, 91, 75, 27, 91, 85]);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+C');
    expect(await sent(page)).toEqual([13, 8, 9, 27, 3]);
    await page.keyboard.press('F1');
    expect(await sent(page)).toEqual([27, 79, 80]);
});

test('text goes out as Latin-1 while an Amiga font is active', async ({ page }) => {
    await capture(page);
    await page.evaluate(() => (window as any).enigTerm.write(String.fromCharCode(27) + '[0;42 D'));
    await page.keyboard.type('é');
    expect(await sent(page)).toEqual([0xe9]);
    await page.evaluate(() => (window as any).enigTerm.write(String.fromCharCode(27) + '[0;0 D'));
    await page.keyboard.type('é');
    expect(await sent(page)).toEqual([0x82]);
});

test('host queries are answered through the same path', async ({ page }) => {
    await capture(page);
    await page.evaluate(() => (window as any).enigTerm.write(String.fromCharCode(27) + '[5;7H' + String.fromCharCode(27) + '[6n'));
    expect(String.fromCharCode(...(await sent(page)))).toBe(String.fromCharCode(27) + '[5;7R');
});

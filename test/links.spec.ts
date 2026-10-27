// OSC 8 links (hover, confirmation with the full URL, noopener, scheme
// policy, embedder override) and selection/copy.
import { test, expect, type Page } from '@playwright/test';
import { open, write, cellPoint, shot, loadPcFont, ESC, CSI, ST } from './helpers';

async function stubOpen(page: Page) {
    await page.evaluate(() => {
        (window as any).opened = [];
        window.open = ((url: string, target: string, features: string) => {
            (window as any).opened.push([url, target, features]);
            return null;
        }) as typeof window.open;
    });
}

const LINK = 'https://example.com/a/rather/long/path?with=query&and=more#frag';

test('hover shows a link; click asks first with the full URL; Open uses noopener', async ({ page }, ti) => {
    await open(page);
    await stubOpen(page);
    await write(page, `${CSI}2J${CSI}3;5Hsee ${ESC}]8;;${LINK}${ST}the docs${ESC}]8;;${ST} for more`);
    const p = await cellPoint(page, 10, 2);
    await page.mouse.move(p.x, p.y);
    await expect.poll(() => page.evaluate(() => (window as any).enigTerm.canvas.style.cursor)).toBe('pointer');
    expect(await page.evaluate(() => (window as any).enigTerm.canvas.title)).toBe(LINK);
    const off = await cellPoint(page, 2, 2);
    await page.mouse.move(off.x, off.y);
    await expect.poll(() => page.evaluate(() => (window as any).enigTerm.canvas.style.cursor)).toBe('');

    await page.mouse.click(p.x, p.y);
    const dialog = page.locator('enig-term').locator('[data-linkdialog]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-linkurl]')).toHaveText(LINK);
    await page.screenshot({ path: `test/screenshots/${ti.project.name}-link-confirm.png` });
    // Cancel: nothing opens.
    await dialog.locator('[data-act="link-cancel"]').click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => (window as any).opened)).toEqual([]);
    // Open. (Wait out the double-click interval: two quick clicks select a word.)
    await page.waitForTimeout(450);
    await page.mouse.click(p.x, p.y);
    await dialog.locator('[data-act="link-open"]').click();
    expect(await page.evaluate(() => (window as any).opened)).toEqual([[LINK, '_blank', 'noopener,noreferrer']]);
});

test('non-http(s) links are shown but cannot be opened', async ({ page }) => {
    await open(page);
    await stubOpen(page);
    await write(page, `${CSI}2J${CSI}1;1H${ESC}]8;;javascript:alert(1)${ST}click me${ESC}]8;;${ST}`);
    const p = await cellPoint(page, 2, 0);
    await page.mouse.click(p.x, p.y);
    const dialog = page.locator('enig-term').locator('[data-linkdialog]');
    await expect(dialog.locator('[data-linkwhy]')).toContainText('javascript: links are not allowed');
    await expect(dialog.locator('[data-act="link-open"]')).toBeHidden();
    await dialog.locator('[data-act="link-cancel"]').click();
    expect(await page.evaluate(() => (window as any).opened)).toEqual([]);
});

test('links in scrollback can still be followed', async ({ page }) => {
    await open(page);
    await stubOpen(page);
    await write(page, `${CSI}2J${CSI}1;1H${ESC}]8;;https://old.example/${ST}old link${ESC}]8;;${ST}\r\n` + 'x\r\n'.repeat(30));
    await page.evaluate(() => (window as any).enigTerm.input.focus());
    await page.keyboard.press('Shift+PageUp');
    const y = await page.evaluate(() => {
        const t = (window as any).enigTerm;
        for (let r = 0; r < t.core.rows; r++) if (t.core.core.link_at(0, r)) return r;
        return -1;
    });
    expect(y).toBeGreaterThanOrEqual(0);
    const p = await cellPoint(page, 1, y);
    await page.mouse.click(p.x, p.y);
    await expect(page.locator('enig-term').locator('[data-linkurl]')).toHaveText('https://old.example/');
});

test('the link event lets an embedder handle links itself', async ({ page }) => {
    await open(page);
    await stubOpen(page);
    await page.evaluate(() => {
        const t = (window as any).enigTerm;
        (window as any).seen = [];
        t.events.on('link', (e: any) => {
            (window as any).seen.push(e.url);
            e.preventDefault();
        });
    });
    await write(page, `${CSI}2J${CSI}1;1H${ESC}]8;;https://x.example/${ST}x${ESC}]8;;${ST}`);
    const p = await cellPoint(page, 0, 0);
    await page.mouse.click(p.x, p.y);
    expect(await page.evaluate(() => (window as any).seen)).toEqual(['https://x.example/']);
    await expect(page.locator('enig-term').locator('[data-linkdialog]')).toBeHidden();
});

test('mouse selection copies Unicode text (CP437 and Latin-1 cells); clipboard refusal is reported', async ({ page, context }, ti) => {
    await open(page);
    // Slot 42 is an Amiga slot (Latin-1 text); our ISO-8859-1 font stands in
    // so the test does not depend on the fetched Amiga fonts.
    await loadPcFont(page, 42);
    await write(page, `${CSI}2J${CSI}2;3H\xc9\xcd\xcd\xbb box ${CSI}0;42 Dcaf\xe9${CSI}0;0 D \xb0\xb1\xb2${CSI}3;3Hsecond line   `);
    await page.evaluate(() => {
        (window as any).copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => void (window as any).copied.push(s), readText: async () => 'from clipboard' } });
    });
    const a = await cellPoint(page, 2, 1);
    const b = await cellPoint(page, 7, 2);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 3 });
    await page.mouse.move(b.x, b.y, { steps: 3 });
    await page.mouse.up();
    const sel = await page.evaluate(() => (window as any).enigTerm.selectionText());
    const want = `${String.fromCharCode(0x2554, 0x2550, 0x2550, 0x2557)} box caf${String.fromCharCode(0xe9)} ${String.fromCharCode(0x2591, 0x2592, 0x2593)}\n  second`;
    expect(sel).toBe(want);
    await page.evaluate(() => (window as any).enigTerm.renderFrame(false));
    await shot(page, 'selection', ti.project.name);
    const copyBtn = page.locator('enig-term').locator('[data-act="copy"]');
    await expect(copyBtn).toBeEnabled();
    await copyBtn.click();
    await expect.poll(() => page.evaluate(() => (window as any).copied)).toEqual([want]);

    // Ctrl+C with a selection copies instead of sending ^C.
    await page.evaluate(() => {
        const t = (window as any).enigTerm;
        (window as any).sent = [];
        t.onLocalReply = (x: Uint8Array) => (window as any).sent.push(...x);
        t.input.focus();
    });
    await page.keyboard.press('Control+c');
    expect(await page.evaluate(() => (window as any).sent)).toEqual([]);
    expect(await page.evaluate(() => (window as any).copied.length)).toBe(2);

    // A refused clipboard: the user is told.
    await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });
        document.execCommand = () => false;
    });
    expect(await page.evaluate(() => (window as any).enigTerm.copySelection())).toBe(false);
    await expect(page.locator('enig-term').locator('[data-toast]')).toContainText('refused clipboard access');
    // A key drops the selection (and goes to the host).
    await page.keyboard.press('x');
    expect(await page.evaluate(() => (window as any).enigTerm.selection)).toBe(null);
    expect(await page.evaluate(() => (window as any).sent)).toEqual([0x78]);
});

test('double-click selects a word', async ({ page }) => {
    await open(page);
    await write(page, `${CSI}2J${CSI}1;1Hhello wonderful world`);
    const p = await cellPoint(page, 8, 0);
    await page.mouse.dblclick(p.x, p.y);
    expect(await page.evaluate(() => (window as any).enigTerm.selectionText())).toBe('wonderful');
});

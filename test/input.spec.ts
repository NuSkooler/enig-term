// Input: keymap, typed text encoding, IME/composition and soft-keyboard
// paths, paste. Host-bound bytes are captured through onLocalReply.
import { test, expect, type Page } from '@playwright/test';
import { open, captureSent, sent, write, CSI, ESC, loadPcFont } from './helpers';

const bytes = (s: string) => [...s].map(c => c.charCodeAt(0));

/** Drive the textarea the way a soft keyboard or IME does. */
async function softType(page: Page, steps: { value: string; type: string; data?: string | null; composing?: boolean }[]) {
    await page.evaluate(steps => {
        const t = (window as any).enigTerm;
        const ta: HTMLTextAreaElement = t.input.textarea;
        for (const s of steps) {
            if (s.type === 'compositionstart' || s.type === 'compositionend') {
                if (s.type === 'compositionend') ta.value = s.value;
                ta.dispatchEvent(new CompositionEvent(s.type, { data: s.data ?? '' }));
                continue;
            }
            // Gboard: every key is keyCode 229 with an "Unidentified" key.
            ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true } as KeyboardEventInit));
            const before = new InputEvent('beforeinput', { inputType: s.type, data: s.data ?? null, isComposing: !!s.composing, cancelable: true, bubbles: true });
            if (!ta.dispatchEvent(before)) continue;
            ta.value = s.value;
            ta.dispatchEvent(new InputEvent('input', { inputType: s.type, data: s.data ?? null, isComposing: !!s.composing, bubbles: true }));
        }
    }, steps);
}

test('typed text is CP437; named keys are ANSI-BBS sequences', async ({ page }) => {
    await open(page);
    await captureSent(page);
    await page.keyboard.type('Hi é');
    expect(await sent(page)).toEqual([0x48, 0x69, 0x20, 0x82]);
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Insert', 'PageUp', 'PageDown']) await page.keyboard.press(k);
    expect(await sent(page)).toEqual(bytes(['A', 'B', 'C', 'D', 'H', 'K', '@', 'V', 'U'].map(c => CSI + c).join('')));
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+C');
    await page.keyboard.press('Control+a');
    expect(await sent(page)).toEqual([13, 8, 0x7f, 9, ...bytes(CSI + 'Z'), 27, 3, 1]);
    for (let i = 1; i <= 12; i++) await page.keyboard.press(`F${i}`);
    const f = ['OP', 'OQ', 'OR', 'OS'].map(s => ESC + s).concat(['15', '17', '18', '19', '20', '21', '23', '24'].map(n => `${CSI}${n}~`));
    expect(await sent(page)).toEqual(bytes(f.join('')));
    await page.keyboard.press('Alt+x');
    expect(await sent(page)).toEqual([27, 0x78]);
});

// Slot 42 gets a licensed stand-in font (Latin-1 order): the charset follows
// the slot number, and Amiga fonts are not part of the repo.
test('text goes out as Latin-1 while an Amiga font is active', async ({ page }) => {
    await open(page);
    await captureSent(page);
    await loadPcFont(page, 42);
    await write(page, `${CSI}0;42 D`);
    await page.keyboard.type('é');
    expect(await sent(page)).toEqual([0xe9]);
    await write(page, `${CSI}0;0 D`);
    await page.keyboard.type('é');
    expect(await sent(page)).toEqual([0x82]);
});

test('host queries are answered through the same path (CPR, DA with the package version, CTDA, =6n)', async ({ page }) => {
    await open(page);
    await captureSent(page);
    await write(page, `${CSI}5;7H${CSI}6n`);
    expect(String.fromCharCode(...(await sent(page)))).toBe(`${CSI}5;7R`);
    await write(page, `${CSI}c`);
    const v = (await import('./helpers')).pkgVersion().split('.').join(';');
    expect(String.fromCharCode(...(await sent(page)))).toBe(`${CSI}=101;110;105;103;45;116;101;114;109;${v}c`);
    await write(page, `${CSI}<c${CSI}=6n${CSI}5n`);
    expect(String.fromCharCode(...(await sent(page)))).toBe(`${CSI}<0;1;2;3;5c${CSI}=6;1n${CSI}0n`);
});

test('composition (IME): nothing is sent until it ends, then the committed text', async ({ page }) => {
    await open(page);
    await captureSent(page);
    await softType(page, [
        { type: 'compositionstart', value: '' },
        { type: 'insertCompositionText', value: '  e', data: 'e', composing: true },
        { type: 'insertCompositionText', value: '  é', data: 'é', composing: true },
        { type: 'compositionend', value: '  é', data: 'é' },
    ]);
    expect(await sent(page)).toEqual([0x82]);
});

test('Gboard (keyCode 229): text, backspace and a predictive replacement', async ({ page }) => {
    await open(page);
    await captureSent(page);
    await softType(page, [
        { type: 'insertText', value: '  t', data: 't' },
        { type: 'insertText', value: '  te', data: 'e' },
        { type: 'insertText', value: '  teh', data: 'h' },
        // The keyboard swaps the word for its suggestion.
        { type: 'insertReplacementText', value: '  the', data: 'the' },
        { type: 'deleteContentBackward', value: '  th' },
        // Soft Enter: insertLineBreak becomes CR and the textarea stays one line.
        { type: 'insertLineBreak', value: '  th\n' },
    ]);
    expect(await sent(page)).toEqual([...bytes('teh'), 8, 8, ...bytes('he'), 8, 13]);
});

test('backspace on an empty soft-keyboard buffer still sends BS (sentinel)', async ({ page }) => {
    await open(page);
    await captureSent(page);
    await softType(page, [
        { type: 'deleteContentBackward', value: ' ' },
        { type: 'deleteContentBackward', value: ' ' },
    ]);
    expect(await sent(page)).toEqual([8, 8]);
});

test('paste: encoded like typing, CR line ends, sent in chunks', async ({ page }) => {
    await open(page);
    await captureSent(page);
    const chunks = await page.evaluate(async () => {
        const t = (window as any).enigTerm;
        const sizes: number[] = [];
        t.onLocalReply = (b: Uint8Array) => {
            sizes.push(b.length);
            (window as any).sent.push(...b);
        };
        const text = 'caf' + String.fromCharCode(0xe9) + '\r\nline2\n' + 'x'.repeat(600);
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
        // A script-made DataTransfer is empty in Firefox; stand in for the real one.
        Object.defineProperty(ev, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? text : '') } });
        t.input.textarea.dispatchEvent(ev);
        await new Promise(r => setTimeout(r, 200));
        return sizes;
    });
    const got = await sent(page);
    expect(got.slice(0, 11)).toEqual([0x63, 0x61, 0x66, 0x82, 13, ...bytes('line2'), 13]);
    expect(got.length).toBe(11 + 600);
    expect(Math.max(...chunks)).toBeLessThanOrEqual(256);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
});

test('paste under an Amiga font is Latin-1', async ({ page }) => {
    await open(page);
    await captureSent(page);
    await loadPcFont(page, 42);
    await write(page, `${CSI}0;42 D`);
    await page.evaluate(() => (window as any).enigTerm.paste('Grüße'));
    await page.waitForTimeout(50);
    expect(await sent(page)).toEqual([0x47, 0x72, 0xfc, 0xdf, 0x65]);
});

test('tapping the screen focuses the input', async ({ page }) => {
    await open(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('canvas').click({ position: { x: 50, y: 50 } });
    expect(await page.evaluate(() => (window as any).enigTerm.input.focused)).toBe(true);
});

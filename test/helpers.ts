// Shared helpers for the Playwright specs.
import { expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const SHOTS = path.join(process.cwd(), 'test', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

export const ESC = String.fromCharCode(27);
export const CSI = ESC + '[';
export const ST = ESC + '\\';

/** Open the standalone page and wait for the terminal. */
export async function open(page: Page, query = '') {
    page.on('pageerror', e => console.log(`[pageerror] ${e.message}`));
    page.on('console', m => {
        if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) console.log(`[console.error] ${m.text()}`);
    });
    await page.goto(`/?blink=0${query}`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 20_000 });
}

/** Capture host-bound bytes while not connected. */
export async function captureSent(page: Page) {
    await page.evaluate(() => {
        const t = (window as any).enigTerm;
        (window as any).sent = [];
        t.onLocalReply = (b: Uint8Array) => (window as any).sent.push(...b);
        t.input.focus();
    });
}
export const sent = (page: Page) => page.evaluate(() => (window as any).sent.splice(0) as number[]);

export async function write(page: Page, s: string) {
    await page.evaluate(x => {
        const t = (window as any).enigTerm;
        t.write(x);
        t.renderFrame(false);
    }, s);
}

/** Text of a displayed row (view-aware), trailing blanks trimmed. */
export function rowText(page: Page, y: number) {
    return page.evaluate(
        y => String.fromCharCode(...Array.from((window as any).enigTerm.core.core.row_cells(y) as Uint32Array, v => v & 0xffff)).trimEnd(),
        y,
    );
}

/** Client coordinates of the centre of cell (x, y). */
export async function cellPoint(page: Page, x: number, y: number) {
    return page.evaluate(
        ([x, y]) => {
            const t = (window as any).enigTerm;
            const r = t.canvas.getBoundingClientRect();
            return { x: r.left + ((x + 0.5) / t.core.cols) * r.width, y: r.top + ((y + 0.5) / t.core.rows) * r.height };
        },
        [x, y],
    );
}

export async function fakeLog(page: Page, id: string) {
    const r = await page.request.get(`/fake-bbs/log?id=${encodeURIComponent(id)}`);
    return (await r.json()) as { conn: number; sent: number[]; events: string[] }[];
}

export function fakeUrl(page: Page, script: string, id: string) {
    const base = new URL(page.url());
    return `ws://${base.host}/fake-bbs?script=${script}&id=${encodeURIComponent(id)}`;
}

export async function waitState(page: Page, state: string, timeout = 10_000) {
    await expect.poll(() => page.evaluate(() => (window as any).enigTerm.state), { timeout }).toBe(state);
}

export async function shot(page: Page, name: string, project: string) {
    const file = path.join(SHOTS, `${project}-${name}.png`);
    await page.locator('canvas').first().screenshot({ path: file });
    return file;
}

export const pkgVersion = (): string => JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version;

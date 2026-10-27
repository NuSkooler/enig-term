// File transfers against a real ENiGMA (a throwaway instance, never the dev
// board), through its real transfer programs: sexyz (ZModem 8k, YModem,
// XModem) and lrzsz (ZModem 8k), in every desktop browser. Skipped unless
// ENIG_TERM_LIVE_XFER (the board's ws:// URL) and ENIG_TERM_LIVE_XFER_DIR
// (its scratch tree) are set. The board needs:
//   - a user ENIG_TERM_LIVE_USER / ENIG_TERM_LIVE_PASS (default xfertest),
//   - the luciano_blocktronics theme and the stock menus, plus a menu
//     "xferTests" (main menu command XT) whose commands D<proto>-<SET> send
//     the files of <DIR>/src/<set>/ with file_transfer (protocols ZS
//     zmodem8kSexyz, ZL zmodem8kSz, YS ymodemSexyz, XS xmodemSexyz;
//     <DIR>/src/manifest.json lists them with their SHA-256),
//   - a file area that takes uploads, stored in <DIR>/file_base/uploads.
// Downloads are checked byte for byte as the browser saved them; uploads go
// through ENiGMA's own upload path (file base, upload, protocol selection,
// transfer, scan, details) and are checked as they landed in the area.
// A log of each run goes to test/screenshots/live-xfer-<browser>.log.
import { test, expect, type Page, type Download } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SHOTS, open, waitState } from './helpers';
import { allBytes } from './xfer-peers.mjs';

const WS = process.env.ENIG_TERM_LIVE_XFER;
const DIR = process.env.ENIG_TERM_LIVE_XFER_DIR ?? '';
const USER = process.env.ENIG_TERM_LIVE_USER ?? 'xfertest';
const PASS = process.env.ENIG_TERM_LIVE_PASS ?? 'Xfer-Test-2026';

type Manifest = Record<string, { name: string; size: number; sha: string; path: string }[]>;
const manifest = (): Manifest => JSON.parse(fs.readFileSync(path.join(DIR, 'src', 'manifest.json'), 'utf8'));
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const SUB = 0x1a;
const pad128 = (b: Buffer) => Buffer.concat([b, Buffer.alloc((128 - (b.length % 128)) % 128, SUB)]);

let logFile = '';
const log = (s: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`);

function screen(page: Page): Promise<string> {
    return page.evaluate(() => {
        const t = (window as any).enigTerm;
        const rows: string[] = [];
        for (let y = 0; y < t.core.rows; y++) rows.push(String.fromCharCode(...Array.from(t.core.core.row_cells(y) as Uint32Array, v => v & 0xffff)).trimEnd());
        return rows.join('\n');
    });
}

async function waitText(page: Page, text: string | RegExp, timeout = 20_000) {
    const t0 = Date.now();
    for (;;) {
        const s = await screen(page);
        if (typeof text === 'string' ? s.includes(text) : text.test(s)) return s;
        if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${text}; screen:\n${s}`);
        await page.waitForTimeout(150);
    }
}

async function keys(page: Page, ...ks: string[]) {
    await page.evaluate(() => (window as any).enigTerm.input.focus());
    for (const k of ks) {
        if (/^[A-Z][a-z]+$|^Arrow|^F\d+$/.test(k) && k.length > 1) await page.keyboard.press(k);
        else await page.keyboard.type(k);
        await page.waitForTimeout(120);
    }
}

const phase = (page: Page) => page.evaluate(() => (window as any).enigTerm.transfers.status.phase as string);
const status = (page: Page) => page.evaluate(() => (window as any).enigTerm.transfers.status);
/** The end of a transfer; with `prev` (the status before it), not the last one's that is still shown. */
async function finished(page: Page, timeout = 120_000, prev?: string) {
    await expect
        .poll(async () => {
            const st = await status(page);
            return prev !== undefined && JSON.stringify(st) === prev ? 'previous' : st.phase;
        }, { timeout })
        .toMatch(/done|failed|cancelled/);
    return status(page);
}
const ui = (page: Page, sel: string) => page.locator('enig-term').locator(sel);

/** Log in and get to the main menu (luciano_blocktronics flow). */
async function login(page: Page) {
    await open(page);
    await page.evaluate(() => (window as any).enigTerm.set('zmodemDetect', 'auto'));
    await page.evaluate(u => (window as any).enigTerm.connect(u), WS!);
    await waitState(page, 'connected');
    await waitText(page, 'lOGIN');
    await keys(page, 'Enter');
    await page.waitForTimeout(1000);
    await keys(page, USER, 'Enter');
    await page.waitForTimeout(300);
    await keys(page, PASS, 'Enter');
    const t0 = Date.now();
    for (;;) {
        const s = await screen(page);
        if (s.includes('MAIN MENU') && s.includes('cmd:')) break;
        if (Date.now() - t0 > 60_000) throw new Error(`login: stuck at\n${s}`);
        if (s.includes('add a oneliner')) await keys(page, 'N', 'Enter');
        else if (s.includes('global newscan')) await keys(page, 'N', 'Enter');
        else if (s.includes('smash your keyboard')) await keys(page, ' ');
        await page.waitForTimeout(700);
    }
    log('logged in');
}

/** From the main menu to the transfer tests menu. */
async function testsMenu(page: Page) {
    await keys(page, 'XT', 'Enter');
    await waitText(page, 'cmd:');
}

/** Back at a menu prompt: the line and the keyboard are the terminal's again. */
async function usable(page: Page) {
    // The screen may still show the prompt from before the transfer: wait for
    // the line, then for the board to be done drawing (quiet for 2 s).
    await expect.poll(() => page.evaluate(() => (window as any).enigTerm.transfers.busy), { timeout: 60_000 }).toBe(false);
    const bytesIn = () => page.evaluate(() => (window as any).enigTerm.stats.bytesIn as number);
    let last = await bytesIn();
    let since = Date.now();
    for (const t0 = Date.now(); Date.now() - since < 2000; ) {
        if (Date.now() - t0 > 60_000) throw new Error('the board never went quiet');
        await page.waitForTimeout(250);
        const n = await bytesIn();
        if (n !== last) {
            last = n;
            since = Date.now();
        }
    }
    await waitText(page, 'cmd:', 30_000);
}

function downloads(page: Page) {
    const got: Download[] = [];
    page.on('download', d => got.push(d));
    return got;
}
const saved = async (d: Download) => fs.readFileSync((await d.path())!);

/** A board-side download: D<proto>-<SET> from the tests menu. */
async function download(page: Page, proto: string, set: string, opts: { panel?: string; cancelAt?: number; killAt?: number } = {}) {
    const dl = downloads(page);
    const before = (await screen(page)).split('\n').filter(l => l.trim()).slice(-2).join(' | ');
    log(`download ${proto} ${set}: the screen ends with: ${before}`);
    // (Nothing to clear first: when a transfer ends because the board left,
    // the engine rubs out what reached its prompt as typing. ENiGMA keeps an
    // unknown command in the field, so leftovers would break the next one.)
    const prev = JSON.stringify(await status(page));
    await keys(page, `D${proto}-${set.toUpperCase()}`, 'Enter');
    if (opts.panel) {
        // X/YModem cannot announce themselves: the user starts receiving once the board is sending.
        await page.waitForTimeout(1500);
        await ui(page, '[data-act="files"]').click();
        await ui(page, '[data-xf="dir"]').selectOption('download');
        await ui(page, '[data-xf="proto"]').selectOption(opts.panel);
        await ui(page, '[data-act="xf-start"]').click();
    }
    if (opts.cancelAt || opts.killAt) {
        // (This transfer's: the last one's status stays until a new one starts.)
        await expect
            .poll(async () => {
                const st = await status(page);
                return st.phase === 'running' ? st.fileBytes : 0;
            }, { timeout: 60_000 })
            .toBeGreaterThan(opts.cancelAt ?? opts.killAt!);
        if (opts.cancelAt) await page.evaluate(() => (document.querySelector('enig-term')!.shadowRoot!.querySelector('[data-act="xf-cancel"]') as HTMLElement).click());
        // The board's program: lrzsz's sz names the file; sexyz gets a list file.
        else {
            try {
                execFileSync('pkill', ['-TERM', '-f', proto === 'ZL' ? `sz --zmodem.*${DIR}/src/big` : '^sexyz -telnet']);
            } catch {
                // Nothing to kill: the program had already written the whole file
                // into the board's buffers (ZModem streams) and exited.
                log(`download ${proto} ${set}: the program had already finished; no abort`);
                return { st: await finished(page, 600_000, prev), dl, killed: false };
            }
        }
    }
    const st = await finished(page, 600_000, prev);
    log(`download ${proto} ${set}: ${st.phase} ${st.error ?? ''} ${JSON.stringify(st.files.map((f: any) => [f.name, f.size, f.ok]))}`);
    return { st, dl, killed: true };
}

async function checkDownloads(dl: Download[], set: string, xmodem = false) {
    const want = manifest()[set];
    await expect.poll(() => dl.length, { timeout: 30_000 }).toBe(want.length);
    for (const w of want) {
        const d = xmodem ? dl[0] : dl.find(x => x.suggestedFilename() === w.name);
        expect(d, w.name).toBeTruthy();
        const b = await saved(d!);
        expect(sha(b), `${w.name} as saved`).toBe(xmodem ? sha(pad128(fs.readFileSync(w.path))) : w.sha);
    }
}

/** Unique upload files (ENiGMA refuses duplicate content): every byte value, then random bytes. */
function uploadFiles(tag: string, n: number, size = 70_000) {
    return Array.from({ length: n }, (_, i) => {
        const data = Buffer.concat([Buffer.from(allBytes(Math.min(size, 66_000))), crypto.randomBytes(Math.max(0, size - 66_000))]);
        return { name: `${tag}${i}.bin`, data };
    });
}

/**
 * ENiGMA's upload path: file base (F), upload (U), the options form, the
 * protocol list, the transfer, then a details form per file.
 */
async function upload(page: Page, protoLabel: RegExp, files: { name: string; data: Buffer }[], how: 'zmodem' | 'ymodem' | 'xmodem') {
    await keys(page, 'Q', 'Enter'); // tests menu -> main menu
    await waitText(page, 'MAIN MENU');
    await keys(page, 'F', 'Enter');
    await waitText(page, 'cmd:');
    await keys(page, 'U', 'Enter');
    await waitText(page, 'u/l type');
    await page.waitForTimeout(500);
    if (how === 'xmodem') {
        // XModem has no file names: "supply filename", then the name.
        await keys(page, 'Enter', 'ArrowRight', 'Enter');
        await page.waitForTimeout(300);
        await keys(page, files[0].name, 'Enter', 'Enter');
    } else await keys(page, 'Enter', 'Enter', 'Enter', 'Enter');
    const sel = await waitText(page, 'PROTOCOL SELECTION');
    const items = sel.split('\n').filter(l => /modem/i.test(l)).map(l => l.trim());
    const idx = items.findIndex(l => protoLabel.test(l));
    expect(idx, `protocol ${protoLabel} in ${JSON.stringify(items)}`).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < idx; i++) await keys(page, 'ArrowDown');
    const fc = how === 'zmodem' ? page.waitForEvent('filechooser', { timeout: 30_000 }) : null;
    await keys(page, 'Enter');
    if (how === 'zmodem') {
        // The board's receiver announces itself; the card asks for the files.
        await expect.poll(() => phase(page), { timeout: 30_000 }).toBe('offer');
        await ui(page, '[data-act="xf-offer-files"]').click();
        await (await fc)!.setFiles(files.map(f => ({ name: f.name, mimeType: 'application/octet-stream', buffer: f.data })));
    } else {
        await page.waitForTimeout(1500);
        await ui(page, '[data-act="files"]').click();
        await ui(page, '[data-xf="dir"]').selectOption('upload');
        await ui(page, '[data-xf="proto"]').selectOption(how);
        const c = page.waitForEvent('filechooser');
        await ui(page, '[data-act="xf-pick"]').click();
        await (await c).setFiles(files.map(f => ({ name: f.name, mimeType: 'application/octet-stream', buffer: f.data })));
        await ui(page, '[data-act="xf-start"]').click();
    }
    const st = await finished(page, 600_000);
    log(`upload ${how} ${protoLabel}: ${st.phase} ${st.error ?? ''} ${JSON.stringify(st.files.map((f: any) => [f.name, f.size, f.ok]))}`);
    // ENiGMA scans what arrived, then asks for each file's details.
    // (each form's title names its file: answer each one once)
    const seen = new Set<string>();
    let lastAnswer = 0;
    let details = 0;
    const t0 = Date.now();
    for (;;) {
        const s = await screen(page);
        const title = s.split('\n').find(l => l.includes('UPLOAD DETAILS'));
        // (a form still there 8 s after it was answered is taken for the next one)
        if (title && (!seen.has(title.trim()) || Date.now() - lastAnswer > 8000)) {
            log(`details form: ${title.trim()}`);
            seen.add(title.trim());
            await page.waitForTimeout(1000); // the form's fields come up after its art
            lastAnswer = Date.now();
            details = seen.size;
            await keys(page, `enig-term test upload ${details}`, 'Tab', 'Tab', 'Tab', 'Enter');
            await page.waitForTimeout(1500);
            continue;
        }
        if (s.includes('cmd:')) break;
        if (Date.now() - t0 > 90_000) throw new Error(`upload: stuck after the transfer at\n${s}`);
        if (/smash|press any key|continue/i.test(s)) await keys(page, ' ');
        await page.waitForTimeout(700);
    }
    log(`upload ${how}: ${details} details forms`);
    return { st, details };
}

function landed(name: string) {
    const p = path.join(DIR, 'file_base', 'uploads', name);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

test.describe('live ENiGMA transfers', () => {
    test.skip(!WS || !DIR, 'set ENIG_TERM_LIVE_XFER and ENIG_TERM_LIVE_XFER_DIR to run');

    test.beforeEach(async ({}, ti) => {
        logFile = path.join(SHOTS, `live-xfer-${ti.project.name}.log`);
        log(`--- ${ti.title}`);
    });

    // A failure: the terminal's own log (transfer engine lines included) goes into ours.
    test.afterEach(async ({ page }, ti) => {
        if (ti.status === ti.expectedStatus) return;
        const lines = await page.evaluate(() => ((window as any).enigTerm?.log as string[] | undefined)?.slice(-80) ?? []).catch(() => []);
        for (const l of lines) log(`  terminal: ${l}`);
    });

    // --- downloads: every protocol ENiGMA offers -------------------------------------
    for (const [proto, label, panel] of [
        ['ZS', 'ZModem 8k (SEXYZ)', undefined],
        ['ZL', 'ZModem 8k (lrzsz)', undefined],
        ['YS', 'YModem (SEXYZ)', 'ymodem'],
        ['XS', 'XModem (SEXYZ)', 'xmodem'],
    ] as const) {
        test(`download ${label}: every byte value${proto === 'XS' ? '' : ', then a batch'}`, async ({ page }) => {
            test.setTimeout(300_000);
            await login(page);
            await testsMenu(page);
            let r = await download(page, proto, 'all', { panel });
            expect(r.st.phase, JSON.stringify(r.st)).toBe('done');
            await checkDownloads(r.dl, 'all', proto === 'XS');
            await usable(page);
            if (proto === 'XS') return;
            r = await download(page, proto, 'batch', { panel });
            expect(r.st.phase, JSON.stringify(r.st)).toBe('done');
            await checkDownloads(r.dl, 'batch');
            await usable(page);
        });
    }

    test('download 10 MB: ZModem 8k (SEXYZ) and ZModem 8k (lrzsz)', async ({ page }) => {
        test.setTimeout(600_000);
        await login(page);
        await testsMenu(page);
        for (const proto of ['ZS', 'ZL']) {
            const r = await download(page, proto, 'big');
            expect(r.st.phase, JSON.stringify(r.st)).toBe('done');
            await checkDownloads(r.dl, 'big');
            await usable(page);
        }
    });

    test('download 10 MB: YModem (SEXYZ)', async ({ page }, ti) => {
        // Stop-and-wait: one round trip per KB. Playwright's Chromium here takes
        // 50-200 ms per WebSocket round trip (Firefox and WebKit about 1 ms).
        test.skip(ti.project.name === 'chromium', 'too slow where a WebSocket round trip is slow');
        test.setTimeout(600_000);
        await login(page);
        await testsMenu(page);
        const r = await download(page, 'YS', 'big', { panel: 'ymodem' });
        expect(r.st.phase, JSON.stringify(r.st)).toBe('done');
        await checkDownloads(r.dl, 'big');
        await usable(page);
    });

    test('download, cancelled by the user mid-file (ZModem SEXYZ and lrzsz, YModem): the board stops, the terminal is usable', async ({ page }) => {
        test.setTimeout(300_000);
        await login(page);
        await testsMenu(page);
        for (const [proto, panel, at] of [['ZS', undefined, 2_000_000], ['ZL', undefined, 2_000_000], ['YS', 'ymodem', 30_000]] as const) {
            const r = await download(page, proto, 'big', { panel, cancelAt: at });
            expect(r.st.phase).toBe('cancelled');
            await usable(page);
        }
    });

    test('download, the board aborts mid-file (its program killed): the transfer fails cleanly, the terminal is usable', async ({ page }) => {
        test.setTimeout(300_000);
        await login(page);
        await testsMenu(page);
        // ZModem streams: the board's program may have written the whole file
        // into its buffers well before the browser has it, so it is killed as
        // soon as data arrives (YModem cannot run ahead).
        for (const [proto, panel, at] of [['ZS', undefined, 1], ['ZL', undefined, 1], ['YS', 'ymodem', 30_000]] as const) {
            const r = await download(page, proto, 'big', { panel, killAt: at });
            if (r.killed || proto !== 'ZL') expect(r.st.phase).toBe('failed');
            await usable(page);
        }
    });

    // --- uploads, through ENiGMA's upload path ---------------------------------------
    for (const [label, re, how, n] of [
        ['ZModem 8k (SEXYZ)', /ZModem 8k \(SEXYZ\)/, 'zmodem', 3],
        ['ZModem 8k (lrzsz)', /^ZModem 8k$/, 'zmodem', 3],
        ['YModem (SEXYZ)', /YModem \(SEXYZ\)/, 'ymodem', 3],
        ['XModem (SEXYZ)', /XModem \(SEXYZ\)/, 'xmodem', 1],
    ] as const) {
        test(`upload ${label}: ${n > 1 ? `a batch of ${n}` : 'one file'} with every byte value lands byte-identical in the file area`, async ({ page }, ti) => {
            test.setTimeout(300_000);
            await login(page);
            await testsMenu(page);
            const tag = `u${ti.project.name.slice(0, 2)}${how.slice(0, 1)}${label.includes('lrzsz') ? 'l' : 's'}${Date.now().toString(36)}x`;
            // XModem pads to 128 bytes and ENiGMA keeps the padding: send a multiple of 128.
            const files = uploadFiles(tag, n, how === 'xmodem' ? 128 * 600 : 70_000);
            const r = await upload(page, re, files, how);
            expect(r.st.phase, JSON.stringify(r.st)).toBe('done');
            expect(r.details).toBe(n);
            for (const f of files) {
                const got = landed(f.name);
                expect(got, `${f.name} in the area`).toBeTruthy();
                expect(sha(got!), `${f.name} byte-identical`).toBe(sha(f.data));
            }
            await usable(page);
        });
    }

    // ENiGMA's DSZLOG salvage (core/dszlog.js): sexyz exits non-zero when a
    // batch is cut short, and ENiGMA keeps the files its DSZLOG confirms.
    for (const [label, re, how] of [
        ['YModem (SEXYZ)', /YModem \(SEXYZ\)/, 'ymodem'],
        ['ZModem 8k (SEXYZ)', /ZModem 8k \(SEXYZ\)/, 'zmodem'],
    ] as const) {
        test(`upload ${label} cancelled after the first file of a batch: ENiGMA keeps what its DSZLOG confirms`, async ({ page }, ti) => {
            test.setTimeout(300_000);
            await login(page);
            await testsMenu(page);
            const tag = `d${ti.project.name.slice(0, 2)}${how.slice(0, 1)}${Date.now().toString(36)}x`;
            const files = uploadFiles(tag, 3, 600_000);
            // Cancel (the card's button, from inside the page) once the first file is through.
            void page.evaluate(
                () =>
                    new Promise<void>(ok => {
                        const iv = setInterval(() => {
                            const t = (window as any).enigTerm;
                            if (t.transfers.status.files.length >= 1 && t.transfers.status.phase === 'running') {
                                clearInterval(iv);
                                (document.querySelector('enig-term')!.shadowRoot!.querySelector('[data-act="xf-cancel"]') as HTMLElement).click();
                                ok();
                            }
                        }, 2);
                    }),
            );
            const r = await upload(page, re, files, how);
            expect(r.st.phase, JSON.stringify(r.st)).toBe('cancelled');
            const first = landed(files[0].name);
            expect(first, `${files[0].name} kept`).toBeTruthy();
            expect(sha(first!)).toBe(sha(files[0].data));
            expect(landed(files[2].name), 'the file never sent is not there').toBeNull();
            expect(r.details).toBeGreaterThanOrEqual(1);
            await usable(page);
        });
    }

    test('upload 10 MB with ZModem 8k (SEXYZ)', async ({ page }, ti) => {
        test.setTimeout(600_000);
        await login(page);
        await testsMenu(page);
        const tag = `big${ti.project.name.slice(0, 2)}${Date.now().toString(36)}x`;
        const files = [{ name: `${tag}.bin`, data: Buffer.concat([Buffer.from(allBytes(66_000)), crypto.randomBytes((10 << 20) - 66_000)]) }];
        const r = await upload(page, /ZModem 8k \(SEXYZ\)/, files, 'zmodem');
        expect(r.st.phase, JSON.stringify(r.st)).toBe('done');
        expect(sha(landed(files[0].name)!)).toBe(sha(files[0].data));
        await usable(page);
    });
});

// File transfers in the browser against real transfer programs: the fake
// BBS (test/fake-bbs.mjs, script "xfer") runs lrzsz or sexyz over the
// WebSocket the way ENiGMA does (sexyz -telnet; lrzsz with IAC escaping;
// status text in the stream). Downloads are checked byte for byte as the
// browser saved them, uploads as the program wrote them. Cells whose program
// is not installed are skipped. The live ENiGMA matrix is transfer-live.spec.ts.
import { test, expect, type Page, type Download } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fakeLog, fakeUrl, open, waitState } from './helpers';
import { LRZSZ, SEXYZ, allBytes, craftedZmodem, random } from './xfer-peers.mjs';

const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const enc = (s: string) => Buffer.from(s, 'latin1');
const SUB = 0x1a;
const pad128 = (b: Buffer) => Buffer.concat([b, Buffer.alloc((128 - (b.length % 128)) % 128, SUB)]);

let seq = 0;

/**
 * Connect to the fake BBS running `peer`, and have it start the program.
 * `detect`: zmodemDetect (not a URL parameter), or null for the default.
 */
async function board(page: Page, params: Record<string, string>, query = '', detect: 'auto' | 'ask' | 'off' | null = 'auto') {
    await open(page, query);
    if (detect) await page.evaluate(d => (window as any).enigTerm.set('zmodemDetect', d), detect);
    const id = `xfer-${Date.now()}-${++seq}`;
    const q = Object.entries(params).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
    await page.evaluate(u => (window as any).enigTerm.connect(u), fakeUrl(page, `xfer${q}`, id));
    await waitState(page, 'connected');
    await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain('type g');
    await page.evaluate(() => (window as any).enigTerm.input.focus());
    await page.keyboard.type('g');
    await expect.poll(async () => (await fakeLog(page, id))[0]?.events.some(e => e.startsWith('start ')), { timeout: 10_000 }).toBe(true);
    return id;
}

function screenText(page: Page): Promise<string> {
    return page.evaluate(() => {
        const t = (window as any).enigTerm;
        const rows: string[] = [];
        for (let y = 0; y < t.core.rows; y++) rows.push(String.fromCharCode(...Array.from(t.core.core.row_cells(y) as Uint32Array, v => v & 0xffff)).trimEnd());
        return rows.join('\n');
    });
}

const phase = (page: Page) => page.evaluate(() => (window as any).enigTerm.transfers.status.phase as string);
const status = (page: Page) => page.evaluate(() => (window as any).enigTerm.transfers.status);

async function finished(page: Page, timeout = 90_000) {
    await expect.poll(() => phase(page), { timeout }).toMatch(/done|failed|cancelled/);
    return status(page);
}

/** Collect the browser's downloads. */
function downloads(page: Page) {
    const got: Download[] = [];
    page.on('download', d => got.push(d));
    return got;
}

async function savedBytes(d: Download): Promise<Buffer> {
    const p = await d.path();
    return fs.readFileSync(p!);
}

async function srcFiles(page: Page, id: string) {
    const ev = (await fakeLog(page, id))[0].events;
    return ev.filter(e => e.startsWith('src ')).map(e => e.split(' ')).map(([, n, h]) => ({ name: n, sha: h }));
}

async function gotFiles(page: Page, id: string) {
    await expect.poll(async () => (await fakeLog(page, id))[0].events.some(e => e.startsWith('exit ')), { timeout: 30_000 }).toBe(true);
    const ev = (await fakeLog(page, id))[0].events;
    return { exit: ev.find(e => e.startsWith('exit '))!, files: ev.filter(e => e.startsWith('got ')).map(e => e.split(' ')).map(([, n, s, h]) => ({ name: n, size: Number(s), sha: h })) };
}

/** After a transfer the terminal is the user's again: the board's text shows, and keys reach it. */
async function usableAfter(page: Page, id: string) {
    // The board says so once its program has exited; lrzsz's sz can take a while to exit after a cancel
    // on a slow CI runner (over 15 s seen), so this waits on the hand-back, not on the program's speed.
    await expect.poll(() => screenText(page), { timeout: 45_000 }).toContain('transfer over');
    const before = (await fakeLog(page, id))[0].sent.length;
    await page.evaluate(() => (window as any).enigTerm.input.focus());
    await page.keyboard.type('zq');
    await expect.poll(async () => (await fakeLog(page, id))[0].sent.slice(before), { timeout: 5000 }).toEqual([0x7a, 0x71]);
}

/** Pick files in the file chooser that `click` opens. */
async function chooseFiles(page: Page, click: () => Promise<void>, files: { name: string; data: Buffer }[]) {
    const fc = page.waitForEvent('filechooser');
    await click();
    await (await fc).setFiles(files.map(f => ({ name: f.name, mimeType: 'application/octet-stream', buffer: f.data })));
}

const ui = (page: Page, sel: string) => page.locator('enig-term').locator(sel);

/** Press the transfer card's Cancel once `bytes` of the file are in. */
function cancelAt(page: Page, bytes: number) {
    return page.evaluate(
        n =>
            new Promise<void>((ok, no) => {
                const t0 = Date.now();
                const iv = setInterval(() => {
                    const t = (window as any).enigTerm;
                    if (t.transfers.status.fileBytes > n) {
                        clearInterval(iv);
                        (document.querySelector('enig-term')!.shadowRoot!.querySelector('[data-act="xf-cancel"]') as HTMLElement).click();
                        ok();
                    } else if (Date.now() - t0 > 30_000) {
                        clearInterval(iv);
                        no(new Error(`never reached ${n} bytes`));
                    }
                }, 1);
            }),
        bytes,
    );
}

/** Upload through the Files panel (X/YModem, or ZModem prepared before the board starts). */
async function panelUpload(page: Page, protocol: string, files: { name: string; data: Buffer }[]) {
    await ui(page, '[data-act="files"]').click();
    await ui(page, '[data-xf="dir"]').selectOption('upload');
    await ui(page, '[data-xf="proto"]').selectOption(protocol);
    await chooseFiles(page, () => ui(page, '[data-act="xf-pick"]').click(), files);
    await ui(page, '[data-act="xf-start"]').click();
}

async function panelDownload(page: Page, protocol: string, name?: string) {
    await ui(page, '[data-act="files"]').click();
    await ui(page, '[data-xf="dir"]').selectOption('download');
    await ui(page, '[data-xf="proto"]').selectOption(protocol);
    if (name) await ui(page, '[data-xf="name"]').fill(name);
    await ui(page, '[data-act="xf-start"]').click();
}

const BATCH = () => [
    { name: 'one.bin', data: Buffer.from(random(3000)) },
    { name: 'all.bin', data: Buffer.from(allBytes(66_000)) },
    { name: 'three.txt', data: enc('three\r\n'.repeat(400)) },
];

// --- ZModem ----------------------------------------------------------------------

for (const [peerLabel, sendCmd, recvCmd, have] of [
    ['lrzsz', 'sz', 'rz', LRZSZ],
    ['sexyz', 'sexyz sz', 'sexyz rz', !!SEXYZ],
] as const) {
    test(`ZModem download from ${peerLabel} starts by itself; a batch with every byte value arrives byte-identical`, async ({ page }) => {
        test.skip(!have, `${peerLabel} not installed`);
        const dl = downloads(page);
        const id = await board(page, { peer: sendCmd, set: 'batch' });
        const st = await finished(page);
        expect(st.phase, JSON.stringify(st)).toBe('done');
        const src = await srcFiles(page, id);
        await expect.poll(() => dl.length).toBe(src.length);
        for (const s of src) {
            const d = dl.find(x => x.suggestedFilename() === s.name);
            expect(d, s.name).toBeTruthy();
            expect(sha(await savedBytes(d!))).toBe(s.sha);
        }
        await usableAfter(page, id);
    });

    test(`ZModem upload to ${peerLabel}: the board's receiver asks for files; several arrive byte-identical`, async ({ page }) => {
        test.skip(!have, `${peerLabel} not installed`);
        const id = await board(page, { peer: recvCmd });
        await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('offer');
        const files = BATCH();
        await chooseFiles(page, () => ui(page, '[data-act="xf-offer-files"]').click(), files);
        const st = await finished(page);
        expect(st.phase, JSON.stringify(st)).toBe('done');
        const got = await gotFiles(page, id);
        expect(got.exit).toBe('exit 0');
        expect(got.files.map(f => f.name).sort()).toEqual(files.map(f => f.name).sort());
        for (const f of files) expect(got.files.find(g => g.name === f.name)?.sha).toBe(sha(f.data));
        await usableAfter(page, id);
    });
}

test('ZModem: a 10 MB download (lrzsz)', async ({ page }) => {
    test.skip(!LRZSZ, 'lrzsz not installed');
    test.setTimeout(180_000);
    const dl = downloads(page);
    const id = await board(page, { peer: 'sz', set: 'big' });
    expect((await finished(page, 150_000)).phase).toBe('done');
    const [src] = await srcFiles(page, id);
    await expect.poll(() => dl.length).toBe(1);
    expect(sha(await savedBytes(dl[0]))).toBe(src.sha);
});

test('ZModem upload prepared in the Files panel starts when the board does (10 MB)', async ({ page }) => {
    test.skip(!LRZSZ, 'lrzsz not installed');
    test.setTimeout(180_000);
    await open(page);
    const id = `xfer-armed-${Date.now()}`;
    await page.evaluate(u => (window as any).enigTerm.connect(u), fakeUrl(page, 'xfer&peer=rz', id));
    await waitState(page, 'connected');
    const big = { name: 'big-up.bin', data: Buffer.from(random(10 << 20)) };
    await panelUpload(page, 'zmodem', [big]);
    expect(await phase(page)).toBe('armed');
    await page.evaluate(() => (window as any).enigTerm.input.focus());
    await page.keyboard.type('g');
    const st = await finished(page, 150_000);
    expect(st.phase, JSON.stringify(st)).toBe('done');
    const got = await gotFiles(page, id);
    expect(got.files).toEqual([{ name: 'big-up.bin', size: big.data.length, sha: sha(big.data) }]);
});

test('a file name from the board cannot spoof: format characters go, and the card isolates the name', async ({ page }) => {
    const dl = downloads(page);
    await open(page);
    await page.evaluate(() => (window as any).enigTerm.set('zmodemDetect', 'auto'));
    const z = craftedZmodem([{ name: 'Invoice_\u202efdp.exe', announce: '5', total: 5 }]).flatMap(c => [...c]);
    await page.evaluate(b => (window as any).enigTerm.transfers.incoming(new Uint8Array(b)), z);
    expect((await finished(page, 15_000)).phase).toBe('done');
    await expect.poll(() => dl.length).toBe(1);
    expect(dl[0].suggestedFilename()).toBe('Invoice_fdp.exe');
    await expect(ui(page, '[data-xf-list] bdi')).toHaveText(['Invoice_fdp.exe']);
});

test('ZModem download, "ask first" (the default): the offer waits for Receive', async ({ page }) => {
    test.skip(!LRZSZ, 'lrzsz not installed');
    const dl = downloads(page);
    const id = await board(page, { peer: 'sz', set: 'small' }, '', null);
    await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('offer');
    await ui(page, '[data-act="xf-offer-accept"]').click();
    expect((await finished(page)).phase).toBe('done');
    const [src] = await srcFiles(page, id);
    await expect.poll(() => dl.length).toBe(1);
    expect(sha(await savedBytes(dl[0]))).toBe(src.sha);
});

test('ZModem: refusing the offer, cancelling mid-file, and a board that aborts all hand the terminal back', async ({ page }) => {
    test.skip(!LRZSZ, 'lrzsz not installed');
    test.setTimeout(120_000);
    // refuse an upload offer
    let id = await board(page, { peer: 'rz' });
    await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('offer');
    await ui(page, '[data-act="xf-cancel"]').click();
    expect((await status(page)).error).toBe('refused');
    let got = await gotFiles(page, id);
    expect(got.exit).not.toBe('exit 0');
    await usableAfter(page, id);
    // cancel a download mid-file (the card's Cancel, pressed from inside the page: a fast
    // browser finishes 10 MB before a test runner's click would arrive)
    id = await board(page, { peer: 'sz', set: 'big' });
    await cancelAt(page, 500_000);
    expect((await finished(page)).phase).toBe('cancelled');
    got = await gotFiles(page, id);
    expect(got.exit).not.toBe('exit 0');
    await usableAfter(page, id);
    // the board's program is killed mid-file
    id = await board(page, { peer: 'sz', set: 'big', kill: '2000000' });
    const st = await finished(page);
    expect(st.phase).toBe('failed');
    await usableAfter(page, id);
});

// --- YModem and XModem (sexyz, as ENiGMA offers them) --------------------------------

test('YModem download from sexyz sY (batch), started from the Files panel', async ({ page }) => {
    test.skip(!SEXYZ, 'sexyz not installed');
    const dl = downloads(page);
    const id = await board(page, { peer: 'sexyz sY', set: 'batch' });
    await panelDownload(page, 'ymodem');
    const st = await finished(page);
    expect(st.phase, JSON.stringify(st)).toBe('done');
    const src = await srcFiles(page, id);
    await expect.poll(() => dl.length).toBe(src.length);
    for (const s of src) expect(sha(await savedBytes(dl.find(x => x.suggestedFilename() === s.name)!))).toBe(s.sha);
    await usableAfter(page, id);
});

test('YModem upload to sexyz ry (batch): ends with the null block, sexyz exits 0', async ({ page }) => {
    test.skip(!SEXYZ, 'sexyz not installed');
    const id = await board(page, { peer: 'sexyz ry' });
    const files = BATCH();
    await panelUpload(page, 'ymodem', files);
    const st = await finished(page);
    expect(st.phase, JSON.stringify(st)).toBe('done');
    const got = await gotFiles(page, id);
    expect(got.exit).toBe('exit 0');
    for (const f of files) expect(got.files.find(g => g.name === f.name)?.sha).toBe(sha(f.data));
    await usableAfter(page, id);
});

test('XModem download from sexyz sX (1K) and upload to sexyz rC, every byte value', async ({ page }) => {
    test.skip(!SEXYZ, 'sexyz not installed');
    const dl = downloads(page);
    let id = await board(page, { peer: 'sexyz sX', set: 'allbytes' });
    await panelDownload(page, 'xmodem', 'all.bin');
    expect((await finished(page)).phase).toBe('done');
    await expect.poll(() => dl.length).toBe(1);
    expect(dl[0].suggestedFilename()).toBe('all.bin');
    // XModem pads the last block with SUB (0x1A): the file is a multiple of 128 bytes.
    expect(sha(await savedBytes(dl[0]))).toBe(sha(pad128(Buffer.from(allBytes(70_000)))));
    await usableAfter(page, id);
    id = await board(page, { peer: 'sexyz rC', name: 'up.bin' });
    const data = Buffer.from(allBytes(128 * 300));
    await panelUpload(page, 'xmodem', [{ name: 'up.bin', data }]);
    expect((await finished(page)).phase).toBe('done');
    const got = await gotFiles(page, id);
    expect(got.files).toEqual([{ name: 'up.bin', size: data.length, sha: sha(data) }]);
    await usableAfter(page, id);
});

test('YModem: cancel mid-file (sexyz sY) sends CANs; sexyz fails and the terminal is usable', async ({ page }) => {
    test.skip(!SEXYZ, 'sexyz not installed');
    const id = await board(page, { peer: 'sexyz sY', set: 'big' });
    await panelDownload(page, 'ymodem');
    // (Stop-and-wait: slow where a WebSocket round trip is slow, e.g. Playwright's Chromium here.)
    await cancelAt(page, 20_000);
    expect((await finished(page)).phase).toBe('cancelled');
    const got = await gotFiles(page, id);
    expect(got.exit).not.toBe('exit 0');
    await usableAfter(page, id);
});

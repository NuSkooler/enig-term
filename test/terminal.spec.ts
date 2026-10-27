// Connection: Telnet negotiation and replies against the fake BBS
// (test/fake-bbs.mjs), connection states, reconnect, wss-only, NAWS on
// resize, config.json and its locks, panic recovery.
import { test, expect } from '@playwright/test';
import { open, fakeLog, fakeUrl, waitState, rowText, write, pkgVersion, CSI, shot } from './helpers';

test('negotiation and connect probes against an ENiGMA-like host', async ({ page }, ti) => {
    const id = `probe-${ti.project.name}-${Date.now()}-${ti.repeatEachIndex}`;
    await open(page);
    await page.evaluate(u => (window as any).enigTerm.connect(u), fakeUrl(page, 'probe', id));
    await waitState(page, 'connected');
    await expect.poll(async () => (await fakeLog(page, id))[0]?.sent.length ?? 0).toBeGreaterThan(40);
    const [conn] = await fakeLog(page, id);
    // WILL/WONT/DO/DONT as the server saw them: options 1 ECHO, 3 SGA, 0 BINARY, 24 TTYPE, 31 NAWS, 39 NEW-ENVIRON.
    expect(conn.events).toEqual(expect.arrayContaining(['WONT 1', 'DO 1', 'DO 3', 'WILL 3', 'WILL 0', 'DO 0', 'WILL 24', 'WILL 31', 'WONT 39', 'NAWS 80x25', 'TTYPE ansi-bbs']));
    const text = String.fromCharCode(...conn.sent);
    const v = pkgVersion().split('.').join(';');
    expect(text).toBe(`${CSI}=101;110;105;103;45;116;101;114;109;${v}c${CSI}<0;1;2;3;5c${CSI}1;1R${CSI}0n${CSI}=6;1n${CSI}25;80R`);
    await expect.poll(() => rowText(page, 0)).toBe('fake-bbs script=probe');

    // NAWS goes out on every resize.
    await page.evaluate(() => (window as any).enigTerm.resize(100, 31));
    await page.evaluate(() => (window as any).enigTerm.resize(80, 25));
    await expect.poll(async () => (await fakeLog(page, id))[0].events.filter(e => e.startsWith('NAWS'))).toEqual(['NAWS 80x25', 'NAWS 100x31', 'NAWS 80x25']);
    // The UI shows the state.
    await expect(page.locator('enig-term').locator('[data-status]')).toHaveText('Connected');
    await expect(page.locator('enig-term').locator('[data-act="connect"]')).toHaveText('Disconnect');
    await page.evaluate(() => (window as any).enigTerm.disconnect());
    await waitState(page, 'closed');
    await expect(page.locator('enig-term').locator('[data-status]')).toHaveText('Disconnected');
    await expect(page.locator('enig-term').locator('[data-act="connect"]')).toHaveText('Reconnect');
});

test('host input dials; URL ?endpoint=&connect=1 asks first; the button reconnects', async ({ page }, ti) => {
    const id = `dial-${ti.project.name}-${Date.now()}-${ti.repeatEachIndex}`;
    await open(page, `&endpoint=${encodeURIComponent('ws://127.0.0.1:' + new URL(page.url() || 'http://127.0.0.1:8090').port)}`);
    const host = page.locator('enig-term').locator('[data-host]');
    await host.fill(fakeUrl(page, 'echo', id));
    await host.press('Enter');
    await waitState(page, 'connected');
    await page.keyboard.type('hi');
    // The typed bytes may come before or between our answers to the host's
    // probes and to the CTDA requests the echo host bounces back (below).
    const typed = async () => String.fromCharCode(...((await fakeLog(page, id))[0]?.sent ?? [])).split('\x1b[<0;1;2;3;5c').join('');
    await expect.poll(async () => (await typed()).includes('hi')).toBe(true);
    // The echo host bounces our CTDA answer back, which parses as a new CTDA
    // request: the answer-loop guard must stop that.
    const ctda = String.fromCharCode(...(await fakeLog(page, id))[0].sent).split('[<0;1;2;3;5c').length - 1;
    expect(ctda).toBeLessThanOrEqual(10);
    await page.locator('enig-term').locator('[data-act="connect"]').click(); // disconnect
    await waitState(page, 'closed');
    await page.locator('enig-term').locator('[data-act="connect"]').click(); // reconnect
    await waitState(page, 'connected');
    expect((await fakeLog(page, id)).length).toBe(2);

    const page2 = await page.context().newPage();
    const id2 = `url-${ti.project.name}-${Date.now()}-${ti.repeatEachIndex}`;
    await page2.goto(`/?blink=0&endpoint=${encodeURIComponent(fakeUrl(page, 'probe', id2))}&connect=1`);
    await page2.waitForFunction(() => document.body.dataset.ready === '1');
    // An endpoint from the URL never connects by itself: the user is asked,
    // with the host named and Cancel focused.
    const ask = page2.locator('enig-term').locator('[data-connectdialog]');
    await expect(ask).toBeVisible();
    await expect(ask.locator('[data-connecturl]')).toContainText('/fake-bbs?script=probe');
    await expect(ask.locator('[data-act="connect-cancel"]')).toBeFocused();
    await page2.waitForTimeout(300);
    expect(await page2.evaluate(() => (window as any).enigTerm.state)).toBe('idle');
    expect(await fakeLog(page2, id2)).toEqual([]);
    await ask.locator('[data-act="connect-ok"]').click();
    await waitState(page2, 'connected');
    expect(await page2.locator('enig-term').locator('[data-host]').inputValue()).toContain('/fake-bbs');
    await page2.close();
});

test('wss:// only: ws:// to a non-loopback host is refused', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
        const t = (window as any).enigTerm;
        return { ok: t.connect('ws://bbs.example.com:8888'), state: t.state };
    });
    expect(r).toEqual({ ok: false, state: 'error' });
    await expect(page.locator('enig-term').locator('[data-status]')).toHaveText('Error: only secure (wss://) connections are allowed');
});

test('a refused connection shows an error; auto-reconnect retries with backoff', async ({ page }, ti) => {
    await open(page);
    await page.evaluate(() => (window as any).enigTerm.connect('ws://127.0.0.1:59999/nothing-here'));
    await waitState(page, 'error');
    await expect(page.locator('enig-term').locator('[data-status]')).toContainText('could not connect');

    const id = `close-${ti.project.name}-${Date.now()}-${ti.repeatEachIndex}`;
    await page.evaluate(u => {
        const t = (window as any).enigTerm;
        (window as any).states = [];
        t.events.on('state', (e: any) => (window as any).states.push([e.state, e.reconnectInMs ?? null]));
        t.set('autoReconnect', true);
        t.connect(u);
    }, fakeUrl(page, 'close', id));
    // The fake host closes after its greeting; we reconnect (about 1 s, then 2 s).
    await expect.poll(async () => (await fakeLog(page, id)).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    const states = await page.evaluate(() => (window as any).states as [string, number | null][]);
    const delays = states.filter(s => s[0] === 'closed').map(s => s[1]!);
    expect(delays.length).toBeGreaterThanOrEqual(2);
    expect(delays[0]).toBeGreaterThanOrEqual(800);
    expect(delays[1]).toBeGreaterThan(delays[0]);
    await page.evaluate(() => (window as any).enigTerm.disconnect());
    await waitState(page, 'closed');
    const n = (await fakeLog(page, id)).length;
    await page.waitForTimeout(2500);
    expect((await fakeLog(page, id)).length).toBe(n); // user disconnect stops retries
});

test('config.json: values apply, lockEndpoint and lock[] hold against URL and user', async ({ page }) => {
    // The standalone page reads config.json; here a page mounts with an explicit config URL.
    await page.goto(`/fixtures/embed.html?endpoint=wss://evil.example/&crt=1`);
    await page.waitForFunction(() => (window as any).handles?.length === 2);
    const r = await page.evaluate(() => {
        const h = (window as any).handles[1];
        return { endpoint: h.getOption('endpoint'), crt: h.getOption('crt'), title: h.getOption('title'), locked: h.getOption('lockEndpoint') };
    });
    expect(r).toEqual({ endpoint: 'ws://127.0.0.1:1/locked', crt: false, title: 'Locked Board', locked: true });
    const root = page.locator('#locked');
    await expect(root.locator('[data-host]')).toHaveAttribute('readonly', '');
    await root.locator('[data-act="settings"]').click();
    await expect(root.locator('[data-set="crt"]')).toBeDisabled();
    await expect(root.locator('[data-set="aspect"]')).toBeEnabled();
});

test('panic recovery: the engine is replaced, the connection stays up', async ({ page }, ti) => {
    const id = `panic-${ti.project.name}-${Date.now()}-${ti.repeatEachIndex}`;
    // The debug hooks are not URL parameters: a test sets them before the page loads.
    await page.addInitScript(() => ((window as any).__enigTermTestHooks = { debugPanic: true }));
    await open(page, '&debugPanic=1'); // ignored: proves a link cannot turn it on

    await page.evaluate(u => {
        const t = (window as any).enigTerm;
        (window as any).recovered = [];
        t.events.on('recovered', (e: any) => (window as any).recovered.push(e));
        t.connect(u);
    }, fakeUrl(page, 'panic', id));
    await waitState(page, 'connected');
    await expect.poll(() => rowText(page, 1)).toBe('type p to panic');
    const errors: string[] = [];
    page.on('console', m => m.type() === 'error' && errors.push(m.text()));
    await page.keyboard.type('p');
    await expect.poll(() => page.evaluate(() => (window as any).recovered.length)).toBe(1);
    const rec = await page.evaluate(() => (window as any).recovered[0]);
    expect(rec.recovered).toBe(true);
    expect(rec.message).toMatch(/time not implemented/);
    expect(errors.join('\n')).toMatch(/engine trapped/);
    await expect(page.locator('enig-term').locator('[data-toast]')).toContainText('restarted');
    // Output after the panic renders on the new engine; still connected.
    await expect.poll(() => rowText(page, 4)).toBe('after the panic');
    expect(await page.evaluate(() => (window as any).enigTerm.state)).toBe('connected');
    await write(page, `${CSI}1;1Hstill alive`);
    expect(await rowText(page, 0)).toMatch(/^still alive/);
    await shot(page, 'after-panic', ti.project.name);
});

test('settings persist in localStorage; a throwing localStorage does not break the page', async ({ page }) => {
    await open(page);
    const root = page.locator('enig-term');
    await root.locator('[data-act="settings"]').click();
    await root.locator('[data-set="crt"]').check();
    await root.locator('[data-set="scale"]').selectOption('integer');
    expect(await page.evaluate(() => [(window as any).enigTerm.opts.crt, (window as any).enigTerm.opts.scale])).toEqual([true, 'integer']);
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    expect(await page.evaluate(() => [(window as any).enigTerm.opts.crt, (window as any).enigTerm.opts.scale])).toEqual([true, 'integer']);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('enig-term:settings:v1')!))).toEqual({ crt: true, scale: 'integer' });

    const page2 = await page.context().newPage();
    await page2.addInitScript(() => {
        const boom = () => {
            throw new DOMException('blocked', 'SecurityError');
        };
        Storage.prototype.getItem = boom;
        Storage.prototype.setItem = boom;
    });
    await page2.goto('/?blink=0');
    await page2.waitForFunction(() => document.body.dataset.ready === '1');
    const r2 = page2.locator('enig-term');
    await r2.locator('[data-act="settings"]').click();
    await r2.locator('[data-set="crt"]').check();
    expect(await page2.evaluate(() => (window as any).enigTerm.opts.crt)).toBe(true);
    await expect(r2.locator('[data-toast]')).toContainText('could not be saved');
    await page2.close();
});

test('a flood of BELs is one bell (event and flash) per frame', async ({ page }) => {
    await open(page);
    const n = await page.evaluate(async () => {
        const t = (window as any).enigTerm;
        let n = 0;
        t.events.on('bell', () => n++);
        t.write('\x07'.repeat(100_000));
        t.write('\x07'.repeat(100_000));
        for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
        return n;
    });
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(3);
});

test('an OSC title is capped at 256 characters before the event and the page title see it', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async () => {
        const t = (window as any).enigTerm;
        const got: string[] = [];
        t.events.on('title', (e: any) => got.push(e.title));
        t.write(`\x1b]2;${'T'.repeat(5000)}\x07`);
        await new Promise(r => requestAnimationFrame(r));
        return { got: got.map(s => s.length), title: t.title.length, doc: document.title.length };
    });
    expect(r.got).toEqual([256]);
    expect(r.title).toBe(256);
    expect(r.doc).toBeLessThanOrEqual(256 + ' - enig-term'.length);
});

test('full screen toggles (element fullscreen, or the viewport-covering fallback)', async ({ page }) => {
    await open(page);
    const btn = page.locator('enig-term').locator('[data-act="fullscreen"]');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    const fill = await page.evaluate(() => {
        const t = (window as any).enigTerm;
        return t.canvas.getBoundingClientRect().height / window.innerHeight;
    });
    expect(fill).toBeGreaterThan(0.75);
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
});

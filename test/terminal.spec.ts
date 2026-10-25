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
    expect(await rowText(page, 0)).toBe('fake-bbs script=probe');

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

test('host input dials; URL ?endpoint=&connect=1 works; the button reconnects', async ({ page }, ti) => {
    const id = `dial-${ti.project.name}-${Date.now()}-${ti.repeatEachIndex}`;
    await open(page, `&endpoint=${encodeURIComponent('ws://127.0.0.1:' + new URL(page.url() || 'http://127.0.0.1:8090').port)}`);
    const host = page.locator('enig-term').locator('[data-host]');
    await host.fill(fakeUrl(page, 'echo', id));
    await host.press('Enter');
    await waitState(page, 'connected');
    await page.keyboard.type('hi');
    await expect.poll(async () => String.fromCharCode(...((await fakeLog(page, id))[0]?.sent ?? [])).endsWith('hi')).toBe(true);
    await page.locator('enig-term').locator('[data-act="connect"]').click(); // disconnect
    await waitState(page, 'closed');
    await page.locator('enig-term').locator('[data-act="connect"]').click(); // reconnect
    await waitState(page, 'connected');
    expect((await fakeLog(page, id)).length).toBe(2);

    const page2 = await page.context().newPage();
    const id2 = `url-${ti.project.name}-${Date.now()}-${ti.repeatEachIndex}`;
    await page2.goto(`/?blink=0&endpoint=${encodeURIComponent(fakeUrl(page, 'probe', id2))}&connect=1`);
    await page2.waitForFunction(() => document.body.dataset.ready === '1');
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
    await open(page, '&debugPanic=1');
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

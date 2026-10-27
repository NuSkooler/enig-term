import { defineConfig, devices, type Project } from '@playwright/test';
import { webkitLaunch } from './scripts/webkit-deps.mjs';

const PORT = Number(process.env.ENIG_TERM_PORT ?? 8090);

// WebKit needs system libraries some hosts lack. webkitLaunch() finds a
// working way to start it (as installed, through WEBKIT_EXECUTABLE, or through
// the no-root launcher from `npm run setup:webkit`), or says why it cannot.
// Without one the WebKit projects are left out with a loud warning, unless
// ENIG_TERM_REQUIRE_WEBKIT=1 makes that an error.
const wk = webkitLaunch();
if (!wk.ok) {
    const msg = `\n*** enig-term: SKIPPING WebKit tests: ${wk.reason}\n`;
    if (process.env.ENIG_TERM_REQUIRE_WEBKIT === '1') throw new Error(msg);
    console.warn(msg);
}
const wkLaunch = wk.ok && wk.executablePath ? { executablePath: wk.executablePath } : {};

const DESKTOP = { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 };
const desktopSpecs = /(render|input|terminal|scrollback|embed|links|fonts|live|bench|audio|audio-interop|transfer|transfer-live)\.spec\.ts/;
const mobileSpecs = /mobile\.spec\.ts/;

const projects: Project[] = [
    { name: 'chromium', testMatch: desktopSpecs, use: { ...devices['Desktop Chrome'], ...DESKTOP } },
    { name: 'firefox', testMatch: desktopSpecs, use: { ...devices['Desktop Firefox'], ...DESKTOP } },
    { name: 'chromium-pixel7', testMatch: mobileSpecs, use: { ...devices['Pixel 7'] } },
];
if (wk.ok) {
    projects.splice(1, 0, { name: 'webkit', testMatch: desktopSpecs, use: { ...devices['Desktop Safari'], ...DESKTOP, launchOptions: wkLaunch } });
    projects.push({ name: 'webkit-iphone', testMatch: mobileSpecs, use: { ...devices['iPhone 14'], launchOptions: wkLaunch } });
}

export default defineConfig({
    testDir: 'test',
    // CI has no sound output; the audio specs run locally (and by ear).
    testIgnore: process.env.ENIG_TERM_SKIP_AUDIO ? /audio(-interop)?\.spec\.ts/ : undefined,
    timeout: 60_000,
    // One retry on CI: a slow runner shows timing flakes (reported as flaky) without failing the run.
    retries: process.env.CI ? 1 : 0,
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    use: { baseURL: `http://127.0.0.1:${PORT}/` },
    webServer: {
        command: `node scripts/serve.mjs ${PORT}`,
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: true,
    },
    projects,
});

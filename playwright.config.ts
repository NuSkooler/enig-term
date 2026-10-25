import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.ENIG_TERM_PORT ?? 8090);

export default defineConfig({
    testDir: 'test',
    testMatch: /.*\.spec\.ts/,
    timeout: 60_000,
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    use: {
        baseURL: `http://127.0.0.1:${PORT}/`,
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 1,
    },
    webServer: {
        command: `node scripts/serve.mjs ${PORT}`,
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: true,
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 } },
        {
            name: 'webkit',
            use: {
                ...devices['Desktop Safari'],
                viewport: { width: 1280, height: 900 },
                deviceScaleFactor: 1,
                // Hosts missing WebKit's system libraries can point this at a
                // launcher that supplies them (see SPIKE.md).
                launchOptions: process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {},
            },
        },
        { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 } },
    ],
});

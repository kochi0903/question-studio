import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  use: { baseURL: 'http://127.0.0.1:4188', channel: 'msedge', headless: true, permissions: ['clipboard-read', 'clipboard-write'] },
  webServer: { command: 'node server/index.js', env: { PORT: '4188' }, url: 'http://127.0.0.1:4188/api/health', reuseExistingServer: false },
  reporter: 'list',
  outputDir: 'work/browser-results',
});

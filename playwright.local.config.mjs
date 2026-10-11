import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './tests/browser', testMatch: '*.spec.mjs',
  timeout: 20000, expect: { timeout: 5000 }, workers: 1, retries: 0,
  outputDir: 'test-results/local-browser',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/local-browser', open: 'never' }]],
});

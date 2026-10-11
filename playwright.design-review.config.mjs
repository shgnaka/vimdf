import { defineConfig } from 'playwright/test';
import base from './playwright.local.config.mjs';

// Capture the production extension for visual review, separately from the
// regression suite. These images are evidence, not approved golden images.
export default defineConfig({ ...base, testMatch: '*.design-review.mjs',
  timeout: 45000, outputDir: 'test-results/design-review', reporter: [['list']],
});

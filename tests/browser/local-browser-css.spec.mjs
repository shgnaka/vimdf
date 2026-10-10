import { test, expect, filter, openLesson, pdfIdentity } from './extension-fixture.mjs';
import { lessonPdf } from '../helpers/pdf-bytes.mjs';
import { createServer } from 'node:http';

test.use({ actionTimeout: 5000 });

const key = 'vimdf.customCss.v1';
const screen = page => page.getByTestId('local-browser');
const cssInput = page => page.locator('#customCss');
const status = page => page.locator('#customCssStatus');
const style = page => page.locator('style[data-vimdf-custom-css]');
const browserHelp = page => page.getByRole('dialog', { name: 'Local PDF browser keybindings', exact: true });
const viewerHelp = page => page.getByRole('dialog', { name: 'PDF viewer keybindings', exact: true });
const testCss = `.vimdf-ui { --vimdf-bg: #101112; --vimdf-fg: #e1e2e3; --vimdf-accent: #314159; }
.vimdf-browser { --vimdf-selection-bg: #123456; --vimdf-selection-fg: #fedcba; --vimdf-status-bg: #223344; }
.vimdf-viewer { --vimdf-status-bg: #445566; --vimdf-status-fg: #abcdef; }
.vimdf-help { border-top: 7px solid #010203; }`;
async function ready(page) { await expect(screen(page)).toHaveAttribute('data-busy', 'false'); }
async function save(options, css) {
  await cssInput(options).fill(css); await options.locator('#saveCustomCss').click();
  await expect(status(options)).toContainText(/saved/i);
}
async function stored(extension) {
  return extension.setupPage.evaluate(async key => (await chrome.storage.local.get(key))[key], key);
}
async function setCss(extension, css) {
  await extension.setupPage.evaluate(({ key, css }) => chrome.storage.local.set({ [key]: { version: 1, css } }), { key, css });
}
async function ordinaryViewer(extension) {
  // The real Viewer fetches through the extension service worker, which a
  // page.route cannot intercept. Use the same real HTTP boundary as PDF-05.
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/pdf' }); response.end(lessonPdf());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); server.unref();
  const page = await extension.context.newPage();
  page.once('close', () => { server.close(); server.closeAllConnections(); });
  try {
    const source = `http://127.0.0.1:${server.address().port}/lesson.pdf`;
    await page.goto(`${extension.url('src/viewer/viewer.html')}?file=${encodeURIComponent(source)}`);
    await expect(page.locator('#viewer .page')).toHaveCount(2); return page;
  } catch (error) { await page.close(); throw error; }
}
async function listState(page) {
  return page.evaluate(() => ({ location: document.querySelector('[data-testid="browser-location"]').textContent,
    query: document.querySelector('[data-testid="browser-filter"]').value,
    selected: document.querySelector('#files [aria-selected="true"]')?.getAttribute('aria-label') }));
}
async function otherData(extension) {
  return extension.setupPage.evaluate(async key => {
    const local = await chrome.storage.local.get(null); delete local[key];
    return { local, sync: await chrome.storage.sync.get(null) };
  }, key);
}

test('[UX-10/UX-11] common and page CSS override existing colors without !important on list, both viewers and help', async ({ extension }) => {
  await extension.seed();
  await extension.setupPage.evaluate(() => chrome.storage.sync.set({ theme: 'dark', accentColor: '#ff0000', statusBarBg: '#ffffff' }));
  const browser = await extension.openBrowser(); await ready(browser);
  const viewer = await ordinaryViewer(extension);
  await save(extension.setupPage, testCss);
  const selected = browser.locator('.vimdf-browser .vimdf-row[aria-selected="true"]');
  await expect(selected).toHaveCSS('background-color', 'rgb(18, 52, 86)');
  await expect(selected).toHaveCSS('color', 'rgb(254, 220, 186)');
  await expect(browser.locator('#files .vimdf-statusline')).toHaveCSS('background-color', 'rgb(34, 51, 68)');
  await browser.keyboard.press('?'); await expect(browserHelp(browser)).toBeVisible();
  await expect(browserHelp(browser)).toHaveCSS('border-top-color', 'rgb(1, 2, 3)');
  await expect(browserHelp(browser)).toHaveCSS('background-color', 'rgb(16, 17, 18)');
  await browser.keyboard.press('Escape'); await openLesson(browser);
  for (const page of [browser, viewer]) {
    await expect(page.locator('.vimdf-viewer .vimdf-statusline')).toHaveCSS('background-color', 'rgb(68, 85, 102)');
    await expect(page.locator('.vimdf-viewer .vimdf-statusline')).toHaveCSS('color', 'rgb(171, 205, 239)');
    await page.keyboard.press('?'); await expect(viewerHelp(page)).toBeVisible();
    await expect(viewerHelp(page)).toHaveCSS('border-top-width', '7px');
    await page.keyboard.press('Escape');
  }
  // A later general-settings change must not overwrite saved user CSS.
  await extension.setupPage.evaluate(() => chrome.storage.sync.set({ statusBarBg: '#ffff00', accentColor: '#00ff00' }));
  await expect(viewer.locator('.vimdf-viewer .vimdf-statusline')).toHaveCSS('background-color', 'rgb(68, 85, 102)');
});

test('[UX-10] viewer-only CSS does not change browser colors, and browser-only CSS does not change a Viewer', async ({ extension }) => {
  await extension.seed(); const browser = await extension.openBrowser(); await ready(browser);
  const viewer = await ordinaryViewer(extension);
  const browserBar = browser.locator('#files .vimdf-statusline'); const viewerBar = viewer.locator('.vimdf-viewer .vimdf-statusline');
  const originalBrowser = await browserBar.evaluate(el => getComputedStyle(el).backgroundColor);
  await setCss(extension, '.vimdf-viewer { --vimdf-status-bg: #010203; }');
  await expect(viewerBar).toHaveCSS('background-color', 'rgb(1, 2, 3)');
  await expect(browserBar).toHaveCSS('background-color', originalBrowser);
  await setCss(extension, '.vimdf-browser { --vimdf-status-bg: #040506; }');
  await expect(browserBar).toHaveCSS('background-color', 'rgb(4, 5, 6)');
  await expect(viewerBar).not.toHaveCSS('background-color', 'rgb(4, 5, 6)');
});

for (const variable of ['bg', 'fg', 'muted-fg', 'accent', 'selection-bg', 'selection-fg', 'focus', 'status-bg', 'status-fg']) {
  test(`[UX-10] --vimdf-${variable} is public and can be overridden by a scoped rule`, async ({ extension }) => {
    await extension.seed(); const page = await extension.openBrowser(); await ready(page);
    await setCss(extension, `.vimdf-browser { --vimdf-${variable}: rgb(12, 34, 56); }`);
    const root = page.locator('.vimdf-browser:visible').first();
    await expect.poll(() => root.evaluate((el, name) => getComputedStyle(el).getPropertyValue(name).trim(), `--vimdf-${variable}`)).toBe('rgb(12, 34, 56)');
  });
}

test('[UX-11] CSS draft applies only after save, uses local rather than sync, and reload restores it', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await ready(page);
  const longCss = `${testCss}\n/* ${'length-test-'.repeat(900)} */`;
  expect(Buffer.byteLength(longCss)).toBeGreaterThan(8192);
  await cssInput(extension.setupPage).fill(longCss);
  expect(await stored(extension)).toBeUndefined();
  expect(await style(page).allTextContents()).not.toContain(longCss);
  await extension.setupPage.locator('#saveCustomCss').click(); await expect(status(extension.setupPage)).toContainText(/saved/i);
  expect(await stored(extension)).toEqual({ version: 1, css: longCss });
  expect(await extension.setupPage.evaluate(async key => (await chrome.storage.sync.get(key))[key], key)).toBeUndefined();
  await expect(style(page)).toHaveText(longCss); await page.reload();
  await expect(style(page)).toHaveText(longCss); await extension.setupPage.reload();
  await expect(cssInput(extension.setupPage)).toHaveValue(longCss);
});

test('[UX-11] live CSS keeps filter input, focus, selection, help and PDF page intact', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await ready(page);
  await page.keyboard.press('/'); await page.getByTestId('browser-filter').fill('course');
  const before = await listState(page);
  await setCss(extension, testCss); await expect(style(page)).toHaveText(testCss);
  expect(await listState(page)).toEqual(before); await expect(page.getByTestId('browser-filter')).toBeFocused();
  await page.keyboard.press('Enter'); await page.keyboard.press('?');
  const focused = await page.evaluate(() => document.activeElement.id);
  await setCss(extension, `${testCss}\n.vimdf-help { border-top-width: 9px; }`);
  await expect(browserHelp(page)).toHaveCSS('border-top-width', '9px');
  expect(await page.evaluate(() => document.activeElement.id)).toBe(focused);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await openLesson(page);
  await page.keyboard.press('2'); await page.keyboard.press('G');
  await expect(page.locator('#statusLeft')).toContainText('Page 2 / 2');
  await page.keyboard.press('/'); await page.locator('#searchInput').fill('query-with-no-PDF-match');
  const pdfFocus = await page.evaluate(() => document.activeElement.id);
  await setCss(extension, testCss); await expect(style(page)).toHaveText(testCss);
  await expect(page.locator('#searchInput')).toHaveValue('query-with-no-PDF-match');
  expect(await page.evaluate(() => document.activeElement.id)).toBe(pdfFocus);
  await expect(page.locator('#statusLeft')).toContainText('Page 2 / 2');
});

test('[UX-11] failed save retains draft and last saved styles, reports unsaved, and can retry', async ({ extension }) => {
  await extension.seed(); await setCss(extension, testCss);
  const page = await extension.openBrowser(); await ready(page); await extension.setupPage.reload();
  const draft = '.vimdf-browser { --vimdf-bg: #aabbcc; }';
  await extension.setupPage.evaluate(key => {
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    window.__restoreCssSave = () => { chrome.storage.local.set = set; };
    chrome.storage.local.set = items => key in items
      ? Promise.reject(new Error('quota failure')) : set(items);
  }, key);
  await cssInput(extension.setupPage).fill(draft); await extension.setupPage.locator('#saveCustomCss').click();
  await expect(status(extension.setupPage)).toContainText(/could not|failed|unsaved|unable/i);
  await expect(cssInput(extension.setupPage)).toHaveValue(draft);
  expect(await stored(extension)).toEqual({ version: 1, css: testCss }); await expect(style(page)).toHaveText(testCss);
  await extension.setupPage.evaluate(() => window.__restoreCssSave()); await save(extension.setupPage, draft);
  await expect(style(page)).toHaveText(draft);
});

test('[UX-11] failed CSS read leaves built-in UI usable and never overwrites stored CSS', async ({ extension }) => {
  await extension.seed(); await setCss(extension, testCss);
  await extension.context.addInitScript(key => {
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = keys => keys === key || (Array.isArray(keys) && keys.includes(key)) || (keys && typeof keys === 'object' && key in keys)
      ? Promise.reject(new Error('CSS storage unavailable')) : get(keys);
  }, key);
  const page = await extension.openBrowser(); await ready(page);
  expect(await style(page).allTextContents()).not.toContain(testCss);
  await page.keyboard.press('j'); await expect(page.locator('#files [aria-selected="true"]')).toHaveCount(1);
  expect(await stored(extension)).toEqual({ version: 1, css: testCss });
});

test('[UX-11] invalid CSS is ignored per declaration and style text never becomes HTML', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await ready(page);
  const css = `/* </style><img id="css-injection" src=x onerror="window.__cssInjected=true"> */
.vimdf-browser { color: this-is-not-a-color; --vimdf-selection-bg: #123456; }`;
  await save(extension.setupPage, css); await expect(style(page)).toHaveText(css);
  await expect(page.locator('.vimdf-row[aria-selected="true"]')).toHaveCSS('background-color', 'rgb(18, 52, 86)');
  await expect(page.locator('#css-injection')).toHaveCount(0);
  expect(await page.evaluate(() => window.__cssInjected)).toBeUndefined();
});

for (const operation of ['save empty', 'reset']) {
  test(`[UX-11/UX-12] ${operation} affects only CSS, preserving settings, folder registry and PDF data`, async ({ extension }) => {
    await extension.seed();
    await extension.setupPage.evaluate(async identity => {
      await chrome.storage.sync.set({ theme: 'dark', scrollStep: 113 });
      await chrome.storage.local.set({
        [`vimdf:state:${identity}`]: { page: 2, scrollTop: 42 },
        [`vimdf:marks:${identity}`]: { a: { page: 2, x: 0, y: 100 } },
        [`vimdf:highlights:${identity}`]: [{ id: 'fixture-highlight', color: '#ff0000', page: 1, rects: [] }],
        'vimdf.passwords.v1': { version: 1, autoFill: true, records: [
          { id: 'fixture', name: 'Fixture', password: 'fixture-only', enabled: true, shared: false },
        ], remembered: { [identity]: 'fixture' } },
        'vimdf.localBrowser.launcher.v1': { version: 1, enabled: false, allowedIds: [] },
      });
    }, pdfIdentity);
    const page = await extension.openBrowser(); await ready(page);
    const row = page.locator('#files [aria-selected="true"]'); const builtIn = await row.evaluate(el => getComputedStyle(el).backgroundColor);
    const before = await otherData(extension); const registry = await extension.registry();
    await save(extension.setupPage, testCss);
    await expect(row).toHaveCSS('background-color', 'rgb(18, 52, 86)');
    if (operation === 'save empty') await save(extension.setupPage, '');
    else { await extension.setupPage.locator('#resetCustomCss').click(); await expect(status(extension.setupPage)).toContainText(/reset|restored|saved/i); }
    expect(await stored(extension)).toEqual({ version: 1, css: '' });
    await expect(row).toHaveCSS('background-color', builtIn);
    expect(await otherData(extension)).toEqual(before); expect(await extension.registry()).toEqual(registry);
  });
}

test('[UX-12] unreadable app CSS cannot style Options or prevent CSS recovery there', async ({ extension }) => {
  await extension.seed(); const options = extension.setupPage;
  const before = await options.locator('body').evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
  await save(options, '.vimdf-ui { color: transparent; background: transparent; pointer-events: none; } body { opacity: 0; }');
  const page = await extension.openBrowser(); await ready(page); await expect(style(page)).toHaveCount(1);
  await options.reload(); await expect(cssInput(options)).toBeVisible(); await expect(options.locator('#resetCustomCss')).toBeEnabled();
  await expect(style(options)).toHaveCount(0); await expect(options.locator('body')).toHaveCSS('opacity', '1');
  expect(await options.locator('body').evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }))).toEqual(before);
  await options.locator('#resetCustomCss').click(); await expect(status(options)).toContainText(/reset|restored|saved/i);
  await expect(page.locator('body')).toHaveCSS('opacity', '1');
});

test('[UX-12/UX-09] repeated CSS updates and mode changes reuse one style and storage subscription', async ({ extension }) => {
  await extension.context.addInitScript(() => {
    const event = chrome.storage.onChanged; const add = event.addListener.bind(event), remove = event.removeListener.bind(event);
    window.__storageSubscriptions = new Set();
    event.addListener = listener => { window.__storageSubscriptions.add(listener); return add(listener); };
    event.removeListener = listener => { window.__storageSubscriptions.delete(listener); return remove(listener); };
  });
  await extension.seed(); const page = await extension.openBrowser(); await ready(page);
  const subscriptions = await page.evaluate(() => window.__storageSubscriptions.size);
  for (let i = 0; i < 4; i++) {
    const css = `${testCss}\n/* update ${i} */`; await setCss(extension, css); await expect(style(page)).toHaveText(css);
    await expect(style(page)).toHaveCount(1); await openLesson(page); await page.keyboard.press('H'); await ready(page);
    await page.keyboard.press('Escape'); await page.keyboard.press('h'); await ready(page);
    await expect(page.getByTestId('browser-location')).toContainText('University');
  }
  expect(await page.evaluate(() => window.__storageSubscriptions.size)).toBe(subscriptions);
  const before = await page.locator('#files [role="option"]').evaluateAll(rows => rows.findIndex(el => el.getAttribute('aria-selected') === 'true'));
  await page.keyboard.press('j');
  const after = await page.locator('#files [role="option"]').evaluateAll(rows => rows.findIndex(el => el.getAttribute('aria-selected') === 'true'));
  expect(after).toBe(before + 1);
  await page.keyboard.press('?'); await expect(browserHelp(page)).toBeVisible(); await expect(page.locator('.vimdf-help:visible')).toHaveCount(1);
  await page.keyboard.press('?'); await expect(browserHelp(page)).toBeHidden();
});

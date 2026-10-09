import { test, expect, filter, openLesson, rootA, rootB, pdfIdentity } from './extension-fixture.mjs';

test('[UI-02/UI-05] initial screen does not prompt; native button Enter invokes one active picker', async ({ extension }) => {
  const page = await extension.openBrowser();
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-view', 'empty');
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
  await page.locator('[data-action="add"]').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-view', 'browse');
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([{ options: { mode: 'read' }, active: true }]);
  expect((await extension.registry()).roots.every(root => root.native)).toBe(true);
});

test('[UI-03] filter letters, key repeats and IME do not navigate or open a file', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser();
  await page.keyboard.press('/'); const input = page.getByTestId('browser-filter');
  await input.fill('jkhgl'); await expect(page.getByRole('option')).toHaveCount(0);
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }));
  });
  await expect(input).toBeFocused(); await expect(page.getByTestId('local-browser')).toHaveAttribute('data-mode', 'files');
  await input.fill(''); await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await page.keyboard.press('Escape'); await expect(page.getByRole('option')).not.toHaveCount(0);
});

test('[UI-04] mouse highlight is separate from saved primary and hostile names are plain text', async ({ extension }) => {
  await extension.seed({ hostile: true }); const page = await extension.openBrowser();
  await expect(page.getByRole('option', { name: '<img src=x onerror=alert(1)>.pdf', exact: true })).toBeVisible();
  expect(await page.getByTestId('local-browser').locator('img[src="x"]').count()).toBe(0);
  await page.keyboard.press('h'); await page.getByRole('option', { name: /Books/ }).click();
  await expect(page.getByRole('option', { name: /Books/ })).toHaveAttribute('aria-selected', 'true');
  expect((await extension.registry()).primaryId).toBe(rootA);
  await page.keyboard.press('Enter'); expect((await extension.registry()).primaryId).toBe(rootB);
});

test('[UI-05] picker cancellation and failure release busy state and allow retry', async ({ extension }) => {
  const page = await extension.openBrowser();
  await page.evaluate(() => { window.__pickerError = 'AbortError'; });
  await page.locator('[data-action="add"]').click();
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-busy', 'false');
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-view', 'empty');
  await page.evaluate(() => { window.__pickerError = 'SecurityError'; });
  await page.locator('[data-action="add"]').click(); await expect(page.getByRole('alert')).toBeVisible();
  await page.evaluate(() => { window.__pickerError = null; }); await page.locator('[data-action="add"]').click();
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-view', 'browse');
});

test('[UI-05] permission query does not prompt; explicit confirmation starts request in the gesture', async ({ extension }) => {
  await extension.seed(); await extension.context.addInitScript(() => { window.__permission = 'prompt'; });
  const page = await extension.openBrowser();
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-view', 'permission');
  expect(await page.evaluate(() => window.__permissionCalls)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-view', 'browse');
  expect(await page.evaluate(() => window.__permissionCalls)).toEqual([{ options: { mode: 'read' }, active: true }]);
});

test('[UI-06/PDF-01] PDF search uses bytes and H restores the exact list state', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); const fetched = [];
  page.on('request', request => { if (request.url().startsWith('https://local-pdf.vimdf.invalid/')) fetched.push(request.url()); });
  await openLesson(page); await page.keyboard.press('/'); await page.locator('#searchInput').fill('needle');
  await page.keyboard.press('Enter'); await expect(page.locator('#searchStatus')).toContainText('2');
  const match = () => page.locator('#viewer .highlight.selected').evaluate(element => element.closest('.page').dataset.pageNumber);
  const before = await match(); await page.keyboard.press('n'); await expect.poll(match).not.toBe(before);
  await page.keyboard.press('N'); await expect.poll(match).toBe(before);
  await page.keyboard.press('H'); await expect(page.getByTestId('local-browser')).toHaveAttribute('data-mode', 'files');
  await expect(page.getByTestId('browser-filter')).toHaveValue('lesson');
  await expect(page.getByTestId('browser-location')).toContainText('course');
  await expect(page.getByRole('option', { name: 'lesson.pdf', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(fetched).toEqual([]);
  await page.reload(); await expect(page.getByRole('option', { name: 'course', exact: true })).toBeVisible();
});

test('[DB-01] native handles survive page reload and retain primary selection and order', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await page.keyboard.press('h');
  await page.getByRole('option', { name: /Books/ }).dblclick();
  await expect.poll(async () => (await extension.registry()).primaryId).toBe(rootB);
  await page.reload(); await expect(page.getByTestId('browser-location')).toContainText('Books');
  const saved = await extension.registry();
  expect(saved.roots.map(root => root.id)).toEqual([rootA, rootB]); expect(saved.roots.every(root => root.native)).toBe(true);
});

test('[DB-05] another tab announces updates without changing the active folder until reload', async ({ extension }) => {
  await extension.seed(); const a = await extension.openBrowser(); const b = await extension.openBrowser();
  await b.keyboard.press('h'); await b.getByRole('option', { name: /Books/ }).dblclick();
  await expect(a.getByTestId('registry-stale')).toBeVisible();
  await expect(a.getByTestId('browser-location')).toContainText('University');
  await a.locator('[data-action="reload-registry"]').click();
  await expect(a.getByTestId('browser-location')).toContainText('Books');
});

test('[PDF-03] password cancellation returns to list and a retry can open the encrypted PDF', async ({ extension }) => {
  const encrypted = await extension.seed(); const page = await extension.openBrowser();
  await filter(page, 'locked'); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'PDF password' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-mode', 'files');
  await expect(page.getByTestId('browser-filter')).toHaveValue('locked');
  await page.keyboard.press('Enter'); await page.getByRole('dialog').locator('input[name="password"]').fill(encrypted.password);
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-mode', 'pdf');
});

test('[PDF-02/PDF-05] local marks use root/path identity and survive list/PDF navigation', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await openLesson(page);
  await page.keyboard.press('2'); await page.keyboard.press('G'); await page.keyboard.press('m'); await page.keyboard.press('a');
  await expect.poll(() => page.evaluate(async identity => (await chrome.storage.local.get(`vimdf:marks:${identity}`))[`vimdf:marks:${identity}`]?.a?.page, pdfIdentity)).toBe(2);
  await page.keyboard.press('H'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-mode', 'pdf');
  await page.keyboard.press('g'); await page.keyboard.press('g'); await page.keyboard.press("'"); await page.keyboard.press('a');
  await expect(page.locator('#statusCenter')).toContainText('2');
});

test('[PDF-04] delayed state storage saves the old snapshot before a different PDF is opened', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await openLesson(page);
  await page.evaluate(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local); let held = false;
    window.__releaseStateRead = null;
    chrome.storage.local.get = async keys => {
      if (!held && typeof keys === 'string' && keys.startsWith('vimdf:state:')) {
        held = true; await new Promise(resolve => { window.__releaseStateRead = resolve; });
      }
      return get(keys);
    };
  });
  await page.keyboard.press('2'); await page.keyboard.press('G');
  await expect.poll(() => page.evaluate(() => Boolean(window.__releaseStateRead))).toBe(true);
  await page.keyboard.press('H');
  await page.evaluate(() => window.__releaseStateRead());
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-mode', 'files');
  await page.locator('[data-action="roots"]').click(); await page.getByRole('option', { name: /Books/ }).dblclick();
  await filter(page, 'lesson'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-mode', 'pdf');
  expect(await page.evaluate(async identity => (await chrome.storage.local.get(`vimdf:state:${identity}`))[`vimdf:state:${identity}`]?.page, pdfIdentity)).toBe(2);
});

test('[UI-02] missing directory API gives a file-picker fallback without a folder success state', async ({ extension }) => {
  await extension.context.addInitScript(() => { Object.defineProperty(window, 'showDirectoryPicker', { value: undefined }); });
  const page = await extension.openBrowser();
  await expect(page.locator('[data-action="pick-file"]')).toBeVisible();
  await expect(page.locator('[data-action="add"]')).toBeDisabled();
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
});

test('[UI-02/DB-06] DB initialization error is visible and cannot masquerade as an empty registry', async ({ extension }) => {
  await extension.context.addInitScript(() => {
    IDBFactory.prototype.open = () => { throw new DOMException('storage unavailable', 'SecurityError'); };
  });
  const page = await extension.openBrowser();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('[data-action="add"]')).toBeDisabled();
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
});

test('[EXT-04] page incognito guard stops before opening the registered-handle DB', async ({ extension }) => {
  await extension.context.addInitScript(() => {
    Object.defineProperty(chrome.extension, 'inIncognitoContext', { value: true });
    const open = IDBFactory.prototype.open; window.__dbOpens = 0;
    IDBFactory.prototype.open = function (...args) { window.__dbOpens++; return open.apply(this, args); };
  });
  const page = await extension.openBrowser();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await page.evaluate(() => window.__dbOpens)).toBe(0);
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
});

test('[EXT-01/EXT-02] real cross-extension messages are rejected until enabled and exact allowed launch opens one tab', async ({ extension }) => {
  expect(await extension.send()).toEqual({ reply: false, error: null });
  await extension.configureLauncher(true, [extension.id]);
  expect(await extension.send()).toEqual({ reply: false, error: null });
  await extension.configureLauncher();
  expect(await extension.send({ type: 'vimdf.openLocalBrowser', version: 1, rootId: rootB })).toEqual({ reply: false, error: null });
  expect(extension.context.pages().filter(page => page.url().endsWith('/src/local-browser/browser.html'))).toHaveLength(0);
  expect(await extension.send()).toEqual({ reply: true, error: null });
  await expect.poll(() => extension.context.pages().filter(page => page.url().endsWith('/src/local-browser/browser.html')).length).toBe(1);
  const page = extension.context.pages().find(page => page.url().endsWith('/src/local-browser/browser.html'));
  await expect(page.getByTestId('local-browser')).toBeVisible();
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
});

test('[EXT-04] external connection settings survive an extension-page reload without re-registering the sender', async ({ extension }) => {
  await extension.configureLauncher(); await extension.setupPage.reload();
  expect(await extension.send()).toEqual({ reply: true, error: null });
  await extension.configureLauncher(false);
  expect(await extension.send()).toEqual({ reply: false, error: null });
  expect(extension.context.pages().filter(page => page.url().endsWith('/src/local-browser/browser.html'))).toHaveLength(1);
});

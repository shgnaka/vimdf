import { test, expect, filter, openLesson } from './extension-fixture.mjs';
import { lessonPdf } from '../helpers/pdf-bytes.mjs';

// These checks exercise the real layout and user-facing outcomes. They do not
// prescribe CSS, a particular scrolling API, or a Figma layout.
for (const view of ['files', 'registered folders']) {
  test(`[UI-04] keyboard selection stays fully visible in a long ${view} list`, async ({ extension }) => {
    await extension.seed({ pdfCount: 48, extraRoots: 30 });
    const page = await extension.openBrowser(); await page.setViewportSize({ width: 960, height: 640 });
    await expect(page.getByTestId('local-browser')).toHaveAttribute('data-busy', 'false');
    if (view === 'registered folders') await page.keyboard.press('h');
    const before = await extension.registry();
    const rows = page.getByRole('option'); const count = await rows.count();
    expect(count).toBeGreaterThan(30);
    const selected = page.locator('[role="option"][aria-selected="true"]');
    async function visible(index) {
      await expect(rows.nth(index)).toHaveAttribute('aria-selected', 'true');
      await expect(selected).toHaveCount(1);
      // IntersectionObserver includes clipping by scrollable ancestors.
      // A nonzero intersection alone would allow most of the row to be hidden.
      await expect(selected).toBeInViewport({ ratio: 0.99 });
    }
    await page.keyboard.press('G'); await visible(count - 1);
    await page.keyboard.press('k'); await visible(count - 2);
    await page.keyboard.press('ArrowUp'); await visible(count - 3);
    await page.keyboard.press('g'); await page.keyboard.press('g'); await visible(0);
    for (let index = 1; index <= 24; index++) {
      await page.keyboard.press(index % 2 ? 'j' : 'ArrowDown'); await visible(index);
    }
    for (let index = 23; index >= 0; index--) {
      await page.keyboard.press(index % 2 ? 'k' : 'ArrowUp'); await visible(index);
    }
    expect(await extension.registry()).toEqual(before);
  });
}

test('[UI-06] discarded PDF history visibly asks for re-selection without fetching an identity', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); const fetched = [];
  page.on('request', request => { if (request.url().startsWith('https://local-pdf.vimdf.invalid/')) fetched.push(request.url()); });
  await openLesson(page); const discarded = await page.evaluate(() => history.state);
  await page.keyboard.press('H');
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-busy', 'false');
  await page.locator('[data-action="roots"]').click(); await page.getByRole('option', { name: /Books/ }).dblclick();
  await filter(page, 'lesson'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-mode', 'pdf');
  expect((await page.evaluate(() => history.state)).token).not.toBe(discarded.token);
  await page.keyboard.press('H');
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-busy', 'false');
  const before = await extension.registry(); const url = page.url();
  // Supply the stale history boundary, without stubbing the controller,
  // popstate handler, Viewer, or the message that the user should see.
  await page.evaluate(state => { history.pushState(state, ''); history.back(); }, discarded);
  await expect.poll(() => page.evaluate(() => history.state?.view)).toBe('files');
  await page.goForward();
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-mode', 'files');
  const notice = page.locator('#browser-message, [role="status"], [role="alert"]')
    .filter({ hasText: /(?:select|choose|open).*PDF.*again|re[- ]?select.*PDF/i });
  await expect(notice.first()).toBeVisible();
  await expect(page.getByTestId('browser-filter')).toHaveValue('lesson');
  await expect(page.getByRole('option', { name: 'lesson.pdf', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(page.url()).toBe(url); expect(await extension.registry()).toEqual(before); expect(fetched).toEqual([]);
});

test('[EXT-01/UI-02] an empty ordinary Viewer opens one regular folder-browser tab without a picker', async ({ extension }) => {
  const page = await extension.context.newPage(); const url = extension.url('src/viewer/viewer.html');
  await page.goto(url); await expect(page.locator('#localFilePanel')).toBeVisible();
  const name = /browse.*folders?|open.*(?:folder|local PDF browser)|registered folders/i;
  const launch = page.getByRole('button', { name }).or(page.getByRole('link', { name }));
  await expect(launch).toHaveCount(1); await expect(launch).toBeVisible();
  const [browser] = await Promise.all([extension.context.waitForEvent('page'), launch.click()]);
  await expect(browser).toHaveURL(extension.url('src/local-browser/browser.html'));
  await expect(browser.getByTestId('local-browser')).toBeVisible();
  expect(await browser.evaluate(() => chrome.extension.inIncognitoContext)).toBe(false);
  expect(await browser.evaluate(() => window.__pickerCalls)).toEqual([]);
  expect(extension.context.pages().filter(tab => tab.url() === extension.url('src/local-browser/browser.html'))).toHaveLength(1);
  expect(page.url()).toBe(url);
});

test('[UI-02] empty-folder and no-search-results messages differ and clearing the filter restores the empty message', async ({ extension }) => {
  await extension.seed({ emptyFolder: true }); const page = await extension.openBrowser();
  await filter(page, 'empty'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-busy', 'false');
  await expect(page.getByTestId('browser-location')).toContainText('empty'); await expect(page.getByRole('option')).toHaveCount(0);
  const message = page.locator('#browser-message');
  await expect(message).toBeVisible();
  const empty = (await message.innerText()).trim(); expect(empty.length).toBeGreaterThan(0);
  await filter(page, 'missing-PDF-name');
  await expect(message).not.toHaveText(empty);
  await expect(message).toContainText(/no (?:matching|results|names match)|nothing matches/i);
  await page.keyboard.press('Escape'); await expect(message).toHaveText(empty);
  await expect(page.getByRole('option')).toHaveCount(0);
});

test('[UI-02] no matching registered-folder names shows no-results instead of asking to confirm a folder', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser();
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-busy', 'false'); await page.keyboard.press('h');
  const message = page.locator('#browser-message'); const instruction = (await message.innerText()).trim();
  await filter(page, 'missing-registered-folder'); await expect(page.getByRole('option')).toHaveCount(0);
  await expect(message).toBeVisible(); await expect(message).not.toHaveText(instruction);
  await expect(message).toContainText(/no (?:matching|results|names match)|nothing matches/i);
  const before = await extension.registry(); await page.keyboard.press('Enter'); expect(await extension.registry()).toEqual(before);
  await page.keyboard.press('Escape'); await expect(page.getByRole('option')).toHaveCount(2);
});

async function withoutFolderApi(extension) {
  await extension.context.addInitScript(() => { Object.defineProperty(window, 'showDirectoryPicker', { value: undefined }); });
  const page = await extension.openBrowser();
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-busy', 'false');
  await expect(page.locator('[data-action="pick-file"]')).toBeVisible();
  return page;
}

test('[UI-02] API-unavailable screen hides folder controls and folder-key guidance', async ({ extension }) => {
  const page = await withoutFolderApi(extension);
  await expect(page.locator('[data-action="add"]')).toBeHidden();
  await expect(page.locator('[data-action="roots"]')).toBeHidden();
  await expect(page.getByTestId('browser-filter')).toBeHidden();
  await expect(page.getByRole('listbox')).toBeHidden();
  for (const key of ['j', 'k', 'h', '/', 'Enter', 'Esc']) await expect(page.locator('#files kbd').filter({ hasText: new RegExp(`^${key === '/' ? '\\/' : key}$`) })).toBeHidden();
  await expect(page.locator('#browser-message').filter({ hasText: /add.*folder/i })).toBeHidden();
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
});

test('[UI-02/UI-03] API-unavailable screen ignores folder shortcuts without creating an error or registration', async ({ extension }) => {
  const page = await withoutFolderApi(extension); const before = await extension.registry();
  for (const key of ['Enter', 'a', '/', 'j', 'k', 'h', 'l']) {
    await page.locator('[data-testid="local-browser"]').focus(); await page.keyboard.press(key);
    await expect(page.getByTestId('local-browser')).toHaveAttribute('data-busy', 'false');
    await expect(page.getByRole('alert')).not.toBeVisible();
  }
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
  expect(await extension.registry()).toEqual(before);
});

test('[UI-02/PDF-01] API-unavailable fallback still opens picked PDF bytes and returns to the fallback screen', async ({ extension }) => {
  const page = await withoutFolderApi(extension); const fetched = [];
  page.on('request', request => { if (request.url().startsWith('https://local-pdf.vimdf.invalid/')) fetched.push(request.url()); });
  await page.locator('#fallback-file').setInputFiles({ name: 'picked.pdf', mimeType: 'application/pdf', buffer: lessonPdf() });
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-mode', 'pdf');
  await expect(page.locator('#viewer .page')).toHaveCount(2);
  await page.keyboard.press('H'); await expect(page.locator('[data-action="pick-file"]')).toBeVisible();
  expect(fetched).toEqual([]); expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
  expect(await extension.registry()).toBeNull();
});

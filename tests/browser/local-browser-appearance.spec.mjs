import { test, expect, filter, openLesson, pdfIdentity, rootB } from './extension-fixture.mjs';

test.use({ actionTimeout: 5000 });

const screen = page => page.getByTestId('local-browser');
const add = page => page.locator('#files [data-action="add"]');
const roots = page => page.locator('#files [data-action="roots"]');
const help = page => page.locator('#browser-help');
async function ready(page) { await expect(screen(page)).toHaveAttribute('data-busy', 'false'); }
async function snapshot(page) {
  return page.evaluate(() => ({
    view: document.querySelector('[data-testid="local-browser"]').dataset.view,
    location: document.querySelector('[data-testid="browser-location"]').textContent,
    query: document.querySelector('[data-testid="browser-filter"]').value,
    selected: document.querySelector('#files [aria-selected="true"]')?.getAttribute('aria-label'),
    focus: document.activeElement.id || document.activeElement.getAttribute('data-testid'),
  }));
}
async function sameSize(page, size = '13px') {
  // Read rendered text and controls in the production DOM, including dynamically
  // generated metadata, modal titles, empty-result messages and input values.
  const typography = await page.locator('#files').evaluate(root => {
    const elements = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.textContent.trim()) elements.add(walker.currentNode.parentElement);
    }
    root.querySelectorAll('input, button, select, textarea').forEach(el => elements.add(el));
    return [...elements].filter(el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible')
      .map(el => ({ text: el.textContent.trim().slice(0, 80) || el.getAttribute('aria-label'),
        size: getComputedStyle(el).fontSize, family: getComputedStyle(el).fontFamily }));
  });
  expect(typography.length).toBeGreaterThan(2);
  expect(typography.filter(text => text.size !== size)).toEqual([]);
  expect(typography.filter(text => !text.family.includes('monospace'))).toEqual([]);
}
async function setCheckbox(extension, id, checked) {
  const options = extension.setupPage;
  await options.locator(`#${id}`).setChecked(checked);
  await expect.poll(async () => (await options.evaluate(() => chrome.storage.sync.get(null)))[id] ?? true).toBe(checked);
}

for (const theme of ['dark', 'light', 'auto']) {
  for (const width of [960, 320]) {
    test(`[UX-14] ${theme}, ${width}px: names, metadata, input, help and confirmation use one monospace size`, async ({ extension }) => {
      await extension.seed({ sameNames: true });
      await extension.setupPage.evaluate(theme => chrome.storage.sync.set({ theme }), theme);
      const page = await extension.openBrowser(); await page.setViewportSize({ width, height: 540 }); await ready(page);
      await sameSize(page);
      await page.keyboard.press('/'); await page.getByTestId('browser-filter').fill('資料'); await sameSize(page);
      await page.keyboard.press('Escape'); await page.keyboard.press('r');
      await expect(screen(page)).toHaveAttribute('data-view', 'roots'); await sameSize(page);
      // Include Default, Remove and the <small> ID used to distinguish equal names.
      await expect(page.locator('.row-name small')).toHaveCount(2);
      await page.keyboard.press('?'); await expect(help(page)).toBeVisible(); await sameSize(page);
      await page.keyboard.press('/'); await help(page).getByRole('textbox').fill('no-such-command'); await sameSize(page);
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Unregister Documents', exact: true }).first().click();
      await expect(page.locator('#remove-root-dialog')).toBeVisible(); await sameSize(page);
    });
  }
}

for (const view of ['empty', 'permission', 'error', 'unsupported']) {
  test(`[UX-14] ${view} explanations, errors and recovery actions keep the same text size`, async ({ extension }) => {
    if (view !== 'empty') await extension.seed();
    if (view === 'permission') await extension.context.addInitScript(() => { window.__permission = 'prompt'; });
    if (view === 'unsupported') await extension.context.addInitScript(() => { delete window.showDirectoryPicker; });
    const page = await extension.openBrowser(); await ready(page);
    if (view === 'error') {
      await page.evaluate(() => { window.__pickerError = 'NotAllowedError'; }); await page.keyboard.press('a');
      await expect(page.locator('#browser-error')).toBeVisible(); await ready(page);
    } else if (view === 'unsupported') await expect(page.locator('#browser-fallback')).toBeVisible();
    else await expect(screen(page)).toHaveAttribute('data-view', view);
    await expect(page.locator(view === 'error' ? '#browser-error' : view === 'unsupported' ? '#browser-fallback' : '#browser-message')).toBeVisible();
    await sameSize(page);
  });
}

test('[UX-14] base font CSS customization scales all browser text while Options and Viewer retain their typography', async ({ extension }) => {
  await extension.seed(); const options = extension.setupPage;
  const optionsSize = await options.locator('h2').first().evaluate(el => getComputedStyle(el).fontSize);
  await options.evaluate(() => chrome.storage.sync.set({ statusBarFontSize: 20 }));
  const page = await extension.openBrowser(); await ready(page);
  await options.locator('#customCss').fill('.vimdf-browser { font-size: 17px; }');
  await options.locator('#saveCustomCss').click();
  await expect(page.locator('#files')).toHaveCSS('font-size', '17px'); await sameSize(page, '17px');
  await page.keyboard.press('?'); await expect(help(page)).toBeVisible(); await sameSize(page, '17px');
  await page.keyboard.press('Escape'); await openLesson(page);
  await expect(page.locator('#statusbar')).toHaveCSS('font-size', '20px');
  await page.keyboard.press('?');
  const viewerHelp = page.getByRole('dialog', { name: 'PDF viewer keybindings', exact: true });
  await expect(viewerHelp).toBeVisible(); await expect(viewerHelp).toHaveCSS('font-size', '13px');
  await expect(options.locator('h2').first()).toHaveCSS('font-size', optionsSize);
});

test('[UX-15] fresh and older settings show both buttons by default, with checked Options controls', async ({ extension }) => {
  const options = extension.setupPage;
  await expect(options.locator('#showAddFolderButton')).toBeChecked();
  await expect(options.locator('#showRegisteredFoldersButton')).toBeChecked();
  // An existing profile without the new keys keeps its other settings.
  await options.evaluate(() => chrome.storage.sync.set({ theme: 'light', scrollStep: 137 }));
  await options.reload();
  await expect(options.locator('#showAddFolderButton')).toBeChecked();
  await expect(options.locator('#showRegisteredFoldersButton')).toBeChecked();
  const page = await extension.openBrowser(); await ready(page);
  await expect(add(page)).toBeVisible(); await expect(roots(page)).toBeVisible();
  await expect(options.locator('#scrollStep')).toHaveValue('137');
  await expect(options.locator('#localBrowserSettings #showAddFolderButton')).toHaveCount(1);
  await expect(options.locator('#localBrowserSettings #showRegisteredFoldersButton')).toHaveCount(1);
});

test('[UX-15] malformed visibility values default to visible and API availability still takes precedence', async ({ extension }) => {
  await extension.setupPage.evaluate(() => chrome.storage.sync.set({ showAddFolderButton: 'false', showRegisteredFoldersButton: 0 }));
  await extension.setupPage.reload();
  await expect(extension.setupPage.locator('#showAddFolderButton')).toBeChecked();
  await expect(extension.setupPage.locator('#showRegisteredFoldersButton')).toBeChecked();
  const page = await extension.openBrowser(); await ready(page);
  await expect(add(page)).toBeVisible(); await expect(roots(page)).toBeVisible();
  await extension.context.addInitScript(() => { delete window.showDirectoryPicker; });
  await page.reload(); await ready(page);
  await expect(add(page)).toBeHidden(); await expect(roots(page)).toBeHidden();
  await page.keyboard.press('a'); await page.keyboard.press('r');
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
  await expect(page.locator('#browser-fallback')).toBeVisible();
});

for (const [showAdd, showRoots] of [[false, true], [true, false], [false, false]]) {
  test(`[UX-15] independently saved buttons (${showAdd}/${showRoots}) survive reload; keys and help remain usable`, async ({ extension }) => {
    await extension.seed(); const options = extension.setupPage;
    await setCheckbox(extension, 'showAddFolderButton', showAdd);
    await setCheckbox(extension, 'showRegisteredFoldersButton', showRoots);
    await options.reload();
    expect(await options.locator('#showAddFolderButton').isChecked()).toBe(showAdd);
    expect(await options.locator('#showRegisteredFoldersButton').isChecked()).toBe(showRoots);
    const page = await extension.openBrowser(); await ready(page);
    expect(await add(page).isVisible()).toBe(showAdd); expect(await roots(page).isVisible()).toBe(showRoots);
    await page.reload(); await ready(page);
    expect(await add(page).isVisible()).toBe(showAdd); expect(await roots(page).isVisible()).toBe(showRoots);
    await page.keyboard.press('?'); await expect(help(page)).toBeVisible();
    await expect(help(page).locator('[data-key="r"]')).toBeVisible();
    await expect(help(page).locator('[data-key="a"]')).toBeVisible(); await page.keyboard.press('Escape');
    await page.keyboard.press('r'); await expect(screen(page)).toHaveAttribute('data-view', 'roots');
    await page.keyboard.press('j'); await page.keyboard.press('Enter'); await ready(page);
    await expect.poll(async () => (await extension.registry()).primaryId).toBe(rootB);
    await page.evaluate(() => { window.__pickerName = 'Work'; }); await page.keyboard.press('a'); await ready(page);
    await expect.poll(async () => (await extension.registry()).roots.length).toBe(3);
    expect(await page.evaluate(() => window.__pickerCalls)).toEqual([{ options: { mode: 'read' }, active: true }]);
  });
}

test('[UX-15] live updates preserve editing, modal focus and data; hiding a focused button restores list focus and excludes it from Tab', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await ready(page);
  const registry = await extension.registry();
  await extension.setupPage.evaluate(identity => chrome.storage.local.set({
    'vimdf.customCss.v1': { version: 1, css: '.vimdf-browser { --vimdf-accent: #123456; }' },
    [`vimdf:state:${identity}`]: { page: 2, scrollTop: 42 },
    [`vimdf:marks:${identity}`]: { a: { page: 2, x: 0, y: 100 } },
    [`vimdf:highlights:${identity}`]: [{ id: 'fixture-highlight', color: '#ff0000', page: 1, rects: [] }],
  }), pdfIdentity);
  const local = await extension.setupPage.evaluate(() => chrome.storage.local.get(null));
  await filter(page, 'course'); await page.keyboard.press('Enter'); await ready(page);
  await page.keyboard.press('/'); await page.getByTestId('browser-filter').fill('lesson'); const editing = await snapshot(page);
  await setCheckbox(extension, 'showAddFolderButton', false); await expect(add(page)).toBeHidden();
  expect(await snapshot(page)).toEqual(editing); await expect(page.getByTestId('browser-filter')).toBeFocused();
  await page.keyboard.press('Enter'); const before = await snapshot(page);
  await page.keyboard.press('?'); await expect(help(page)).toBeVisible();
  const focused = await page.evaluate(() => document.activeElement.outerHTML);
  await setCheckbox(extension, 'showRegisteredFoldersButton', false); await expect(roots(page)).toBeHidden();
  await expect(help(page)).toBeVisible(); expect(await page.evaluate(() => document.activeElement.outerHTML)).toBe(focused);
  await page.keyboard.press('Escape'); expect(await snapshot(page)).toEqual(before);
  await setCheckbox(extension, 'showAddFolderButton', true); await expect(add(page)).toBeVisible();
  await add(page).focus(); await expect(add(page)).toBeFocused();
  await setCheckbox(extension, 'showAddFolderButton', false); await expect(page.getByRole('listbox')).toBeFocused();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab'); await expect(add(page)).not.toBeFocused(); await expect(roots(page)).not.toBeFocused();
  }
  expect(await extension.registry()).toEqual(registry);
  expect(await extension.setupPage.evaluate(() => chrome.storage.local.get(null))).toEqual(local);
  // Resetting general settings restores visible buttons without resetting registrations or PDF data.
  await extension.setupPage.locator('#reset').click();
  await expect(add(page)).toBeVisible(); await expect(roots(page)).toBeVisible();
  await expect(extension.setupPage.locator('#showAddFolderButton')).toBeChecked();
  await expect(extension.setupPage.locator('#showRegisteredFoldersButton')).toBeChecked();
  expect(await extension.registry()).toEqual(registry);
  expect(await extension.setupPage.evaluate(() => chrome.storage.local.get(null))).toEqual(local);
});

test('[UX-15] changes made during PDF viewing apply on return without moving the PDF or invoking folder commands', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await openLesson(page);
  await page.keyboard.press('G'); await expect(page.locator('#statusLeft')).toHaveText('Page 2 / 2');
  const before = await page.locator('#statusLeft').textContent();
  await setCheckbox(extension, 'showAddFolderButton', false);
  await setCheckbox(extension, 'showRegisteredFoldersButton', false);
  await expect(screen(page)).toHaveAttribute('data-mode', 'pdf');
  await expect(page.locator('#statusLeft')).toHaveText(before);
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
  await page.locator('[data-action="back"]').click(); await ready(page);
  await expect(screen(page)).toHaveAttribute('data-mode', 'files');
  await expect(add(page)).toBeHidden(); await expect(roots(page)).toBeHidden();
  await expect(page.getByRole('listbox')).toBeFocused();
  await page.keyboard.press('r'); await expect(screen(page)).toHaveAttribute('data-view', 'roots');
});

import { test, expect, filter, rootA, rootB } from './extension-fixture.mjs';

test.use({ actionTimeout: 5000 });

const screen = page => page.getByTestId('local-browser');
const list = page => page.getByRole('listbox', { name: 'Files and folders' });
const selection = page => list(page).locator('[role="option"][aria-selected="true"]');
const status = page => page.locator('#files .vimdf-statusline');
async function ready(page) { await expect(screen(page)).toHaveAttribute('data-busy', 'false'); }
async function roots(page) {
  await ready(page); await page.keyboard.press('r');
  await expect(screen(page)).toHaveAttribute('data-view', 'roots'); await ready(page);
}
async function selectionMatchesAnnouncement(page, name) {
  await expect(selection(page)).toHaveCount(1);
  await expect(selection(page)).toHaveAccessibleName(name);
  const id = await selection(page).getAttribute('id');
  expect(id).toBeTruthy(); await expect(list(page)).toHaveAttribute('aria-activedescendant', id);
}
async function fitsHorizontally(area) {
  await expect(area).toBeVisible();
  const bounds = await area.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: window.innerWidth,
      overflow: el.scrollWidth - el.clientWidth };
  });
  expect(bounds.left, 'Content starts inside the viewport').toBeGreaterThanOrEqual(-1);
  expect(bounds.right, 'Content ends inside the viewport').toBeLessThanOrEqual(bounds.viewport + 1);
  expect(bounds.overflow, 'Reading and acting do not require horizontal scrolling').toBeLessThanOrEqual(1);
}
async function tabTo(page, control) {
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    if (await control.evaluate(el => el === document.activeElement)) return;
  }
  throw new Error('The action cannot be reached with Tab');
}

test('[UX-18] mouse, keys and filtering keep one selected item and its spoken identity in sync', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await ready(page);
  const saved = await extension.registry();
  await selectionMatchesAnnouncement(page, 'course');
  await expect(status(page)).toContainText('1/4'); await expect(status(page)).toContainText('4 items');
  await page.getByRole('option', { name: 'z.pdf', exact: true }).click();
  await expect(list(page)).toBeFocused(); await selectionMatchesAnnouncement(page, 'z.pdf');
  await expect(status(page)).toContainText('3/4');
  await page.keyboard.press('g'); await page.keyboard.press('g');
  await selectionMatchesAnnouncement(page, 'course');
  await page.keyboard.press('j'); await selectionMatchesAnnouncement(page, 'locked.pdf');
  await expect(status(page)).toContainText('2/4');
  await filter(page, 'z.pdf'); await selectionMatchesAnnouncement(page, 'z.pdf');
  await expect(status(page)).toContainText('1/1'); await expect(status(page)).toContainText(/\b1 items?\b/);
  await page.keyboard.press('Escape'); await expect(page.getByRole('option')).toHaveCount(4);
  await selectionMatchesAnnouncement(page, 'z.pdf');
  await roots(page); await selectionMatchesAnnouncement(page, 'University');
  await page.keyboard.press('j'); await selectionMatchesAnnouncement(page, 'Books');
  expect(await extension.registry()).toEqual(saved);
});

test('[UX-18] no results have no stale selected item, no phantom count and no action on Enter or l', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await ready(page); await roots(page);
  const saved = await extension.registry(); await filter(page, 'no-such-registered-folder');
  await expect(page.getByRole('option')).toHaveCount(0); await expect(selection(page)).toHaveCount(0);
  expect(await list(page).getAttribute('aria-activedescendant')).toBeFalsy();
  await expect(status(page)).toContainText('0/0'); await expect(status(page)).toContainText('0 items');
  await expect(page.locator('#browser-message')).toContainText(/no matching/i);
  for (const key of ['Enter', 'l', 'j', 'G']) { await page.keyboard.press(key); await ready(page); }
  await expect(screen(page)).toHaveAttribute('data-view', 'roots');
  await expect(page.getByRole('option')).toHaveCount(0); expect(await extension.registry()).toEqual(saved);
  expect(await page.evaluate(() => ({ picker: window.__pickerCalls, permission: window.__permissionCalls })))
    .toEqual({ picker: [], permission: [] });
  await page.keyboard.press('Escape'); await expect(page.getByRole('option')).toHaveCount(2);
  await selectionMatchesAnnouncement(page, 'University');
});

for (const fontSize of [13, 17]) {
  test(`[UX-19] 320px and ${fontSize}px text: long equal folder names, identifiers and unregister remain readable and usable`, async ({ extension }) => {
    const name = 'UnbrokenFolderNameForCourseMaterials';
    await extension.seed({ sameNames: true, sameName: name });
    if (fontSize !== 13) await extension.setupPage.evaluate(size => chrome.storage.local.set({
      'vimdf.customCss.v1': { version: 1, css: `.vimdf-browser { font-size: ${size}px; }` },
    }), fontSize);
    const page = await extension.openBrowser(); await page.setViewportSize({ width: 320, height: 640 });
    await ready(page); await roots(page); const saved = await extension.registry();
    await fitsHorizontally(page.locator('#files')); await fitsHorizontally(list(page)); await fitsHorizontally(status(page));
    for (const id of [rootA, rootB]) {
      const row = page.getByRole('option', { name: `${name} ${id}`, exact: true });
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeInViewport({ ratio: 0.99 }); await fitsHorizontally(row);
      const text = row.locator('[data-column="name"]');
      await expect(text).toContainText(name); await expect(text).toContainText(id); await fitsHorizontally(text);
      expect(await text.evaluate(el => el.scrollHeight - el.clientHeight), 'Names and IDs are not clipped').toBeLessThanOrEqual(1);
      const remove = row.getByRole('button', { name: `Unregister ${name}`, exact: true });
      await fitsHorizontally(remove); await remove.click();
      const dialog = page.getByRole('dialog', { name: 'Unregister folder?', exact: true });
      await expect(dialog).toContainText(id); await fitsHorizontally(dialog);
      await expect(dialog.getByRole('button', { name: 'Keep folder' })).toBeFocused();
      await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(list(page)).toBeFocused();
    }
    expect(await extension.registry()).toEqual(saved);
  });
}

test('[UX-19] a wrapped status line stays readable beside the name input and selected row', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser();
  await page.setViewportSize({ width: 320, height: 540 }); await ready(page);
  const query = 'unbroken-search-name-'.repeat(4);
  await page.keyboard.press('/'); const input = page.getByRole('textbox', { name: 'Filter file or folder names' });
  await input.fill(query); await expect(input).toBeFocused(); await expect(status(page)).toContainText(query);
  await fitsHorizontally(status(page)); await fitsHorizontally(page.locator('#files'));
  const inputBox = await input.boundingBox(), statusBox = await status(page).boundingBox();
  expect(inputBox.y + inputBox.height, 'Typing does not cover status information').toBeLessThanOrEqual(statusBox.y + 1);
  await input.fill('z.pdf');
  await expect(selection(page)).toBeInViewport({ ratio: 0.99 });
  const rowBox = await selection(page).boundingBox(), editingBox = await input.boundingBox();
  expect(rowBox.y + rowBox.height, 'The selected row is not covered by the input').toBeLessThanOrEqual(editingBox.y + 1);
  await page.keyboard.press('Enter'); await expect(input).toBeHidden();
  await selectionMatchesAnnouncement(page, 'z.pdf');
  await page.keyboard.press('/'); await expect(input).toHaveValue('z.pdf');
  await page.keyboard.press('Escape'); await expect(page.getByRole('option')).toHaveCount(4);
});

for (const modal of ['help', 'unregister']) {
  test(`[UX-21] ${modal} at 320px keeps forward and reverse Tab inside; cancellation restores the caller`, async ({ extension }) => {
    await extension.seed(); const page = await extension.openBrowser();
    await page.setViewportSize({ width: 320, height: 360 }); await ready(page); await roots(page);
    const saved = await extension.registry(); await list(page).focus();
    if (modal === 'help') await page.keyboard.press('?');
    else await page.getByRole('button', { name: 'Unregister University', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: modal === 'help' ? 'File browser keybindings' : 'Unregister folder?', exact: true });
    await fitsHorizontally(dialog);
    for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Tab']) {
      await page.keyboard.press(key);
      expect(await dialog.evaluate(el => el.contains(document.activeElement)), 'Focus stays with the open operation').toBe(true);
    }
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(list(page)).toBeFocused();
    await expect(screen(page)).toHaveAttribute('data-view', 'roots');
    await selectionMatchesAnnouncement(page, 'University'); expect(await extension.registry()).toEqual(saved);
  });
}

test('[UX-20] a slow folder read is visibly pending, retains the prior information and does not steal help focus', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await ready(page);
  await filter(page, 'course'); const saved = await extension.registry();
  await page.evaluate(() => {
    const values = FileSystemDirectoryHandle.prototype.values; let held = false;
    const gate = new Promise(resolve => { window.__releaseFolderRead = resolve; });
    FileSystemDirectoryHandle.prototype.values = async function* (...args) {
      if (this.name === 'course' && !held) { held = true; await gate; }
      yield* values.apply(this, args);
    };
  });
  await page.keyboard.press('Enter'); await expect(screen(page)).toHaveAttribute('data-busy', 'true');
  try {
    await expect(list(page)).toHaveAttribute('aria-busy', 'true');
    await expect(status(page)).toContainText(/loading|reading|working|in progress/i);
    await expect(page.getByTestId('browser-location')).toHaveText('University');
    await expect(page.getByRole('option', { name: 'course', exact: true })).toBeVisible();
    for (const name of ['Registered folders', 'Add folder']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    await page.keyboard.press('?'); const dialog = page.getByRole('dialog', { name: 'File browser keybindings' });
    await expect(dialog).toBeVisible();
    await page.evaluate(() => window.__releaseFolderRead()); await ready(page);
    await expect(dialog).toBeVisible(); expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape'); await expect(page.getByTestId('browser-location')).toContainText('course');
    await expect(status(page)).not.toContainText(/loading|reading|working|in progress/i);
    await selectionMatchesAnnouncement(page, 'lesson.pdf'); expect(await extension.registry()).toEqual(saved);
  } finally { await page.evaluate(() => window.__releaseFolderRead()); }
});

test('[UX-21] keyboard action focus remains visible and uses the configurable focus color', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await ready(page);
  await extension.setupPage.evaluate(() => chrome.storage.local.set({
    'vimdf.customCss.v1': { version: 1, css: '.vimdf-browser { --vimdf-focus: #2468ac; }' },
  }));
  const add = page.getByRole('button', { name: 'Add folder', exact: true });
  await tabTo(page, add); await expect(add).toBeFocused();
  const focus = await add.evaluate(el => ({ width: parseFloat(getComputedStyle(el).outlineWidth), style: getComputedStyle(el).outlineStyle }));
  expect(focus.width).toBeGreaterThan(0); expect(focus.style).not.toBe('none');
  await expect(add).toHaveCSS('outline-color', 'rgb(36, 104, 172)');
});

test.describe('coarse pointer', () => {
  test.use({ hasTouch: true });
  test('[UX-22] touch targets stay large enough without enlarging browser text', async ({ extension }) => {
    await extension.seed(); const page = await extension.openBrowser(); await ready(page);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    async function targets() {
      for (const button of await page.locator('#files button:visible').all()) {
        const box = await button.boundingBox();
        expect(box.width, 'An action can be tapped horizontally').toBeGreaterThanOrEqual(44);
        expect(box.height, 'An action can be tapped vertically').toBeGreaterThanOrEqual(44);
        await expect(button).toHaveCSS('font-size', '13px');
      }
    }
    await targets(); await roots(page); await targets();
    await page.getByRole('button', { name: 'Unregister University', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Unregister folder?' })).toBeVisible(); await targets();
    await page.keyboard.press('Escape'); await expect(list(page)).toBeFocused();
  });
});

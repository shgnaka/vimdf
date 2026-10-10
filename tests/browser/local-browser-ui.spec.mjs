import { test, expect, filter, openLesson, rootA, rootB } from './extension-fixture.mjs';

const screen = page => page.getByTestId('local-browser');
const input = page => page.getByTestId('browser-filter');
const help = page => page.getByRole('dialog', { name: 'Local PDF browser keybindings', exact: true });
const viewerHelp = page => page.getByRole('dialog', { name: 'PDF viewer keybindings', exact: true });
const selected = page => page.locator('#files [role="option"][aria-selected="true"]');
async function ready(page) { await expect(screen(page)).toHaveAttribute('data-busy', 'false'); }
async function roots(page) {
  await ready(page); await page.locator('[data-action="roots"]').click();
  await expect(screen(page)).toHaveAttribute('data-view', 'roots');
}
async function state(page) {
  return page.evaluate(() => ({ mode: document.querySelector('[data-testid="local-browser"]').dataset.mode,
    view: document.querySelector('[data-testid="local-browser"]').dataset.view,
    location: document.querySelector('[data-testid="browser-location"]').textContent,
    query: document.querySelector('[data-testid="browser-filter"]').value,
    selected: document.querySelector('#files [aria-selected="true"]')?.getAttribute('aria-label') ?? null,
    page: document.querySelector('[data-testid="local-browser"]').dataset.mode === 'pdf'
      ? document.querySelector('#statusLeft')?.textContent : null }));
}
async function repeat(page, key) {
  await page.evaluate(key => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
    key, repeat: true, bubbles: true, cancelable: true,
  })), key);
}
async function tabTo(page, target) {
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate(el => el === document.activeElement)) return;
  }
  throw new Error('Control is unreachable using Tab');
}

test('[UX-01] normal list removes branding/settings/hints and hides filter from Tab', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await ready(page);
  await expect(page.locator('#files .wordmark')).toHaveCount(0);
  await expect(page.locator('#files [data-action="settings"]')).toHaveCount(0);
  await expect(page.locator('#files kbd:visible')).toHaveCount(0);
  await expect(input(page)).toBeHidden();
  await expect(page.getByTestId('browser-location')).toContainText('University');
  await expect(selected(page)).toHaveCount(1);
  await expect(page.locator('#files .vimdf-statusline')).toContainText(/\d/);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab'); await expect(input(page)).not.toBeFocused();
  }
});

test('[UX-02/UX-03] r switches from a child using only keys; Esc restores child state', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser();
  await filter(page, 'course'); await page.keyboard.press('Enter'); await filter(page, 'lesson');
  const before = await state(page); const saved = await extension.registry();
  await page.keyboard.press('r'); await expect(screen(page)).toHaveAttribute('data-view', 'roots');
  await page.keyboard.press('j'); expect(await extension.registry()).toEqual(saved);
  await filter(page, 'Books'); const chooser = await state(page);
  await page.keyboard.press('r'); expect(await state(page)).toEqual(chooser);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  expect(await state(page)).toEqual(before); expect(await extension.registry()).toEqual(saved);
  await page.keyboard.press('r'); await page.keyboard.press('j'); await page.keyboard.press('Enter');
  await expect.poll(async () => (await extension.registry()).primaryId).toBe(rootB);
  await expect(page.getByTestId('browser-location')).toContainText('Books');
  await page.reload(); await expect(page.getByTestId('browser-location')).toContainText('Books');
});

for (const view of ['empty', 'browse', 'roots', 'permission']) {
  test(`[UX-04/UX-13] a in ${view} invokes exactly one picker with active user gesture`, async ({ extension }) => {
    if (view !== 'empty') await extension.seed();
    if (view === 'permission') await extension.context.addInitScript(() => { window.__permission = 'prompt'; });
    const page = await extension.openBrowser(); if (view === 'roots') await roots(page);
    await ready(page); await page.evaluate(() => { window.__pickerName = 'Work'; });
    await page.keyboard.press('a');
    await expect(screen(page)).toHaveAttribute('data-view', view === 'empty' ? 'browse' : 'roots');
    await ready(page);
    expect(await page.evaluate(() => window.__pickerCalls)).toEqual([{ options: { mode: 'read' }, active: true }]);
    expect(await page.evaluate(() => window.__permissionCalls)).toEqual([]);
    const saved = await extension.registry(); expect(saved.roots).toHaveLength(view === 'empty' ? 1 : 3);
    if (view !== 'empty') {
      expect(saved.primaryId).toBe(rootA); await expect(selected(page)).toHaveAttribute('aria-label', 'Work');
    }
  });
}

for (const trigger of ['a', 'button']) {
  test(`[UX-04/UX-13] cancelled ${trigger} from a filtered child keeps its invoking screen and focus`, async ({ extension }) => {
    await extension.seed(); const page = await extension.openBrowser();
    await filter(page, 'course'); await page.keyboard.press('Enter'); await filter(page, 'lesson');
    const before = await state(page); const saved = await extension.registry();
    await page.evaluate(() => { window.__pickerError = 'AbortError'; });
    if (trigger === 'a') await page.keyboard.press('a'); else await page.locator('[data-action="add"]').click();
    await ready(page); expect(await state(page)).toEqual(before); expect(await extension.registry()).toEqual(saved);
    expect(await page.evaluate(() => window.__pickerCalls.length)).toBe(1);
    await expect(page.getByRole('listbox')).toBeFocused();
  });
}

test('[UX-05] transient command input treats r/a/?/j as text, hides on Enter and resumes retained query', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await roots(page);
  const saved = await extension.registry(); await page.keyboard.press('/');
  await expect(input(page)).toBeVisible(); await expect(input(page)).toBeFocused();
  await page.keyboard.type('ra?j'); await expect(input(page)).toHaveValue('ra?j');
  await expect(help(page)).toBeHidden(); expect(await extension.registry()).toEqual(saved);
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
  await input(page).fill('Books'); await page.keyboard.press('Enter');
  await expect(input(page)).toBeHidden(); await expect(selected(page)).toHaveAttribute('aria-label', 'Books');
  await expect(page.locator('#files .vimdf-statusline')).toContainText('Books');
  expect(await extension.registry()).toEqual(saved);
  await page.keyboard.press('/'); await expect(input(page)).toHaveValue('Books');
  await page.keyboard.press('Escape'); await expect(input(page)).toBeHidden();
  await expect(page.getByRole('option')).toHaveCount(2);
});

for (const view of ['empty', 'browse', 'roots', 'permission']) {
  test(`[UX-06] ? opens named ${view} help with only available folder commands and restores focus`, async ({ extension }) => {
    if (view !== 'empty') await extension.seed();
    if (view === 'permission') await extension.context.addInitScript(() => { window.__permission = 'prompt'; });
    const page = await extension.openBrowser(); if (view === 'roots') await roots(page); await ready(page);
    const before = await state(page); const saved = await extension.registry();
    const focused = await page.evaluate(() => document.activeElement.id);
    await page.keyboard.press('?'); await expect(help(page)).toBeVisible();
    await expect(help(page)).toContainText(/Add folder/i);
    const commandRows = help(page).locator('[data-command]');
    await expect(commandRows.filter({ has: page.locator('[data-key="a"]') })).toHaveCount(1);
    await expect(commandRows.filter({ has: page.locator('[data-key="r"]') })).toHaveCount(view === 'empty' ? 0 : 1);
    await expect(commandRows.filter({ has: page.locator('[data-key="h"]') })).toHaveCount(view === 'browse' || view === 'roots' ? 1 : 0);
    await expect(help(page)).not.toContainText(/Toggle outline/);
    await page.keyboard.press('a'); await page.keyboard.press('r'); await page.keyboard.press('Enter');
    expect(await extension.registry()).toEqual(saved); expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
    await page.keyboard.press('?'); await expect(help(page)).toBeHidden();
    expect(await state(page)).toEqual(before);
    expect(await page.evaluate(() => document.activeElement.id)).toBe(focused);
  });
}

test('[UX-07] help owns scrolling, filtering, Tab, repeat and incomplete gg without changing the list', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await page.setViewportSize({ width: 800, height: 360 });
  await ready(page); await page.keyboard.press('G'); const before = await state(page);
  await page.keyboard.press('g'); await page.keyboard.press('?'); await expect(help(page)).toBeVisible();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab'); expect(await help(page).evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  const scroll = help(page).getByTestId('help-scroll');
  await scroll.focus();
  await page.keyboard.press('G'); await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('g'); await repeat(page, 'g');
  expect(await scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('g'); await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(0);
  for (const key of ['j', 'ArrowDown', 'Control+d']) {
    await page.keyboard.press(key); await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  }
  await page.keyboard.press('k'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Control+u');
  await page.keyboard.press('/'); const search = help(page).getByRole('textbox', { name: 'Filter keybindings', exact: true });
  await search.fill('?'); await page.keyboard.press('?'); await expect(search).toHaveValue('??');
  await search.fill('Add folder');
  await expect(help(page).locator('[data-command]:visible')).toHaveCount(1);
  await page.keyboard.press('Enter'); await expect(help(page)).toBeVisible();
  await page.keyboard.press('Escape'); await expect(help(page)).toBeVisible();
  await expect(help(page).locator('[data-command]:visible')).not.toHaveCount(1);
  await repeat(page, '?'); await expect(help(page)).toBeVisible();
  await page.keyboard.press('Escape'); await expect(help(page)).toBeHidden();
  expect(await state(page)).toEqual(before);
  await page.keyboard.press('g'); expect(await state(page)).toEqual(before);
});

test('[UX-08] IME Enter/Esc/r/a/? and native buttons retain ownership of their events', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await ready(page);
  await page.keyboard.press('/'); await input(page).fill('course');
  await input(page).evaluate(el => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    for (const key of ['Enter', 'Escape', 'r', 'a', '?']) el.dispatchEvent(new KeyboardEvent('keydown', {
      key, isComposing: true, bubbles: true, cancelable: true,
    }));
  });
  await expect(input(page)).toBeFocused(); await expect(input(page)).toHaveValue('course');
  await expect(help(page)).toBeHidden(); expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
  await input(page).evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await page.keyboard.press('Escape'); await page.locator('[data-action="add"]').focus();
  for (const key of ['r', '?']) await page.keyboard.press(key);
  await expect(screen(page)).toHaveAttribute('data-view', 'browse'); await expect(help(page)).toBeHidden();
  await page.evaluate(() => { window.__pickerError = 'AbortError'; });
  await page.keyboard.press('Enter'); await ready(page);
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([{ options: { mode: 'read' }, active: true }]);
});

test('[UX-08] help stays focused while picker is pending and when the asynchronous add finishes', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await ready(page);
  await page.evaluate(() => {
    const pick = window.showDirectoryPicker;
    window.showDirectoryPicker = options => {
      const result = pick(options); // Preserve the gesture at the boundary.
      return new Promise(resolve => { window.__releasePicker = async () => resolve(await result); });
    }; window.__pickerName = 'Work';
  });
  await page.keyboard.press('a'); await expect(screen(page)).toHaveAttribute('data-busy', 'true');
  await page.keyboard.press('?'); await expect(help(page)).toBeVisible();
  for (const key of ['r', 'a', 'Enter', 'l']) await page.keyboard.press(key);
  expect(await page.evaluate(() => window.__pickerCalls.length)).toBe(1);
  await page.evaluate(() => window.__releasePicker()); await ready(page);
  await expect(help(page)).toBeVisible(); expect(await help(page).evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape'); await expect(screen(page)).toHaveAttribute('data-view', 'roots');
  await expect(selected(page)).toHaveAttribute('aria-label', 'Work');
  expect(await page.evaluate(() => window.__pickerCalls.length)).toBe(1);
});

test('[UX-09] files/loading/pdf/files have one key owner and separate help', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser();
  await filter(page, 'locked'); const before = await state(page); const saved = await extension.registry();
  await page.keyboard.press('Enter'); await expect(screen(page)).toHaveAttribute('data-mode', 'loading-pdf');
  const password = page.getByRole('dialog', { name: 'PDF password' }); await expect(password).toBeVisible();
  await password.locator('input[name="password"]').fill('ra?j');
  await expect(password.locator('input[name="password"]')).toHaveValue('ra?j');
  await expect(help(page)).toBeHidden(); await expect(viewerHelp(page)).toBeHidden();
  await page.keyboard.press('Escape'); await expect(screen(page)).toHaveAttribute('data-mode', 'files');
  expect(await state(page)).toEqual(before);
  await page.keyboard.press('Escape'); await openLesson(page); await page.keyboard.press('2'); await page.keyboard.press('G');
  const pdfState = await state(page);
  await page.keyboard.press('r'); await page.keyboard.press('a');
  expect(await extension.registry()).toEqual(saved); expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
  await page.keyboard.press('?'); await expect(viewerHelp(page)).toBeVisible(); await expect(help(page)).toBeHidden();
  await expect(viewerHelp(page)).toContainText(/outline/i);
  await expect(viewerHelp(page)).not.toContainText(/Registered folders|Add folder/);
  for (const key of ['j', 'k', 'r', 'a']) await page.keyboard.press(key);
  await page.keyboard.press('Escape'); expect(await state(page)).toEqual(pdfState);
  await page.keyboard.press('H'); await expect(screen(page)).toHaveAttribute('data-mode', 'files');
  await page.keyboard.press('?'); await expect(help(page)).toBeVisible(); await expect(viewerHelp(page)).toBeHidden();
  await page.keyboard.press('Escape'); await page.keyboard.press('j');
  await expect(screen(page)).toHaveAttribute('data-mode', 'files'); expect(await extension.registry()).toEqual(saved);
});

test('[UX-13] unregister is reachable with Tab/Enter/Esc and dialog blocks folder keys', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await roots(page);
  const saved = await extension.registry(); const remove = page.getByRole('button', { name: 'Unregister Books', exact: true });
  await tabTo(page, remove); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Unregister folder?' });
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Keep folder' })).toBeFocused();
  for (const key of ['r', 'a', '?']) await page.keyboard.press(key);
  await expect(help(page)).toBeHidden(); expect(await extension.registry()).toEqual(saved);
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await tabTo(page, remove); await page.keyboard.press('Enter'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await expect.poll(async () => (await extension.registry()).roots.map(r => r.id)).toEqual([rootA]);
  expect((await extension.registry()).primaryId).toBe(rootA);
});

for (const failure of ['unsupported API', 'DB failure', 'stale registry']) {
  test(`[UX-13] ${failure} forbids r/a mutations and automatic permission/picker`, async ({ extension }) => {
    if (failure !== 'DB failure') await extension.seed();
    if (failure === 'unsupported API') await extension.context.addInitScript(() => { window.showDirectoryPicker = undefined; });
    if (failure === 'DB failure') await extension.context.addInitScript(() => {
      IDBFactory.prototype.open = () => { throw new DOMException('unavailable', 'SecurityError'); };
    });
    const page = await extension.openBrowser(); await ready(page);
    if (failure === 'stale registry') {
      const other = await extension.openBrowser(); await roots(other);
      await other.getByRole('option', { name: 'Books', exact: true }).dblclick();
      await expect(page.getByTestId('registry-stale')).toBeVisible();
    }
    const before = await state(page);
    for (const key of ['r', 'a', 'Enter']) await page.keyboard.press(key);
    expect(await state(page)).toEqual(before);
    expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
    expect(await page.evaluate(() => window.__permissionCalls)).toEqual([]);
    if (failure === 'unsupported API') {
      await page.keyboard.press('?'); await expect(help(page)).toBeVisible();
      await expect(help(page)).not.toContainText(/Registered folders|Add folder/);
      await expect(help(page)).toContainText(/PDF file/i);
    }
  });
}

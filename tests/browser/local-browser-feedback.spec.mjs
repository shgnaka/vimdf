import { test, expect, rootA, rootB, filter } from './extension-fixture.mjs';
import { lessonPdf } from '../helpers/pdf-bytes.mjs';

test('permission confirmation identifies the pending folder, including a non-default selection, and cancellation preserves the default', async ({ extension }) => {
  await extension.seed();
  await extension.context.addInitScript(() => { window.__permission = 'prompt'; });
  const page = await extension.openBrowser();
  const screen = page.getByTestId('local-browser');
  const message = page.locator('#browser-message');
  await expect(screen).toHaveAttribute('data-view', 'permission');
  await expect(message).toContainText('University');
  await page.keyboard.press('r'); await expect(screen).toHaveAttribute('data-view', 'roots');
  await page.keyboard.press('j'); await page.keyboard.press('Enter');
  await expect(screen).toHaveAttribute('data-view', 'permission');
  await expect(message).toContainText('Books');
  await expect(message).not.toContainText('University');
  expect(await page.evaluate(() => window.__permissionCalls)).toEqual([]);
  await page.keyboard.press('Escape'); await expect(screen).toHaveAttribute('data-view', 'roots');
  expect((await extension.registry()).primaryId).toBe(rootA);
  await page.keyboard.press('Enter');
  await expect(message).toContainText('Books');
  await page.getByRole('button', { name: 'Allow read access', exact: true }).click();
  await expect(screen).toHaveAttribute('data-view', 'browse');
  await expect(page.getByTestId('browser-location')).toContainText('Books');
  expect((await extension.registry()).primaryId).toBe(rootB);
});

test('failed DB initialization reports stopped folder recovery and still opens a PDF file without registering anything', async ({ extension }) => {
  await extension.seed(); const before = await extension.registry();
  await extension.context.addInitScript(() => { IDBFactory.prototype.open = () => { throw new DOMException('storage unavailable', 'SecurityError'); }; });
  const page = await extension.openBrowser();
  await expect(page.getByRole('alert')).toContainText('storage unavailable');
  await expect(page.locator('#browser-message')).not.toContainText(/loading|Add a folder/i);
  await expect(page.locator('#browser-fallback')).not.toContainText(/unavailable in this browser/i);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Add folder', exact: true })).toBeDisabled();
  await page.locator('#fallback-file').setInputFiles({ name: 'recovery.pdf', mimeType: 'application/pdf', buffer: Buffer.from(lessonPdf()) });
  await expect(page.locator('#viewer .page')).toHaveCount(2);
  await page.getByRole('button', { name: /Files/ }).click();
  await expect(page.getByRole('button', { name: 'Open PDF file', exact: true })).toBeEnabled();
  expect(await extension.registry()).toEqual(before);
});

test('private startup rejection shows the regular-tab recovery instruction without an ongoing loading message or folder access', async ({ extension }) => {
  await extension.context.addInitScript(() => {
    Object.defineProperty(chrome.extension, 'inIncognitoContext', { value: true });
    window.__dbOpens = 0;
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) { window.__dbOpens++; return open.apply(this, args); };
  });
  const page = await extension.openBrowser();
  await expect(page.getByRole('alert')).toContainText('regular top-level tab');
  await expect(page.locator('#browser-message')).not.toContainText(/loading|Add a folder/i);
  expect(await page.evaluate(() => ({ db: window.__dbOpens, picker: window.__pickerCalls, permissions: window.__permissionCalls })))
    .toEqual({ db: 0, picker: [], permissions: [] });
});

test('a help search with no matches explains the result and clearing it restores commands without changing file selection', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await filter(page, 'course');
  const selected = page.getByRole('option', { name: 'course', exact: true });
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('?'); const help = page.getByRole('dialog', { name: 'File browser keybindings', exact: true });
  await page.keyboard.press('/'); const input = help.getByRole('textbox', { name: 'Filter keybindings' });
  await input.fill('no-such-command');
  await expect(help.getByRole('status')).toContainText(/no matching keybindings/i);
  await expect(input).toHaveValue('no-such-command');
  await input.fill('Add folder');
  await expect(help.getByRole('status')).toBeHidden();
  await expect(help.getByRole('cell', { name: 'Add folder', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(help).toBeHidden(); await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('browser-filter')).toHaveValue('course');
});

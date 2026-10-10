import { test, expect, filter, openLesson, pdfIdentity } from './extension-fixture.mjs';
import { master, nextMaster, v1, v2, draft, record, payload, documentKey, seal, unseal } from '../helpers/password-vault-fixtures.mjs';

test.use({ actionTimeout: 5000 });
const section = page => page.locator('#passwordSettings');
const status = page => page.locator('#passwordVaultStatus');
const modal = (page, name) => page.getByRole('dialog', { name, exact: true });
const masterInput = dialog => dialog.getByLabel('Master password', { exact: true });
const confirmInput = dialog => dialog.getByLabel('Confirm master password', { exact: true });
async function allData(extension) {
  return extension.setupPage.evaluate(async () => ({ local: await chrome.storage.local.get(null), sync: await chrome.storage.sync.get(null) }));
}
async function seedVault(extension, value = payload()) {
  const cipher = await seal(value);
  await extension.setupPage.evaluate(({ key, cipher }) => chrome.storage.local.set({ [key]: cipher }), { key: v2, cipher });
  await extension.setupPage.reload(); return cipher;
}
async function create(page) {
  await page.locator('#passwordCreateVault').click(); const dialog = modal(page, 'Create password vault');
  await masterInput(dialog).fill(master); await confirmInput(dialog).fill(master);
  await dialog.getByRole('button', { name: 'Create vault', exact: true }).click();
  await expect(dialog).toBeHidden(); await expect(section(page)).toHaveAttribute('data-vault-state', 'unlocked');
}
async function unlock(page, password = master) {
  await page.locator('#passwordUnlockVault').click(); const dialog = modal(page, 'Unlock password vault');
  await masterInput(dialog).fill(password); await dialog.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(dialog).toBeHidden(); await expect(section(page)).toHaveAttribute('data-vault-state', 'unlocked');
}
async function register(page, secret = draft().password, name = draft().name) {
  const form = section(page).locator('.password-form');
  await form.locator('[name="name"]').fill(name); await form.locator('[name="password"]').fill(secret);
  await form.getByRole('button', { name: 'Register password', exact: true }).click();
  await expect(section(page).locator('.password-record').getByLabel('Password name', { exact: true })).toHaveValue(name);
}
async function plainDialog(page) {
  await page.locator('#passwordExportPlaintext').click(); return modal(page, 'Export plaintext passwords');
}
async function downloaded(page, action) {
  const event = page.waitForEvent('download', { timeout: 5000 }); await action(); const file = await event;
  expect(await file.failure()).toBeNull(); const stream = await file.createReadStream(); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { filename: file.suggestedFilename(), text: Buffer.concat(chunks).toString('utf8') };
}
async function observeOutput(page) {
  await page.evaluate(() => {
    window.__vaultBlobCount = 0; window.__vaultObjectUrls = []; window.__vaultRevokedUrls = [];
    const BlobImpl = window.Blob, create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    window.Blob = class extends BlobImpl { constructor(...args) { super(...args); window.__vaultBlobCount++; } };
    URL.createObjectURL = value => { const url = create(value); window.__vaultObjectUrls.push(url); return url; };
    URL.revokeObjectURL = url => { window.__vaultRevokedUrls.push(url); return revoke(url); };
  });
}
async function restoreDialog(page, cipher, password = master) {
  await page.locator('#passwordRestore').click(); const dialog = modal(page, 'Restore password vault');
  await dialog.locator('#passwordRestoreFile').setInputFiles({ name: 'fixture.vimdf-vault.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(cipher)) });
  await dialog.getByLabel('Backup master password', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: 'Validate backup', exact: true }).click(); return dialog;
}
async function savedPdfData(extension) {
  await extension.setupPage.evaluate(async identity => {
    await chrome.storage.sync.set({ theme: 'dark', scrollStep: 113 });
    await chrome.storage.local.set({
      'vimdf.customCss.v1': { version: 1, css: '.vimdf-ui { --vimdf-bg: #112233; }' },
      [`vimdf:state:${identity}`]: { page: 2, scrollTop: 42 },
      [`vimdf:marks:${identity}`]: { a: { page: 2, x: 0, y: 100 } },
      [`vimdf:highlights:${identity}`]: [{ id: 'security-fixture', page: 2, color: '#ff0000', rects: [] }],
    });
  }, pdfIdentity);
}
async function nativePdf(extension) {
  return extension.setupPage.evaluate(async () => {
    const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('University');
    return [...new Uint8Array(await (await (await dir.getFileHandle('z.pdf')).getFile()).arrayBuffer())];
  });
}

test('[SEC-01/SEC-08] common Options requires vault creation before new persistent registrations', async ({ extension }) => {
  const page = extension.setupPage;
  await expect(section(page)).toHaveAttribute('data-vault-state', 'uninitialized');
  await expect(section(page).getByRole('button', { name: 'Register password', exact: true })).toBeDisabled();
  await expect(page.locator('#passwordBackup')).toBeDisabled(); await create(page); await register(page);
  const data = await allData(extension); expect(data.local[v1]).toBeUndefined(); expect(data.local[v2].version).toBe(2);
  const contents = await unseal(data.local[v2]); expect(contents.records[0].password).toBe(draft().password);
  expect(JSON.stringify(data)).not.toContain(master); expect(JSON.stringify(data)).not.toContain(draft().password);
});
test('[SEC-02/SEC-09] master input permits literal paste, starts masked and respects IME, Enter and Escape', async ({ extension }) => {
  const page = extension.setupPage; await page.locator('#passwordCreateVault').click();
  const dialog = modal(page, 'Create password vault'); const input = masterInput(dialog);
  await expect(input).toHaveAttribute('type', 'password'); await expect(input).toBeFocused();
  const value = ` ${master}-r/a?j-e\u0301🔐 `;
  const allowed = await input.evaluate((el, text) => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    return el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, value);
  expect(allowed).toBe(true); await page.keyboard.insertText(value); await expect(input).toHaveValue(value);
  await confirmInput(dialog).fill(value); await input.focus();
  await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
  await expect(dialog).toBeVisible(); expect((await allData(extension)).local[v2]).toBeUndefined();
  await dialog.getByLabel('Show master password', { exact: true }).check(); await expect(input).toHaveAttribute('type', 'text');
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(page.locator('#passwordCreateVault')).toBeFocused();
  expect((await allData(extension)).local[v2]).toBeUndefined();
});
test('[SEC-03/SEC-09] wrong unlock leaves the dialog focused, reveals no registration and permits retry', async ({ extension }) => {
  await seedVault(extension); const before = await allData(extension), page = extension.setupPage;
  await expect(section(page).locator('.password-record')).toHaveCount(0);
  await page.locator('#passwordUnlockVault').click(); const dialog = modal(page, 'Unlock password vault');
  await masterInput(dialog).fill(nextMaster); await page.keyboard.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText(/password|corrupt|unable|invalid/i);
  await expect(masterInput(dialog)).toBeFocused(); await expect(section(page).locator('.password-record')).toHaveCount(0);
  expect(await allData(extension)).toEqual(before); await masterInput(dialog).fill(master); await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden(); await expect(section(page).locator('.password-record')).toHaveCount(2);
});
test('[SEC-06] page restart hides secrets and requires unlock without losing registrations', async ({ extension }) => {
  await seedVault(extension); const page = extension.setupPage; await unlock(page); await expect(section(page).locator('.password-record')).toHaveCount(2);
  const before = await allData(extension); await page.reload();
  await expect(section(page)).toHaveAttribute('data-vault-state', 'locked'); await expect(section(page).locator('.password-record')).toHaveCount(0);
  expect(await allData(extension)).toEqual(before); await unlock(page); await expect(section(page).locator('.password-record')).toHaveCount(2);
});
test('[SEC-06/SEC-09] manual lock removes all secret inputs and registration DOM, then unlock restores data', async ({ extension }) => {
  await seedVault(extension); const page = extension.setupPage; await unlock(page);
  const before = await allData(extension); await page.locator('#passwordLockVault').click();
  await expect(section(page)).toHaveAttribute('data-vault-state', 'locked'); await expect(section(page).locator('.password-record')).toHaveCount(0);
  expect(await section(page).locator('input[type="password"]').evaluateAll(xs => xs.map(x => x.value))).not.toContain(payload().records[0].password);
  expect(await allData(extension)).toEqual(before); await unlock(page); await expect(section(page).locator('.password-record')).toHaveCount(2);
});
test('[SEC-07] normal registration, edits and deletion do not repeatedly ask for a master', async ({ extension }) => {
  const page = extension.setupPage; await create(page); await register(page);
  const row = section(page).locator('.password-record'); await row.getByLabel('Password name', { exact: true }).fill('fixture-edited-name');
  await row.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(modal(page, 'Unlock password vault')).toHaveCount(0);
  await row.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(row).toHaveCount(0);
  await expect(section(page)).toHaveAttribute('data-vault-state', 'unlocked');
});
test('[SEC-08/SEC-09] unencrypted local PDF opens without a master prompt or password dialog', async ({ extension }) => {
  await extension.seed(); await seedVault(extension); const page = await extension.openBrowser(); await openLesson(page);
  await expect(page.getByRole('dialog', { name: /password vault|PDF password/i })).toHaveCount(0);
  await expect(page.locator('#viewer .page')).toHaveCount(2);
});
test('[SEC-07/SEC-08/SEC-09] locked PDF offers unlock and resumes real PDF.js automatic input after the master is entered', async ({ extension }) => {
  const encrypted = await extension.seed(); await seedVault(extension, payload({ records: [record('right', encrypted.password)], remembered: {} }));
  const page = await extension.openBrowser(); await filter(page, 'locked'); await page.keyboard.press('Enter');
  const pdfDialog = modal(page, 'PDF password'); await expect(pdfDialog).toBeVisible();
  await pdfDialog.getByRole('button', { name: 'Unlock vault', exact: true }).click();
  const dialog = modal(page, 'Unlock password vault'); await masterInput(dialog).focus();
  await page.keyboard.type('r/a?jgg'); await expect(masterInput(dialog)).toHaveValue('r/a?jgg');
  await expect(dialog).toBeVisible(); await expect(page.getByTestId('browser-filter')).toHaveValue('locked');
  await masterInput(dialog).fill(master); await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden(); await expect(pdfDialog).toBeHidden(); await expect(page.locator('#viewer .page')).toHaveCount(1);
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
});
test('[SEC-08] encrypted PDF can still be opened manually without saving while the vault stays locked', async ({ extension }) => {
  const encrypted = await extension.seed(); const cipher = await seedVault(extension); const page = await extension.openBrowser();
  await filter(page, 'locked'); await page.keyboard.press('Enter'); const dialog = modal(page, 'PDF password');
  await dialog.locator('[name="password"]').fill(encrypted.password);
  await expect(dialog.locator('[name="remember"]')).not.toBeChecked(); await page.keyboard.press('Enter');
  await expect(page.locator('#viewer .page')).toHaveCount(1); expect((await allData(extension)).local[v2]).toEqual(cipher);
  await extension.setupPage.reload(); await expect(section(extension.setupPage)).toHaveAttribute('data-vault-state', 'locked');
});
test('[SEC-08/SEC-09] cancelling master unlock returns to the PDF password input and manual opening still works', async ({ extension }) => {
  const encrypted = await extension.seed(); const cipher = await seedVault(extension); const page = await extension.openBrowser();
  await filter(page, 'locked'); await page.keyboard.press('Enter'); const pdfDialog = modal(page, 'PDF password');
  await pdfDialog.getByRole('button', { name: 'Unlock vault', exact: true }).click();
  const dialog = modal(page, 'Unlock password vault'); await masterInput(dialog).fill(master); await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden(); await expect(pdfDialog).toBeVisible(); await expect(pdfDialog.locator('[name="password"]')).toBeFocused();
  await pdfDialog.locator('[name="password"]').fill(encrypted.password); await page.keyboard.press('Enter');
  await expect(page.locator('#viewer .page')).toHaveCount(1); expect((await allData(extension)).local[v2]).toEqual(cipher);
});

test('[SEC-10/SEC-12] locked backup downloads real ciphertext and releases the temporary object URL', async ({ extension }) => {
  const cipher = await seedVault(extension); const page = extension.setupPage; const before = await allData(extension); await observeOutput(page);
  const out = await downloaded(page, () => page.locator('#passwordBackup').click());
  expect(JSON.parse(out.text)).toEqual(cipher); expect(out.filename).toMatch(/^vimdf-passwords-\d{8}-\d{6}\.vimdf-vault\.json$/);
  await expect(section(page)).toHaveAttribute('data-vault-state', 'locked'); await expect(modal(page, 'Unlock password vault')).toHaveCount(0);
  expect(await allData(extension)).toEqual(before);
  await expect.poll(() => page.evaluate(() => window.__vaultRevokedUrls.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__vaultObjectUrls.every(url => window.__vaultRevokedUrls.includes(url)))).toBe(true);
});
test('[SEC-16/SEC-18/SEC-19] plaintext download requires fresh input every time and exports exact JSON values without document links', async ({ extension }) => {
  const value = payload(); await seedVault(extension, value); const page = extension.setupPage; await unlock(page); await observeOutput(page);
  const dialog = await plainDialog(page); await expect(dialog).toContainText(/readable|plain.?text|unencrypted/i);
  await expect(masterInput(dialog)).toHaveValue(''); expect(await page.evaluate(() => window.__vaultBlobCount)).toBe(0);
  await masterInput(dialog).fill(master);
  const out = await downloaded(page, () => dialog.getByRole('button', { name: 'Export plaintext', exact: true }).click());
  expect(out.filename).toMatch(/\.plaintext\.json$/);
  expect(JSON.parse(out.text)).toEqual({ format: 'vimdf-password-export', version: 1,
    records: value.records.map(({ name, password, enabled, shared }) => ({ name, password, enabled, shared })) });
  expect(out.text).not.toContain(master); expect(out.text).not.toContain(documentKey);
  await expect.poll(() => page.evaluate(() => window.__vaultRevokedUrls.length)).toBeGreaterThan(0);
  const again = await plainDialog(page); await expect(masterInput(again)).toHaveValue(''); await page.keyboard.press('Escape');
});
for (const cancel of ['Escape', 'button']) {
  test(`[SEC-16/SEC-19] ${cancel} cancels plaintext export before any Blob or download and restores focus`, async ({ extension }) => {
    await seedVault(extension); const page = extension.setupPage; await unlock(page); const before = await allData(extension); await observeOutput(page);
    const downloads = []; page.on('download', d => downloads.push(d)); const dialog = await plainDialog(page); await masterInput(dialog).fill(master);
    if (cancel === 'Escape') await page.keyboard.press('Escape'); else await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden(); await expect(page.locator('#passwordExportPlaintext')).toBeFocused();
    expect(await page.evaluate(() => window.__vaultBlobCount)).toBe(0); expect(downloads).toHaveLength(0); expect(await allData(extension)).toEqual(before);
  });
}
test('[SEC-16/SEC-19] wrong export master reveals no secret in errors and creates no plaintext Blob or download', async ({ extension }) => {
  await seedVault(extension); const page = extension.setupPage; await unlock(page); await observeOutput(page);
  const before = await allData(extension), downloads = [], logs = []; page.on('download', d => downloads.push(d));
  page.on('console', m => logs.push(m.text())); page.on('pageerror', e => logs.push(e.message));
  const dialog = await plainDialog(page); await masterInput(dialog).fill(nextMaster);
  await dialog.getByRole('button', { name: 'Export plaintext', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(/password|corrupt|unable|invalid/i);
  expect(await dialog.textContent()).not.toContain(nextMaster); expect(logs.join('\n')).not.toContain(nextMaster);
  expect(await page.evaluate(() => window.__vaultBlobCount)).toBe(0); expect(downloads).toHaveLength(0); expect(await allData(extension)).toEqual(before);
});
test('[SEC-13/SEC-15] restore into an empty profile previews before saving and never requests folder permissions', async ({ extension }) => {
  await extension.seed(); const page = extension.setupPage; const registry = await extension.registry();
  const cipher = await seal(); const dialog = await restoreDialog(page, cipher);
  await expect(dialog).toContainText(/2/); expect((await allData(extension)).local[v2]).toBeUndefined();
  await dialog.getByRole('button', { name: 'Restore vault', exact: true }).click();
  await expect(dialog).toBeHidden(); await expect(section(page)).toHaveAttribute('data-vault-state', 'locked');
  await unlock(page); await expect(section(page).locator('.password-record')).toHaveCount(2);
  expect(await extension.registry()).toEqual(registry); expect(await page.evaluate(() => window.__permissionCalls)).toEqual([]);
});
test('[SEC-14] wrong backup password, cancelled replacement and actual storage quota failure preserve the old vault', async ({ extension }) => {
  await seedVault(extension); const page = extension.setupPage; await unlock(page); const before = await allData(extension);
  const incoming = await seal(payload({ records: [record('new', 'incoming-only')], remembered: {} }), nextMaster);
  let dialog = await restoreDialog(page, incoming, master); await expect(dialog.getByRole('alert')).toContainText(/password|corrupt|unable|invalid/i);
  expect(await allData(extension)).toEqual(before); await page.keyboard.press('Escape');
  dialog = await restoreDialog(page, incoming, nextMaster); await expect(dialog).toContainText(/replace|overwrite/i);
  await page.keyboard.press('Escape'); expect(await allData(extension)).toEqual(before);
  await page.evaluate(key => { const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = items => key in items ? Promise.reject(new Error('fixture quota')) : set(items); }, v2);
  dialog = await restoreDialog(page, incoming, nextMaster); await dialog.getByRole('button', { name: 'Restore vault', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(/fail|unable|quota|save/i); expect(await allData(extension)).toEqual(before);
});
test('[SEC-20] changing the master locks separately unlocked Options pages and preserves old backup semantics', async ({ extension }) => {
  await seedVault(extension); const page = extension.setupPage; await unlock(page);
  const second = await extension.context.newPage(); await second.goto(extension.url('src/options/options.html')); await unlock(second);
  await page.locator('#passwordChangeMaster').click(); const dialog = modal(page, 'Change master password');
  await expect(dialog).toContainText(/backup/i); await dialog.getByLabel('Current master password', { exact: true }).fill(master);
  await dialog.getByLabel('New master password', { exact: true }).fill(nextMaster);
  await dialog.getByLabel('Confirm new master password', { exact: true }).fill(nextMaster);
  await dialog.getByRole('button', { name: 'Change master password', exact: true }).click();
  await expect(dialog).toBeHidden(); await expect(section(page)).toHaveAttribute('data-vault-state', 'locked');
  await expect(section(second)).toHaveAttribute('data-vault-state', 'locked'); await expect(section(second).locator('.password-record')).toHaveCount(0);
  await unlock(page, nextMaster); await expect(section(page).locator('.password-record')).toHaveCount(2);
});
test('[SEC-21] legacy records are hidden until explicit migration verifies encryption and removes plaintext', async ({ extension }) => {
  const value = payload(); await extension.setupPage.evaluate(({ key, value }) => chrome.storage.local.set({ [key]: value }), { key: v1, value });
  const page = extension.setupPage; await page.reload(); await expect(section(page).locator('.password-record')).toHaveCount(0);
  await expect(section(page)).toHaveAttribute('data-vault-state', 'legacy'); await page.locator('#passwordMigrate').click();
  const dialog = modal(page, 'Migrate password vault'); await masterInput(dialog).fill(master); await confirmInput(dialog).fill(master);
  await dialog.getByRole('button', { name: 'Encrypt saved passwords', exact: true }).click();
  await expect(dialog).toBeHidden(); const saved = await allData(extension); expect(saved.local[v1]).toBeUndefined();
  expect(await unseal(saved.local[v2])).toEqual(value); expect(JSON.stringify(saved)).not.toContain(value.records[0].password);
});
test('[SEC-21] plaintext-deletion failure reports incomplete migration and exposes neither registrations nor export', async ({ extension }) => {
  await extension.setupPage.evaluate(({ key, value }) => chrome.storage.local.set({ [key]: value }), { key: v1, value: payload() });
  const page = extension.setupPage; await page.reload(); await page.evaluate(key => {
    const remove = chrome.storage.local.remove.bind(chrome.storage.local);
    chrome.storage.local.remove = keys => (typeof keys === 'string' ? [keys] : keys).includes(key)
      ? Promise.reject(new Error('fixture plaintext deletion failed')) : remove(keys);
  }, v1);
  await page.locator('#passwordMigrate').click(); const dialog = modal(page, 'Migrate password vault');
  await masterInput(dialog).fill(master); await confirmInput(dialog).fill(master);
  await dialog.getByRole('button', { name: 'Encrypt saved passwords', exact: true }).click();
  await expect.poll(async () => `${await status(page).textContent()} ${(await dialog.getByRole('alert').allTextContents()).join(' ')}`)
    .toMatch(/plain|incomplete|fail|remaining/i);
  const saved = await allData(extension); expect(saved.local[v1]).toBeDefined(); expect(saved.local[v2]).toBeDefined();
  await expect(page.locator('#passwordBackup')).toBeDisabled(); await expect(page.locator('#passwordExportPlaintext')).toBeDisabled();
  await expect(section(page).locator('.password-record')).toHaveCount(0);
});
test('[SEC-23] forgotten-master reset affects only the vault, preserving native files, registered folders and PDF/CSS state', async ({ extension }) => {
  await extension.seed(); await savedPdfData(extension); await seedVault(extension);
  const page = extension.setupPage, before = await allData(extension), registry = await extension.registry(), bytes = await nativePdf(extension);
  await page.locator('#passwordResetVault').click(); const dialog = modal(page, 'Reset password vault');
  await expect(dialog).toContainText(/cannot|lost|irreversible|recover/i); await expect(dialog.getByLabel('Master password', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Reset vault', exact: true }).click(); await expect(dialog).toBeHidden();
  await expect(section(page)).toHaveAttribute('data-vault-state', 'uninitialized'); delete before.local[v2];
  expect(await allData(extension)).toEqual(before); expect(await extension.registry()).toEqual(registry); expect(await nativePdf(extension)).toEqual(bytes);
});
test('[SEC-24] controlled incognito boundary disables vault operations without reading normal-profile secrets', async ({ extension }) => {
  await seedVault(extension); await extension.context.addInitScript(({ v1, v2 }) => {
    Object.defineProperty(chrome.extension, 'inIncognitoContext', { value: true }); window.__normalVaultReads = [];
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = keys => {
      const names = keys == null ? [v1, v2] : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      if (names.includes(v1) || names.includes(v2)) window.__normalVaultReads.push(keys);
      return get(keys);
    };
  }, { v1, v2 });
  const page = extension.setupPage; await page.reload(); await expect(section(page)).toHaveAttribute('data-vault-state', 'incognito');
  await expect(status(page)).toContainText(/incognito/i); expect(await page.evaluate(() => window.__normalVaultReads)).toEqual([]);
  for (const id of ['passwordCreateVault', 'passwordUnlockVault', 'passwordBackup', 'passwordRestore', 'passwordExportPlaintext', 'passwordChangeMaster', 'passwordResetVault', 'passwordMigrate'])
    await expect(page.locator(`#${id}`)).toBeDisabled();
});

test('[SEC-12] backup read failure produces no download, leaves stored data intact and reports failure', async ({ extension }) => {
  await seedVault(extension); const page = extension.setupPage; const before = await allData(extension); await observeOutput(page);
  const downloads = []; page.on('download', d => downloads.push(d));
  await page.evaluate(key => {
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = keys => keys === key || keys == null || Array.isArray(keys) && keys.includes(key)
      ? Promise.reject(new Error('fixture backup read failed')) : get(keys);
    window.__restoreVaultRead = () => { chrome.storage.local.get = get; };
  }, v2);
  await page.locator('#passwordBackup').click(); await expect(status(page)).toContainText(/fail|unable|could not|read/i);
  expect(downloads).toHaveLength(0); expect(await page.evaluate(() => window.__vaultBlobCount)).toBe(0);
  await page.evaluate(() => window.__restoreVaultRead()); expect(await allData(extension)).toEqual(before);
});
test('[SEC-19] output failure consumes plaintext authorization, reports unsaved output and requires fresh input on retry', async ({ extension }) => {
  await seedVault(extension); const page = extension.setupPage; await unlock(page); const before = await allData(extension);
  await observeOutput(page); await page.evaluate(() => {
    window.__restoreVaultOutput = URL.createObjectURL;
    URL.createObjectURL = () => { throw new Error('fixture output unavailable'); };
  });
  const downloads = []; page.on('download', d => downloads.push(d)); const dialog = await plainDialog(page);
  await masterInput(dialog).fill(master); await dialog.getByRole('button', { name: 'Export plaintext', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(/fail|unable|could not|output/i);
  await expect(masterInput(dialog)).toHaveValue(''); expect(downloads).toHaveLength(0); expect(await allData(extension)).toEqual(before);
  await page.evaluate(() => { URL.createObjectURL = window.__restoreVaultOutput; }); await page.keyboard.press('Escape');
  const again = await plainDialog(page); await expect(masterInput(again)).toHaveValue(''); await masterInput(again).fill(master);
  const out = await downloaded(page, () => again.getByRole('button', { name: 'Export plaintext', exact: true }).click());
  expect(JSON.parse(out.text).records).toHaveLength(2);
});
test('[SEC-06] locking the vault in Options preserves an already rendered PDF and its page position', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await openLesson(page);
  await page.keyboard.press('2'); await page.keyboard.press('G'); await expect(page.locator('#statusLeft')).toContainText('Page 2 / 2');
  await create(extension.setupPage); await register(extension.setupPage); await extension.setupPage.locator('#passwordLockVault').click();
  await expect(section(extension.setupPage)).toHaveAttribute('data-vault-state', 'locked');
  await expect(page.locator('#viewer .page')).toHaveCount(2); await expect(page.locator('#statusLeft')).toContainText('Page 2 / 2');
});

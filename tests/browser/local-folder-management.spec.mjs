import { test, expect, filter, openLesson, rootA, rootB, pdfIdentity } from './extension-fixture.mjs';
import { lessonPdf } from '../helpers/pdf-bytes.mjs';

const screen = page => page.getByTestId('local-browser');
const dialog = page => page.getByRole('dialog', { name: 'Unregister folder?' });
const row = (page, name) => page.getByRole('option', { name, exact: true });
const unregister = option => option.getByRole('button', { name: /^Unregister / });

async function roots(page) {
  await expect(screen(page)).toHaveAttribute('data-busy', 'false');
  await page.locator('[data-action="roots"]').click();
  await expect(screen(page)).toHaveAttribute('data-view', 'roots');
  await expect(screen(page)).toHaveAttribute('data-busy', 'false');
}

async function confirm(page, option) {
  await unregister(option).click(); await expect(dialog(page)).toBeVisible();
  await dialog(page).locator('[data-action="confirm-remove"]').click();
  await expect(screen(page)).toHaveAttribute('data-busy', 'false');
}

async function nativeFiles(extension) {
  return extension.setupPage.evaluate(async () => {
    const opfs = await navigator.storage.getDirectory();
    const paths = [['University', 'z.pdf'], ['Books', 'lesson.pdf']];
    return Promise.all(paths.map(async ([folder, name]) => {
      const dir = await opfs.getDirectoryHandle(folder);
      const file = await (await dir.getFileHandle(name)).getFile();
      return { folder, name: file.name, bytes: [...new Uint8Array(await file.arrayBuffer())] };
    }));
  });
}

async function savedData(extension) {
  return extension.setupPage.evaluate(async () => ({
    local: await chrome.storage.local.get(null), sync: await chrome.storage.sync.get(null),
  }));
}

test('[FM-01/FM-04/FM-05] same-name folders have distinct accessible identities and filtering unregisters only the confirmed ID', async ({ extension }) => {
  await extension.seed({ sameNames: true }); const page = await extension.openBrowser(); await roots(page);
  const before = await extension.registry(); const options = page.getByRole('option');
  await expect(options).toHaveCount(2);
  const names = await options.evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')));
  expect(new Set(names).size).toBe(2);
  for (const option of [options.nth(0), options.nth(1)]) {
    await expect(option).toContainText('Documents'); await expect(unregister(option)).toBeVisible();
  }
  await expect(options.nth(0)).toContainText(/Default/i);
  await expect(options.nth(1)).not.toContainText(/Default/i);
  await filter(page, 'documents'); await options.nth(1).click();
  expect(await extension.registry()).toEqual(before);
  await unregister(options.nth(1)).click();
  await expect(dialog(page)).toContainText(rootB); await expect(dialog(page)).not.toContainText(rootA);
  expect(await extension.registry()).toEqual(before);
  await dialog(page).locator('[data-action="confirm-remove"]').click();
  await expect.poll(async () => (await extension.registry()).roots.map(root => root.id)).toEqual([rootA]);
  expect((await extension.registry()).primaryId).toBe(rootA);
  await page.reload(); await roots(page); await expect(page.getByRole('option')).toHaveCount(1);
});

for (const cancel of ['button', 'Escape']) {
  test(`[FM-04/FM-08] ${cancel} cancels unregister without changes and returns keyboard focus to the filtered list`, async ({ extension }) => {
    await extension.seed(); const page = await extension.openBrowser(); await roots(page); await filter(page, 'books');
    const before = await extension.registry();
    await unregister(row(page, 'Books')).click();
    await expect(dialog(page)).toContainText(rootB);
    await expect(dialog(page).locator('[data-action="cancel-remove"]')).toBeFocused();
    for (const key of ['j', 'k', 'g', 'a', '/']) await page.keyboard.press(key);
    await expect(dialog(page)).toBeVisible(); expect(await extension.registry()).toEqual(before);
    await expect(page.getByTestId('browser-filter')).toHaveValue('books');
    if (cancel === 'Escape') await page.keyboard.press('Escape');
    else await dialog(page).locator('[data-action="cancel-remove"]').click();
    await expect(dialog(page)).toBeHidden(); await expect(page.getByRole('listbox')).toBeFocused();
    await expect(row(page, 'Books')).toHaveAttribute('aria-selected', 'true');
    expect(await extension.registry()).toEqual(before);
    expect(await page.evaluate(() => ({ picks: window.__pickerCalls, permissions: window.__permissionCalls })))
      .toEqual({ picks: [], permissions: [] });
  });
}

test('[FM-04/FM-05] primary unregister confirmation explains which remaining folder becomes the default', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await roots(page);
  const before = await extension.registry(); await unregister(row(page, 'University')).click();
  await expect(dialog(page)).toContainText(rootA);
  await expect(dialog(page)).toContainText(/(?:default|primary|starting folder).*Books|Books.*(?:default|primary|starting folder)/i);
  expect(await extension.registry()).toEqual(before);
});

test('[FM-04/FM-05] the last-folder confirmation explains the resulting unregistered state before any save', async ({ extension }) => {
  await extension.seed({ singleRoot: true }); const page = await extension.openBrowser(); await roots(page);
  const before = await extension.registry(); await unregister(row(page, 'University')).click();
  await expect(dialog(page)).toContainText(rootA);
  await expect(dialog(page)).toContainText(/(?:no|zero).*(?:registered|folders)|unregistered|empty registry|last.*(?:folder|registration)/i);
  expect(await extension.registry()).toEqual(before);
});

test('[FM-05/FM-06] individual unregister preserves actual file bytes, every other registration, PDF stores and both settings stores', async ({ extension }) => {
  await extension.seed(); await extension.configureLauncher();
  await extension.setupPage.evaluate(async identity => {
    await chrome.storage.sync.set({ theme: 'dark', scrollStep: 113, rememberLastPage: true });
    await chrome.storage.local.set({
      [`vimdf:state:${identity}`]: { page: 2, scrollTop: 42 },
      [`vimdf:marks:${identity}`]: { a: { page: 2, x: 0, y: 100 } },
      [`vimdf:highlights:${identity}`]: [{ id: 'retained-highlight', page: 1, color: '#ff0000', rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.1 }] }],
      'vimdf.passwords.v1': { version: 1, autoFill: true,
        records: [{ id: 'retained-password', name: 'Test PDF', password: 'fixture-password', enabled: true, shared: false }],
        remembered: { [identity]: 'retained-password' } },
    });
  }, pdfIdentity);
  const page = await extension.openBrowser(); await roots(page);
  const before = await extension.registry(); const files = await nativeFiles(extension); const metadata = await savedData(extension);
  await confirm(page, row(page, 'Books'));
  const after = await extension.registry();
  expect(after).toEqual({ revision: before.revision + 1, primaryId: rootA, roots: [before.roots[0]] });
  expect(await savedData(extension)).toEqual(metadata); expect(await nativeFiles(extension)).toEqual(files);
  await page.reload(); await expect(screen(page)).toHaveAttribute('data-view', 'browse');
  expect(await extension.registry()).toEqual(after);
});

test('[FM-04/FM-05] unregistering a revoked primary chooses the first remaining root without querying, prompting or enumerating', async ({ extension }) => {
  await extension.seed({ extraRoots: 1 }); const page = await extension.openBrowser(); await roots(page);
  const before = await extension.registry();
  await page.evaluate(() => {
    window.__permission = 'denied'; window.__permissionCalls = []; window.__unregisterIO = [];
    const query = FileSystemHandle.prototype.queryPermission;
    FileSystemHandle.prototype.queryPermission = function (...args) { window.__unregisterIO.push('query'); return query.apply(this, args); };
    const values = FileSystemDirectoryHandle.prototype.values;
    FileSystemDirectoryHandle.prototype.values = function (...args) { window.__unregisterIO.push('values'); return values.apply(this, args); };
  });
  await confirm(page, row(page, 'University'));
  expect(await extension.registry()).toEqual({ revision: before.revision + 1, primaryId: rootB, roots: before.roots.slice(1) });
  await expect(screen(page)).toHaveAttribute('data-view', 'roots'); await expect(row(page, 'Books')).toContainText(/Default/i);
  expect(await page.evaluate(() => ({ io: window.__unregisterIO, permissions: window.__permissionCalls, picks: window.__pickerCalls })))
    .toEqual({ io: [], permissions: [], picks: [] });
});

test('[FM-05] confirming the last unregister clears only the registry and does not automatically open a picker', async ({ extension }) => {
  await extension.seed({ singleRoot: true }); const page = await extension.openBrowser(); await roots(page);
  const before = await extension.registry(); const files = await nativeFiles(extension);
  await confirm(page, row(page, 'University'));
  await expect(screen(page)).toHaveAttribute('data-view', 'empty'); await expect(page.getByRole('option')).toHaveCount(0);
  expect(await extension.registry()).toEqual({ revision: before.revision + 1, primaryId: null, roots: [] });
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]); expect(await nativeFiles(extension)).toEqual(files);
});

test('[FM-07] a native transaction abort after put success retains registrations and Escape return state, then permits a fresh retry', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser();
  await filter(page, 'course'); await page.keyboard.press('Enter'); await filter(page, 'lesson'); await roots(page);
  const before = await extension.registry();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put; window.__removalAborted = false;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (this.name === 'registry' && !window.__removalAborted) request.addEventListener('success', () => {
        window.__removalAborted = true; this.transaction.abort();
      }, { once: true });
      return request;
    };
  });
  await confirm(page, row(page, 'University')); await expect(page.getByRole('alert')).toBeVisible();
  expect(await page.evaluate(() => window.__removalAborted)).toBe(true); expect(await extension.registry()).toEqual(before);
  await expect(page.getByRole('option')).toHaveCount(2); await page.keyboard.press('Escape');
  await expect(screen(page)).toHaveAttribute('data-view', 'browse'); await expect(page.getByTestId('browser-location')).toContainText('course');
  await expect(page.getByTestId('browser-filter')).toHaveValue('lesson');
  await expect(row(page, 'lesson.pdf')).toHaveAttribute('aria-selected', 'true');
  await roots(page); await confirm(page, row(page, 'University'));
  expect((await extension.registry()).roots.map(root => root.id)).toEqual([rootB]);
  expect((await extension.registry()).revision).toBe(before.revision + 1);
});

test('[FM-05/FM-08] an in-flight native save keeps the old rows visible and blocks duplicate keys and buttons until commit', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await roots(page); const before = await extension.registry();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put; window.__holdRegistrySave = true; window.__registryPuts = 0;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (this.name === 'registry') {
        window.__registryPuts++;
        request.addEventListener('success', () => {
          // Keep the real transaction pending through native requests, rather
          // than replacing save() or faking the app's busy/publication state.
          const store = this;
          function hold() {
            const read = store.get('__test_pending_commit__');
            read.onsuccess = () => { if (window.__holdRegistrySave) hold(); };
          }
          if (window.__holdRegistrySave) hold();
        }, { once: true });
      }
      return request;
    };
  });
  await unregister(row(page, 'University')).click();
  await dialog(page).locator('[data-action="confirm-remove"]').click();
  try {
    await expect(screen(page)).toHaveAttribute('data-busy', 'true');
    await expect(page.getByRole('option')).toHaveCount(2); await expect(row(page, 'University')).toContainText(/Default/i);
    await expect(unregister(row(page, 'University'))).toBeDisabled(); await expect(unregister(row(page, 'Books'))).toBeDisabled();
    await expect(page.locator('[data-action="add"]')).toBeDisabled();
    for (const key of ['Enter', 'Enter', 'a', 'j', 'l']) await page.keyboard.press(key);
    expect(await page.evaluate(() => ({ puts: window.__registryPuts, picks: window.__pickerCalls, permissions: window.__permissionCalls })))
      .toEqual({ puts: 1, picks: [], permissions: [] });
    await expect(page.getByRole('option')).toHaveCount(2);
  } finally { await page.evaluate(() => { window.__holdRegistrySave = false; }); }
  await expect(screen(page)).toHaveAttribute('data-busy', 'false');
  expect(await extension.registry()).toEqual({ revision: before.revision + 1, primaryId: rootB, roots: before.roots.slice(1) });
});

test('[FM-07/FM-08] another tab changing registrations invalidates an open confirmation until explicit reload and reselection', async ({ extension }) => {
  await extension.seed(); const a = await extension.openBrowser(); const b = await extension.openBrowser();
  await roots(a); await unregister(row(a, 'Books')).click(); await expect(dialog(a)).toContainText(rootB);
  await roots(b); await confirm(b, row(b, 'University'));
  await expect(a.getByTestId('registry-stale')).toBeVisible(); const committed = await extension.registry();
  const commit = dialog(a).locator('[data-action="confirm-remove"]');
  // Either disabling or dismissing stale confirmation is valid; an enabled
  // old confirmation must also be unable to mutate the newly committed state.
  if (await commit.isEnabled()) await commit.click();
  else { await expect(commit).toBeDisabled(); await a.keyboard.press('Escape'); }
  expect(await extension.registry()).toEqual(committed);
  if (await dialog(a).isVisible()) await a.keyboard.press('Escape');
  await expect(unregister(row(a, 'Books'))).toBeDisabled();
  await a.locator('[data-action="reload-registry"]').click();
  await expect(screen(a)).toHaveAttribute('data-view', 'browse'); await roots(a);
  await expect(a.getByRole('option')).toHaveCount(1); await confirm(a, row(a, 'Books'));
  expect(await extension.registry()).toEqual({ revision: committed.revision + 1, primaryId: null, roots: [] });
});

test('[FM-08] Tab and Enter invoke the row button once without opening a folder or changing the primary', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await roots(page);
  const before = await extension.registry(); await page.getByRole('listbox').focus(); await page.keyboard.press('Tab');
  await expect(unregister(row(page, 'University'))).toBeFocused(); await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible(); await expect(dialog(page)).toContainText(rootA);
  expect(await extension.registry()).toEqual(before); await expect(screen(page)).toHaveAttribute('data-view', 'roots');
  await page.keyboard.press('Tab'); await expect(dialog(page).locator('[data-action="confirm-remove"]')).toBeFocused();
  await page.keyboard.press('Enter'); await expect(screen(page)).toHaveAttribute('data-busy', 'false');
  expect(await extension.registry()).toEqual({ revision: before.revision + 1, primaryId: rootB, roots: before.roots.slice(1) });
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
});

test('[FM-02/FM-03] adding with a preserves the default, and picking a registered directory again preserves IDs and revision', async ({ extension }) => {
  await extension.seed(); const page = await extension.openBrowser(); await roots(page);
  const before = await extension.registry(); await page.keyboard.press('a');
  await expect(screen(page)).toHaveAttribute('data-busy', 'false'); expect(await extension.registry()).toEqual(before);
  await page.evaluate(() => { window.__pickerName = 'Additional'; }); await page.keyboard.press('a');
  await expect.poll(async () => (await extension.registry()).roots.length).toBe(3);
  await expect(screen(page)).toHaveAttribute('data-busy', 'false');
  const added = await extension.registry(); expect(added.primaryId).toBe(rootA); expect(added.revision).toBe(before.revision + 1);
  expect(added.roots.slice(0, 2)).toEqual(before.roots);
  await expect(row(page, 'Additional')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await extension.registry()).primaryId).toBe(added.roots[2].id);
});

test('[FM-06/FM-07] unregister in another tab keeps the already loaded PDF and its marks, while further reads require reload', async ({ extension }) => {
  await extension.seed(); const reader = await extension.openBrowser(); await openLesson(reader);
  await reader.keyboard.press('2'); await reader.keyboard.press('G'); await reader.keyboard.press('m'); await reader.keyboard.press('a');
  const mark = () => reader.evaluate(async identity => (await chrome.storage.local.get(`vimdf:marks:${identity}`))[`vimdf:marks:${identity}`]?.a, pdfIdentity);
  await expect.poll(mark).toMatchObject({ page: 2 }); const before = await mark();
  const manager = await extension.openBrowser(); await roots(manager); await confirm(manager, row(manager, 'University'));
  await expect(screen(reader)).toHaveAttribute('data-mode', 'pdf'); await expect(reader.locator('#viewer .page')).toHaveCount(2);
  await expect(reader.locator('#statusLeft')).toContainText('Page 2 / 2'); expect(await mark()).toEqual(before);
  await reader.keyboard.press('H'); await expect(reader.getByTestId('registry-stale')).toBeVisible();
  await expect(screen(reader)).toHaveAttribute('data-busy', 'false'); await reader.keyboard.press('Enter');
  await expect(screen(reader)).toHaveAttribute('data-mode', 'files');
  await reader.locator('[data-action="reload-registry"]').click();
  await expect(reader.getByTestId('browser-location')).toContainText('Books'); expect(await mark()).toEqual(before);
});

test('[FM-06] re-registering a removed directory creates a new PDF identity without deleting or reusing the old mark', async ({ extension }) => {
  await extension.seed({ singleRoot: true }); const page = await extension.openBrowser(); await openLesson(page);
  await page.keyboard.press('2'); await page.keyboard.press('G'); await page.keyboard.press('m'); await page.keyboard.press('a');
  await expect.poll(() => page.evaluate(async identity => (await chrome.storage.local.get(`vimdf:marks:${identity}`))[`vimdf:marks:${identity}`]?.a?.page, pdfIdentity)).toBe(2);
  await page.keyboard.press('H'); await expect(screen(page)).toHaveAttribute('data-mode', 'files');
  await roots(page); await confirm(page, row(page, 'University'));
  await expect(screen(page)).toHaveAttribute('data-view', 'empty'); await page.keyboard.press('a');
  await expect(screen(page)).toHaveAttribute('data-view', 'browse'); await expect(screen(page)).toHaveAttribute('data-busy', 'false');
  const registered = await extension.registry(); expect(registered.roots).toHaveLength(1);
  expect(registered.roots[0].id).not.toBe(rootA);
  await openLesson(page); await expect(page.locator('#statusLeft')).toContainText('Page 1 / 2');
  await page.keyboard.press("'"); await page.keyboard.press('a'); await expect(page.locator('#statusCenter')).toContainText(/mark a not set/i);
  const identity = `https://local-pdf.vimdf.invalid/${registered.roots[0].id}/course/lesson.pdf`;
  const saved = await page.evaluate(async ({ original, next }) => chrome.storage.local.get([`vimdf:marks:${original}`, `vimdf:marks:${next}`]), { original: pdfIdentity, next: identity });
  expect(saved[`vimdf:marks:${pdfIdentity}`].a.page).toBe(2); expect(saved[`vimdf:marks:${identity}`]).toBeUndefined();
});

test('[FM-07/UI-02] a corrupt restored registry remains intact and locked while normal PDF selection still works', async ({ extension }) => {
  await extension.seed();
  await extension.setupPage.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('vimdf.local-browser', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('registry', 'readwrite'); const store = tx.objectStore('registry'); const r = store.get('state');
        r.onsuccess = () => { const envelope = r.result; envelope.state.primaryId = 'missing-root'; store.put(envelope, 'state'); };
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  });
  const before = await extension.registry(); const page = await extension.openBrowser();
  await expect(page.getByRole('alert')).toContainText(/invalid.*primary|primary.*invalid/i);
  await expect(page.locator('[data-action="add"]')).toBeDisabled(); await expect(page.locator('[data-action="roots"]')).toBeDisabled();
  await expect(page.locator('[data-action="pick-file"]')).toBeVisible();
  await page.locator('#fallback-file').setInputFiles({ name: 'picked.pdf', mimeType: 'application/pdf', buffer: Buffer.from(lessonPdf()) });
  await expect(screen(page)).toHaveAttribute('data-mode', 'pdf'); await expect(page.locator('#viewer .page')).toHaveCount(2);
  await page.keyboard.press('H'); expect(await extension.registry()).toEqual(before);
  expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
});

test('[FM-06/UI-02] API-unavailable file selection preserves existing registered handles and the primary', async ({ extension }) => {
  await extension.seed(); const before = await extension.registry();
  await extension.context.addInitScript(() => { Object.defineProperty(window, 'showDirectoryPicker', { value: undefined }); });
  const page = await extension.openBrowser(); await expect(page.locator('[data-action="pick-file"]')).toBeVisible();
  await page.locator('#fallback-file').setInputFiles({ name: 'picked.pdf', mimeType: 'application/pdf', buffer: Buffer.from(lessonPdf()) });
  await expect(screen(page)).toHaveAttribute('data-mode', 'pdf'); await expect(page.locator('#viewer .page')).toHaveCount(2);
  await page.keyboard.press('H'); await expect(page.locator('[data-action="pick-file"]')).toBeVisible();
  expect(await extension.registry()).toEqual(before); expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
});

test('[FM-01/EXT-01] Options launches working folder management and PDF keys with the Vimium-C connection disabled', async ({ extension }) => {
  await extension.seed(); await extension.configureLauncher(false, []); await extension.setupPage.reload();
  const before = await savedData(extension);
  const [page] = await Promise.all([extension.context.waitForEvent('page'), extension.setupPage.getByRole('button', { name: 'Open local PDF browser', exact: true }).click()]);
  await expect(page).toHaveURL(extension.url('src/local-browser/browser.html'));
  await expect(screen(page)).toHaveAttribute('data-view', 'browse'); expect(await page.evaluate(() => window.__pickerCalls)).toEqual([]);
  await roots(page); await expect(unregister(row(page, 'University'))).toBeVisible();
  await page.keyboard.press('Escape'); await openLesson(page);
  await page.keyboard.press('/'); await page.locator('#searchInput').fill('needle'); await page.keyboard.press('Enter');
  await expect(page.locator('#searchStatus')).toContainText('2');
  expect((await savedData(extension)).local['vimdf.localBrowser.launcher.v1']).toEqual(before.local['vimdf.localBrowser.launcher.v1']);
});

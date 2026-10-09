import { test as base, expect, chromium } from 'playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, platform, release, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lessonPdf } from '../helpers/pdf-bytes.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export const rootA = '00000000-0000-4000-8000-000000000001';
export const rootB = '00000000-0000-4000-8000-000000000002';
export const pdfIdentity = `https://local-pdf.vimdf.invalid/${rootA}/course/lesson.pdf`;

export const test = base.extend({
  extension: async ({}, use, testInfo) => {
    const dist = resolve(repository, 'dist');
    const caller = resolve(repository, 'tests/browser/caller');
    if (!existsSync(join(dist, 'manifest.json'))) throw new Error('Run npm run build before the browser suite');
    const profile = await mkdtemp(join(tmpdir(), 'vimdf-tests-'));
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
        args: [`--disable-extensions-except=${dist},${caller}`, `--load-extension=${dist},${caller}`] });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const isCaller = worker => new URL(worker.url()).pathname === '/caller.js';
      let worker = context.serviceWorkers().find(worker => !isCaller(worker));
      worker ??= await context.waitForEvent('serviceworker', { predicate: worker => !isCaller(worker) });
      let callerWorker = context.serviceWorkers().find(isCaller);
      callerWorker ??= await context.waitForEvent('serviceworker', { predicate: isCaller });
      const id = new URL(worker.url()).host;
      const callerId = new URL(callerWorker.url()).host;
      const url = path => `chrome-extension://${id}/${path}`;
      // Control only the native picker/permission boundary. DOM, Viewer, IDB,
      // storage, handles and File bytes continue to use the production app.
      await context.addInitScript(() => {
        window.__pickerCalls = []; window.__permissionCalls = [];
        window.__pickerError = null; window.__permission = null;
        window.__pickerName = 'University';
        window.showDirectoryPicker = async options => {
          window.__pickerCalls.push({ options, active: navigator.userActivation.isActive });
          if (window.__pickerError) throw new DOMException('picker failed', window.__pickerError);
          const opfs = await navigator.storage.getDirectory();
          return opfs.getDirectoryHandle(window.__pickerName, { create: true });
        };
        const prototype = FileSystemHandle.prototype;
        const query = prototype.queryPermission;
        const request = prototype.requestPermission;
        prototype.queryPermission = function (options) {
          return window.__permission ? Promise.resolve(window.__permission) : query.call(this, options);
        };
        prototype.requestPermission = function (options) {
          window.__permissionCalls.push({ options, active: navigator.userActivation.isActive });
          if (window.__permission) { window.__permission = 'granted'; return Promise.resolve('granted'); }
          return request.call(this, options);
        };
      });
      const setupPage = await context.newPage(); await setupPage.goto(url('src/options/options.html'));
      const cdp = await context.newCDPSession(setupPage);
      const browserVersion = await cdp.send('Browser.getVersion'); await cdp.detach();
      const playwrightVersion = JSON.parse(await readFile(resolve(repository, 'node_modules/playwright/package.json'), 'utf8')).version;
      await testInfo.attach('environment.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
        testedCommit: process.env.GITHUB_SHA ?? null, workflowRun: process.env.GITHUB_RUN_ID ?? null,
        os: { platform: platform(), release: release(), arch: arch() }, node: process.version,
        playwright: playwrightVersion, browser: browserVersion, extensionId: id,
        scope: 'Chromium automation; OPFS handles; controlled picker/permission boundary; test sender, not Vimium C',
      }, null, 2)) });
      const callerPage = await context.newPage(); await callerPage.goto(`chrome-extension://${callerId}/caller.html`);
      const extension = {
        context, worker, id, callerId, url, setupPage,
        async configureLauncher(enabled = true, allowedIds = [callerId]) {
          await setupPage.evaluate(settings => chrome.storage.local.set({ 'vimdf.localBrowser.launcher.v1': settings }),
            { version: 1, enabled, allowedIds });
        },
        async send(message = { type: 'vimdf.openLocalBrowser', version: 1 }) {
          return callerPage.evaluate(async ({ target, message }) => {
            try { return { reply: await chrome.runtime.sendMessage(target, message), error: null }; }
            catch (error) { return { reply: null, error: error.message }; }
          }, { target: id, message });
        },
        async seed(options = {}) {
          const encrypted = JSON.parse(await readFile(new URL('../fixtures/AES-256.json', import.meta.url), 'utf8'));
          await setupPage.evaluate(async ({ bytes, cipher, rootA, rootB, options }) => {
            const opfs = await navigator.storage.getDirectory();
            const parentA = options.sameNames ? await opfs.getDirectoryHandle('Parent-A', { create: true }) : opfs;
            const parentB = options.sameNames ? await opfs.getDirectoryHandle('Parent-B', { create: true }) : opfs;
            const a = await parentA.getDirectoryHandle(options.sameNames ? 'Documents' : 'University', { create: true });
            const b = await parentB.getDirectoryHandle(options.sameNames ? 'Documents' : 'Books', { create: true });
            const course = await a.getDirectoryHandle('course', { create: true });
            async function write(dir, name, bytes) {
              const handle = await dir.getFileHandle(name, { create: true });
              const writer = await handle.createWritable(); await writer.write(new Uint8Array(bytes)); await writer.close();
            }
            await write(course, 'lesson.pdf', bytes); await write(a, 'z.pdf', bytes);
            await write(a, '資料 # %.PDF', bytes); await write(b, 'lesson.pdf', bytes);
            await write(a, 'locked.pdf', Array.from(atob(cipher), c => c.charCodeAt(0)));
            if (options.hostile) await write(a, '<img src=x onerror=alert(1)>.pdf', bytes);
            if (options.emptyFolder) await a.getDirectoryHandle('empty', { create: true });
            for (let i = 0; i < (options.pdfCount ?? 0); i++) await write(a, `document-${String(i).padStart(3, '0')}.pdf`, bytes);
            const roots = [{ id: rootA, handle: a }];
            if (!options.singleRoot) roots.push({ id: rootB, handle: b });
            for (let i = 0; i < (options.extraRoots ?? 0); i++) {
              roots.push({ id: crypto.randomUUID(), handle: await opfs.getDirectoryHandle(`Folder-${String(i).padStart(3, '0')}`, { create: true }) });
            }
            const db = await new Promise((resolve, reject) => {
              const r = indexedDB.open('vimdf.local-browser', 1);
              r.onupgradeneeded = () => r.result.createObjectStore('registry');
              r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
            });
            try {
              await new Promise((resolve, reject) => {
                const tx = db.transaction('registry', 'readwrite');
                tx.objectStore('registry').put({ revision: 1, state: { version: 1,
                  roots, primaryId: rootA } }, 'state');
                tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
              });
            } finally { db.close(); }
          }, { bytes: [...lessonPdf()], cipher: encrypted.base64, rootA, rootB, options });
          return encrypted;
        },
        async openBrowser() {
          const page = await context.newPage();
          await page.goto(url('src/local-browser/browser.html'));
          await expect(page.getByTestId('local-browser')).toBeVisible();
          return page;
        },
        async registry() {
          return setupPage.evaluate(async () => {
            const db = await new Promise((resolve, reject) => {
              const r = indexedDB.open('vimdf.local-browser', 1);
              r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
            });
            try {
              return await new Promise((resolve, reject) => {
                const tx = db.transaction('registry'); const r = tx.objectStore('registry').get('state');
                tx.oncomplete = () => resolve(r.result ? { revision: r.result.revision, primaryId: r.result.state.primaryId,
                  roots: r.result.state.roots.map(root => ({ id: root.id, name: root.handle.name,
                    native: root.handle instanceof FileSystemDirectoryHandle })) } : null);
                tx.onabort = () => reject(tx.error);
              });
            } finally { db.close(); }
          });
        },
      };
      await use(extension);
    } finally {
      if (context) {
        if (testInfo.status !== testInfo.expectedStatus) {
          await context.tracing.stop({ path: testInfo.outputPath('trace.zip') });
          const page = context.pages().at(-1);
          if (page && !page.isClosed()) await page.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => {});
        } else await context.tracing.stop();
        await context.close();
      }
      await rm(profile, { recursive: true, force: true });
    }
  },
});

export { expect };
export async function filter(page, query) {
  // Keyboard navigation starts asynchronous native IDB/enumeration work.
  // Busy commands are deliberately consumed, so begin the next user action
  // only after the production page reports that operation complete.
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-busy', 'false');
  await page.keyboard.press('/'); await page.getByTestId('browser-filter').fill(query);
  await page.keyboard.press('Enter');
}
export async function openLesson(page) {
  await filter(page, 'course'); await page.keyboard.press('Enter');
  await filter(page, 'lesson'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('local-browser')).toHaveAttribute('data-mode', 'pdf');
  await expect(page.locator('#viewer .page')).toHaveCount(2);
}

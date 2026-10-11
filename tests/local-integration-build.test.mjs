import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
const browserPath = 'src/local-browser/browser.html';

test('[UI-01] production browser HTML and its referenced JS/CSS exist in dist', async () => {
  let html;
  try { html = await readFile(new URL(browserPath, dist), 'utf8'); }
  catch (error) { assert.fail(`Missing production entry ${browserPath}: ${error.code}`); }
  assert.match(html, /<script[^>]+type="module"/);
  const urls = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(m => m[1]);
  assert.ok(urls.some(url => url.endsWith('.js'))); assert.ok(urls.some(url => url.endsWith('.css')));
  for (const url of urls) {
    assert.doesNotMatch(url, /^https?:/);
    await access(new URL(url.replace(/^\//, ''), url.startsWith('/') ? dist : new URL(browserPath, dist)));
  }
});

test('[EXT-01] manifest provides a toolbar action without popup or competing omnibox', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist), 'utf8'));
  assert.ok(manifest.action, 'add a toolbar action');
  assert.equal(manifest.action.default_popup, undefined); assert.equal(manifest.omnibox, undefined);
  assert.equal(manifest.externally_connectable?.matches?.length ?? 0, 0);
});

test('[UI-01] browser page remains private while existing Viewer and MIME entries remain available', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist), 'utf8'));
  for (const resource of manifest.web_accessible_resources ?? []) {
    for (const pattern of resource.resources) {
      const matches = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      assert.equal(matches.test(browserPath), false, `${pattern} must not expose the browser page`);
    }
  }
  assert.equal(manifest.mime_types_handler['application/pdf'].handler_url, 'src/viewer/viewer.html');
  await access(new URL('src/viewer/viewer.html', dist));
});

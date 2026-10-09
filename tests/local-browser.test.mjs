import test from 'node:test';
import assert from 'node:assert/strict';
import { contract, file, directory, browserFixture } from './helpers/local-browser-fixtures.mjs';

const message = { type: 'vimdf.openLocalBrowser', version: 1 };

test('only an allowlisted sender ID can invoke the exact versioned command', () => {
  const { acceptExternalOpen: accept } = contract();
  assert.equal(accept(message, { id: 'trusted' }, ['trusted']), true);
  for (const sender of [{ id: 'other' }, {}, { id: 'trusted', incognito: true }]) {
    assert.equal(accept(message, sender, ['trusted']), false);
  }
  assert.equal(accept(message, { id: 'trusted' }, []), false);
});

test('spoofed senders, malformed payloads, versions and arbitrary paths are rejected', () => {
  const { acceptExternalOpen: accept } = contract();
  for (const payload of [
    null, [], {}, 'open', { ...message, version: 2 }, { ...message, type: 'open' },
    { ...message, url: 'file:///secret' }, { ...message, from: 'Vimium C' },
    { ...message, path: '/secret' }, { ...message, rootId: 'r-a' },
    { ...message, primaryId: 'r-b' },
  ]) {
    assert.equal(accept(payload, { id: 'trusted' }, ['trusted']), false);
  }
});

test('directories sort first and only case-insensitive PDF suffixes appear', async () => {
  const { browser } = await browserFixture([
    file('z.PDF'), file('notes.txt'), directory('b'), file('a.pdf'), directory('a'),
  ]);
  assert.deepEqual(browser.entries.map(entry => entry.name), ['a', 'b', 'a.pdf', 'z.PDF']);
  assert.equal(browser.selectedIndex, 0);
});

test('j/k clamp selection and gg/G select endpoints', async () => {
  const { browser } = await browserFixture([file('a.pdf'), file('b.pdf')]);
  browser.key('k');
  assert.equal(browser.selectedIndex, 0);
  browser.key('j'); browser.key('j');
  assert.equal(browser.selectedIndex, 1);
  browser.key('gg');
  assert.equal(browser.selectedIndex, 0);
  browser.key('G');
  assert.equal(browser.selectedIndex, 1);
});

test('empty directories have no selection and Enter is harmless', async () => {
  const { browser, calls } = await browserFixture([]);
  assert.equal(browser.selectedIndex, -1);
  await browser.enter();
  assert.deepEqual(calls, []);
});

test('name filters are case-insensitive partial matches and reset selection', async () => {
  const { browser } = await browserFixture([file('Alpha.pdf'), file('Beta.pdf')]);
  browser.key('G');
  browser.setFilter('ALP');
  assert.deepEqual(browser.entries.map(entry => entry.name), ['Alpha.pdf']);
  assert.equal(browser.selectedIndex, 0);
  browser.setFilter('missing');
  assert.equal(browser.selectedIndex, -1);
  browser.setFilter('');
  assert.equal(browser.entries.length, 2);
});

test('Enter descends and the directory model never enumerates an unregistered parent', async () => {
  const { browser } = await browserFixture([
    directory('sub', [file('child.pdf')]), file('root.pdf'),
  ]);
  assert.equal(browser.atRoot, true);
  await browser.enter();
  assert.equal(browser.atRoot, false);
  assert.deepEqual(browser.entries.map(entry => entry.name), ['child.pdf']);
  await browser.parent();
  await browser.parent();
  assert.deepEqual(browser.entries.map(entry => entry.name), ['sub', 'root.pdf']);
  assert.equal(browser.atRoot, true);
  // The session turns h at this boundary into the registered-folder list.
});

test('opening a PDF supplies bytes and a stable non-blob identity', async () => {
  const { browser, calls } = await browserFixture([file('a.pdf')]);
  await browser.enter(); await browser.enter();
  assert.ok(calls[0][0] instanceof File);
  assert.equal(await calls[0][0].text(), '%PDF-1.7');
  assert.equal(calls[0][1], calls[1][1]);
  assert.equal(typeof calls[0][1], 'string');
  assert.ok(!calls[0][1].startsWith('blob:'));
});

test('same filenames in different subdirectories have different identities', async () => {
  const { browser, calls } = await browserFixture([
    directory('a', [file('x.pdf')]), directory('b', [file('x.pdf')]),
  ]);
  await browser.enter(); await browser.enter(); await browser.parent();
  browser.key('j');
  await browser.enter(); await browser.enter();
  assert.notEqual(calls[0][1], calls[1][1]);
});

test('failed file reads never invoke the PDF viewer', async () => {
  const bad = file('bad.pdf');
  bad.getFile = async () => { throw new Error('gone'); };
  const { browser, calls } = await browserFixture([bad]);
  await assert.rejects(browser.enter(), /gone/);
  assert.deepEqual(calls, []);
});

test('directory enumeration failures propagate and can be retried', async () => {
  const root = directory('root');
  root.values = async function* () { throw new Error('denied'); };
  const browser = new (contract().LocalBrowser)(root, { rootId: 'r', openPdf: async () => {} });
  await assert.rejects(browser.refresh(), /denied/);
  root.values = async function* () { yield file('ok.pdf'); };
  await browser.refresh();
  assert.equal(browser.entries[0].name, 'ok.pdf');
});

test('listing the current directory never scans child directories recursively', async () => {
  const child = directory('sub');
  child.values = async function* () { assert.fail('must not enumerate child'); };
  const { browser } = await browserFixture([child]);
  assert.equal(browser.entries.length, 1);
});

test('different registered roots never share a document identity', async () => {
  const calls = [];
  const { LocalBrowser } = contract();
  for (const rootId of ['one', 'two']) {
    const browser = new LocalBrowser(directory('same', [file('x.pdf')]), {
      rootId, openPdf: async (...args) => { calls.push(args); },
    });
    await browser.refresh(); await browser.enter();
  }
  assert.notEqual(calls[0][1], calls[1][1]);
});

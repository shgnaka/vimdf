import test from 'node:test';
import assert from 'node:assert/strict';
import { documentKey } from '../src/viewer/passwords.ts';
import {
  contract, file, directory, state, browserFixture, registryFixture, sessionFixture, press, methods, deferred,
} from './helpers/local-browser-fixtures.mjs';

test('repeated navigation letters stay text while filtering and repeated Enter does not exit input', async () => {
  const f = await sessionFixture(); await press(f.session, 'h'); await press(f.session, '/');
  for (const key of ['g', 'l', 'a', 'j', 'k', 'h']) {
    assert.equal(f.session.key({ key, repeat: true }), false);
  }
  await press(f.session, 'Enter', { repeat: true });
  assert.equal(f.session.inputMode, 'filter');
  assert.equal(f.session.view, 'roots');
  assert.equal(f.ioCalls.filter(call => call.method === 'pick').length, 0);
  await press(f.session, 'Escape');
  await press(f.session, 'Escape', { repeat: true });
  assert.equal(f.session.view, 'roots');
});

test('the initial picker is invoked in the key call before any asynchronous continuation', async () => {
  const f = registryFixture();
  const session = new (contract().LocalBrowserSession)({ registry: f.registry, openPdf: async () => {} });
  await session.start(); f.choose(directory('University'));
  assert.equal(session.key({ key: 'x' }), false);
  const adding = session.key({ key: 'Enter' });
  assert.ok(adding instanceof Promise);
  assert.equal(f.calls.filter(call => call.method === 'pick').length, 1);
  assert.equal(session.busy, true);
  await adding;
  assert.equal(session.view, 'browse');
});

test('explicit reauthorization invokes requestPermission in the confirmation key call', async () => {
  const b = directory('Books', [], { permission: 'prompt', requestedPermission: 'granted' });
  const f = await sessionFixture({ b }); await press(f.session, 'h');
  await press(f.session, 'j'); await press(f.session, 'Enter');
  const permitting = f.session.key({ key: 'Enter' });
  assert.equal(methods(b, 'requestPermission').length, 1);
  assert.equal(f.saved().primaryId, 'r-a');
  await permitting;
  assert.equal(f.saved().primaryId, 'r-b');
});

test('a listing failure after a successful switch keeps the saved primary and can be retried', async () => {
  const b = directory('Books');
  b.values = async function* () { throw new Error('folder disappeared'); };
  const f = await sessionFixture({ b }); await press(f.session, 'h'); await press(f.session, 'j');
  await assert.rejects(press(f.session, 'Enter'), /folder disappeared/);
  assert.equal(f.saved().primaryId, 'r-b');
  assert.equal(f.session.activeRootId, 'r-b');
  assert.equal(f.session.view, 'browse');
  assert.equal(f.session.busy, false);
  assert.equal(f.session.selectedIndex, -1);
  b.values = async function* () { yield file('recovered.pdf'); };
  await f.session.refresh();
  assert.equal(f.session.entries[0].name, 'recovered.pdf');
});

test('a startup permission-query error preserves the saved primary for explicit recovery', async () => {
  const a = directory('University');
  a.queryPermission = async () => { throw new Error('permission API unavailable'); };
  const f = registryFixture(state([{ id: 'a', handle: a }]));
  const session = new (contract().LocalBrowserSession)({ registry: f.registry, openPdf: async () => {} });
  await assert.rejects(session.start(), /permission API unavailable/);
  assert.equal(session.view, 'permission');
  assert.equal(session.pendingRootId, 'a');
  assert.equal(session.busy, false);
  assert.equal(f.saved().primaryId, 'a');
  assert.equal(methods(a, 'values').length + methods(a, 'requestPermission').length, 0);
  await press(session, 'Escape');
  assert.deepEqual(session.entries.map(entry => entry.id), ['a']);
});

test('failed child enumeration keeps the parent location and filter until navigation succeeds', async () => {
  const child = directory('course');
  child.values = async function* () { throw new Error('cannot read child'); };
  const { browser } = await browserFixture([child, file('a.pdf')]);
  browser.setFilter('course');
  await assert.rejects(browser.enter(), /cannot read child/);
  assert.equal(browser.atRoot, true);
  assert.equal(browser.filter, 'course');
  assert.equal(browser.entries[0].name, 'course');
  child.values = async function* () { yield file('lesson.pdf'); };
  await browser.enter();
  assert.equal(browser.atRoot, false);
  assert.equal(browser.filter, '');
  assert.equal(browser.entries[0].name, 'lesson.pdf');
});

test('a slow older enumeration cannot overwrite a newer listing', { timeout: 1000 }, async () => {
  const release = deferred();
  const root = directory('root');
  let count = 0;
  root.values = async function* () {
    if (++count === 1) { await release.promise; yield file('old.pdf'); }
    else yield file('new.pdf');
  };
  const browser = new (contract().LocalBrowser)(root, { rootId: 'r', openPdf: async () => {} });
  const older = browser.refresh();
  try {
    await browser.refresh();
    assert.deepEqual(browser.entries.map(entry => entry.name), ['new.pdf']);
  } finally {
    release.resolve(); await older;
  }
  assert.deepEqual(browser.entries.map(entry => entry.name), ['new.pdf']);
});

test('corrupt registries fail without silently choosing a primary or overwriting data', async () => {
  const root = { id: 'a', handle: directory('A') };
  for (const corrupt of [
    { ...state([root]), version: 2 }, state([root], 'missing'), state([], 'a'),
    state([root, root]), state([{ id: 'a', handle: {} }]),
  ]) {
    let persisted = corrupt;
    const registry = new (contract().FolderRegistry)({
      load: async () => persisted,
      save: async () => assert.fail('must not overwrite corrupt data'),
      pick: async () => assert.fail('must not prompt after a failed restore'),
      newId: () => assert.fail('must not generate an ID'),
    });
    await assert.rejects(registry.restore(), /invalid|duplicate/i);
    assert.equal(registry.primaryId, null);
    assert.equal(registry.roots.length, 0);
    await assert.rejects(registry.add(), /restore/i);
    persisted = state([root]);
    assert.equal((await registry.restore()).id, 'a');
  }
});

test('overlapping registry mutations are rejected instead of losing a saved registration', { timeout: 1000 }, async () => {
  const started = deferred(), release = deferred();
  const f = registryFixture(state([
    { id: 'a', handle: directory('A') }, { id: 'b', handle: directory('B') },
  ]), { saveHook: async () => { started.resolve(); await release.promise; } });
  await f.registry.restore();
  const switching = f.registry.activate('b');
  await Promise.race([started.promise, switching.then(() => assert.fail('save must start'))]);
  try {
    await assert.rejects(f.registry.remove('a'), /in progress/i);
    assert.equal(f.calls.filter(call => call.method === 'save').length, 1);
    assert.equal(f.registry.primaryId, 'a');
  } finally { release.resolve(); await switching; }
  assert.equal(f.registry.primaryId, 'b');
  assert.deepEqual(f.registry.roots.map(root => root.id), ['a', 'b']);
  await f.registry.remove('a');
  assert.deepEqual(f.saved().roots.map(root => root.id), ['b']);
});

test('name ordering follows Unicode code points including non-BMP characters', async () => {
  const { browser } = await browserFixture([file('\u{10000}.pdf'), file('\uE000.pdf')]);
  assert.deepEqual(browser.entries.map(entry => entry.name), ['\uE000.pdf', '\u{10000}.pdf']);
});

test('special filenames have distinct stable identities accepted by existing password storage', async () => {
  const { browser, calls } = await browserFixture([
    file('a%3Fb.pdf'), file('a?b.pdf'), file('a#b.pdf'), file('日本語.pdf'),
  ]);
  for (let i = 0; i < browser.entries.length; i++) {
    await browser.enter(); browser.key('j');
  }
  const identities = calls.map(call => call[1]);
  assert.equal(new Set(identities).size, 4);
  for (const identity of identities) {
    assert.equal(documentKey(identity), identity);
    assert.equal(new URL(identity).search, '');
    assert.equal(new URL(identity).hash, '');
  }
});

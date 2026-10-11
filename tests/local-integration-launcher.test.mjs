import test from 'node:test';
import assert from 'node:assert/strict';
import { implementation, chromeFixture, enabledLauncher, launcherKey, vimiumId,
  vimdfId, launchCommand, deferred, settled } from './helpers/local-integration.mjs';

async function fixture(t, options = {}) {
  const install = await implementation('src/background/local-browser-launcher.ts', 'installLocalBrowserLauncher');
  const f = chromeFixture({ settings: enabledLauncher(), ...options });
  const dispose = install(f.chrome); assert.equal(typeof dispose, 'function'); t.after(dispose);
  return f;
}

test('[EXT-01] unset, disabled, corrupt and unallowlisted launch settings reject without creating a tab', { timeout: 2500 }, async t => {
  for (const settings of [undefined, { version: 1, enabled: false, allowedIds: [vimiumId] },
    { version: 1, enabled: true, allowedIds: [] }, { version: 2, enabled: true, allowedIds: [vimiumId] },
    { version: 1, enabled: 'true', allowedIds: [vimiumId] }, { version: 1, enabled: true, allowedIds: 'all' }]) {
    const f = await fixture(t, { settings }); const r = f.dispatch();
    assert.equal(await r.replied, false); assert.equal(f.calls.filter(c => c.method === 'tabs.create').length, 0);
  }
});

test('[EXT-01] only the allowlisted native sender ID is authenticated', { timeout: 1500 }, async t => {
  const f = await fixture(t);
  for (const sender of [{}, { id: 'c'.repeat(32) }, { id: 'not-an-extension-id' }]) {
    assert.equal(await f.dispatch(launchCommand, sender).replied, false);
  }
  assert.equal(f.calls.filter(c => c.method === 'tabs.create').length, 0);
});

test('[EXT-01] exact payload validation rejects paths, envelopes and extra fields', { timeout: 2500 }, async t => {
  const f = await fixture(t);
  for (const message of [null, [], 'vimdf.openLocalBrowser', { type: launchCommand.type, version: '1' },
    { ...launchCommand, version: 2 }, { ...launchCommand, rootId: 'b' }, { ...launchCommand, primaryId: 'b' },
    { ...launchCommand, url: 'file:///home' }, { ...launchCommand, from: 'Vimium C' },
    { handler: 'message', from: 'Vimium C', data: launchCommand }]) {
    assert.equal(await f.dispatch(message).replied, false);
  }
  assert.equal(f.calls.filter(c => c.method === 'tabs.create').length, 0);
});

test('[EXT-02] async listener keeps its channel and replies true exactly once after tab creation', { timeout: 1500 }, async t => {
  const f = await fixture(t); const gate = deferred(); f.holdSettings(gate.promise);
  const r = f.dispatch(); assert.equal(r.returned, true); assert.deepEqual(r.responses, []);
  assert.equal(f.calls.filter(c => c.method === 'tabs.create').length, 0);
  gate.resolve(); assert.equal(await r.replied, true); await settled();
  assert.deepEqual(r.responses, [true]);
  assert.deepEqual(f.calls.find(c => c.method === 'tabs.create').value, {
    url: `chrome-extension://${vimdfId}/src/local-browser/browser.html`, windowId: 7, active: true,
  });
  assert.equal(f.chrome.runtime.onMessage.listeners.size, 0, 'do not install/forward internal commands');
});

test('[EXT-02] tab creation failure replies the boolean false rather than an object', { timeout: 1500 }, async t => {
  const f = await fixture(t); f.failCreate(new Error('cannot create tab')); const r = f.dispatch();
  assert.equal(await r.replied, false); await settled(); assert.deepEqual(r.responses, [false]);
});

test('[EXT-02] a known sender tab chooses its verified window instead of the focused window', { timeout: 1500 }, async t => {
  const f = await fixture(t); f.windows.set(12, { id: 12, type: 'normal', incognito: false });
  const r = f.dispatch(launchCommand, { id: vimiumId, tab: { windowId: 12, incognito: false } });
  assert.equal(await r.replied, true);
  assert.equal(f.calls.find(c => c.method === 'tabs.create').value.windowId, 12);
});

test('[EXT-02] unknown-origin launch captures the focused window before asynchronous settings loading', { timeout: 1500 }, async t => {
  const f = await fixture(t); const gate = deferred(); f.holdSettings(gate.promise);
  const r = f.dispatch();
  assert.ok(f.calls.some(c => c.method === 'windows.getLastFocused'), 'capture at receipt, not after settings await');
  f.focus(9); gate.resolve(); assert.equal(await r.replied, true);
  assert.equal(f.calls.find(c => c.method === 'tabs.create').value.windowId, 7);
});

test('[EXT-04] identifiable incognito origin, incognito context and incognito target are rejected', { timeout: 2500 }, async t => {
  const f = await fixture(t);
  assert.equal(await f.dispatch(launchCommand, { id: vimiumId, tab: { windowId: 7, incognito: true } }).replied, false);
  f.focus(9); assert.equal(await f.dispatch().replied, false);
  const privateContext = await fixture(t, { incognito: true });
  assert.equal(await privateContext.dispatch().replied, false);
  assert.equal([...f.calls, ...privateContext.calls].filter(c => c.method === 'tabs.create').length, 0);
});

test('[EXT-02] missing and closed targets are rejected without falling back to another window', { timeout: 1500 }, async t => {
  const f = await fixture(t);
  assert.equal(await f.dispatch(launchCommand, { id: vimiumId, tab: { windowId: 999, incognito: false } }).replied, false);
  const gate = deferred(); f.holdSettings(gate.promise); const r = f.dispatch();
  f.windows.delete(7); gate.resolve(); assert.equal(await r.replied, false);
  assert.equal(f.calls.filter(c => c.method === 'tabs.create' && c.value.windowId === 9).length, 0);
});

test('[EXT-04] service-worker reinstall reads persisted local launcher settings', { timeout: 1500 }, async t => {
  const persistent = { [launcherKey]: enabledLauncher() };
  const first = await fixture(t, { persistent }); assert.equal(await first.dispatch().replied, true);
  const second = await fixture(t, { persistent }); assert.equal(await second.dispatch().replied, true);
  persistent[launcherKey] = { ...enabledLauncher(), enabled: false };
  assert.equal(await second.dispatch().replied, false);
});

test('[EXT-01] toolbar entry works independently of external connection permission and dispose removes listeners', { timeout: 1500 }, async t => {
  const install = await implementation('src/background/local-browser-launcher.ts', 'installLocalBrowserLauncher');
  const f = chromeFixture(); const dispose = install(f.chrome); t.after(dispose);
  assert.equal(f.chrome.action.onClicked.listeners.size, 1);
  [...f.chrome.action.onClicked.listeners][0]({ windowId: 7, incognito: false }); await settled();
  assert.equal(f.calls.filter(c => c.method === 'tabs.create').length, 1);
  assert.equal(f.calls.find(c => c.method === 'tabs.create').value.url,
    `chrome-extension://${vimdfId}/src/local-browser/browser.html`);
  dispose(); assert.equal(f.chrome.action.onClicked.listeners.size, 0);
  assert.equal(f.chrome.runtime.onMessageExternal.listeners.size, 0);
});

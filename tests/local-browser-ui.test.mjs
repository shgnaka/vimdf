import test from 'node:test';
import assert from 'node:assert/strict';
import { contract, directory, file, registryFixture, sessionFixture, press, methods, deferred } from './helpers/local-browser-fixtures.mjs';

// UX-01..13 are additional contracts, not expected failures or a replacement
// model. These tests call the same session/registry as the extension page.
const snapshot = s => ({ view: s.view, root: s.activeRootId, pending: s.pendingRootId,
  location: s.location, filter: s.filter, input: s.inputMode, index: s.selectedIndex,
  entries: s.entries.map(e => ({ name: e.name, id: e.id, isPrimary: e.isPrimary })) });
const writes = f => f.ioCalls.filter(c => c.method === 'save').length;

async function fixture(view = 'browse', options = {}) {
  if (view === 'empty') {
    const f = registryFixture(null, options);
    const session = new (contract().LocalBrowserSession)({ registry: f.registry, openPdf: async () => assert.fail('no PDF') });
    await session.start(); return { ...f, session, ioCalls: f.calls };
  }
  const f = await sessionFixture(view === 'permission'
    ? { ...options, a: directory('University', [], { permission: 'prompt' }) } : options);
  if (view === 'roots') f.session.openRoots();
  return f;
}

for (const activate of ['Enter', 'l']) {
  test(`[UX-02] deep child r -> selection -> ${activate} saves only on confirmation`, async () => {
    const a = directory('University', [directory('course', [directory('week', [file('lesson.pdf')])])]);
    const f = await fixture('browse', { a });
    await press(f.session, 'Enter'); await press(f.session, 'Enter');
    assert.match(f.session.location, /course.*week/);
    assert.equal(await press(f.session, 'r'), true);
    assert.equal(f.session.view, 'roots'); assert.equal(f.session.selectedIndex, 0);
    assert.equal(writes(f), 0); assert.equal(methods(f.b, 'values').length, 0);
    await press(f.session, '/'); f.session.setFilter('Books'); await press(f.session, 'Enter');
    assert.equal(f.session.view, 'roots'); assert.equal(writes(f), 0);
    assert.equal(f.saved().primaryId, 'r-a');
    await press(f.session, activate);
    assert.equal(f.session.view, 'browse'); assert.equal(f.session.activeRootId, 'r-b');
    assert.equal(f.saved().primaryId, 'r-b'); assert.equal(writes(f), 1);
    assert.equal(f.session.filter, ''); assert.equal(f.session.selectedIndex, 0);
    const restarted = registryFixture(f.saved());
    const session = new (contract().LocalBrowserSession)({ registry: restarted.registry, openPdf: async () => {} });
    await session.start(); assert.equal(session.activeRootId, 'r-b');
    assert.match(session.location, /Books/);
  });
}

test('[UX-03] r then two Esc presses restore the exact child filter and selected row', async () => {
  const a = directory('University', [directory('course', [file('a.pdf'), file('z.pdf')])]);
  const f = await fixture('browse', { a }); await press(f.session, 'Enter');
  f.session.setFilter('.pdf'); await press(f.session, 'j'); const before = snapshot(f.session);
  await press(f.session, 'r'); assert.equal(f.session.view, 'roots');
  await press(f.session, '/'); f.session.setFilter('Books'); await press(f.session, 'Enter');
  await press(f.session, 'Escape'); assert.equal(f.session.view, 'roots');
  assert.equal(f.session.filter, ''); await press(f.session, 'Escape');
  assert.deepEqual(snapshot(f.session), before); assert.equal(writes(f), 0);
});

test('[UX-03] r in roots preserves selection/filter and the original cancellation destination', async () => {
  const f = await fixture(); await press(f.session, 'Enter'); const original = snapshot(f.session);
  await press(f.session, 'r'); assert.equal(f.session.view, 'roots');
  f.session.setFilter('Books'); const chooser = snapshot(f.session);
  await press(f.session, 'r'); assert.deepEqual(snapshot(f.session), chooser);
  await press(f.session, 'Escape'); await press(f.session, 'Escape');
  assert.deepEqual(snapshot(f.session), original); assert.equal(writes(f), 0);
});

test('[UX-03] r from permission chooses another root without requesting permission', async () => {
  const f = await fixture('permission');
  await press(f.session, 'r'); assert.equal(f.session.view, 'roots');
  assert.equal(f.session.entries[f.session.selectedIndex].id, 'r-a');
  assert.equal(methods(f.a, 'requestPermission').length, 0);
  assert.equal(methods(f.a, 'values').length, 0); assert.equal(writes(f), 0);
});

test('[UX-03] r in empty is inert and never opens a picker', async () => {
  const f = await fixture('empty'); const before = snapshot(f.session);
  await press(f.session, 'r'); assert.deepEqual(snapshot(f.session), before);
  assert.equal(f.ioCalls.filter(c => c.method === 'pick').length, 0);
});

for (const view of ['browse', 'roots', 'empty', 'permission']) {
  test(`[UX-04] a in ${view} starts one picker synchronously and adds without an implicit switch`, async () => {
    const f = await fixture(view); f.choose(directory('Work', [file('work.pdf')]));
    const result = f.session.key({ key: 'a' });
    // Check before awaiting: transient user activation must reach the picker.
    assert.equal(f.ioCalls.filter(c => c.method === 'pick').length, 1);
    await result; assert.equal(f.saved().roots.length, view === 'empty' ? 1 : 3);
    assert.equal(f.saved().primaryId, view === 'empty' ? 'root-1' : 'r-a');
    assert.equal(f.session.view, view === 'empty' ? 'browse' : 'roots');
    assert.equal(f.session.entries[f.session.selectedIndex].name, view === 'empty' ? 'work.pdf' : 'Work');
    if (view === 'permission') assert.equal(methods(f.a, 'requestPermission').length, 0);
  });

  test(`[UX-04] cancelling a in ${view} preserves its complete invoking state`, async () => {
    const f = await fixture(view);
    if (view === 'browse') await press(f.session, 'Enter');
    if (view === 'browse' || view === 'roots') { f.session.setFilter('o'); await press(f.session, 'G'); }
    const before = snapshot(f.session); const saved = f.saved();
    await press(f.session, 'a');
    assert.equal(f.ioCalls.filter(c => c.method === 'pick').length, 1);
    assert.deepEqual(snapshot(f.session), before); assert.deepEqual(f.saved(), saved);
    assert.equal(f.session.busy, false); assert.equal(writes(f), 0);
  });
}

for (const view of ['browse', 'roots', 'permission']) {
  test(`[UX-04] duplicate a in ${view} selects the old ID without writes or reordering`, async () => {
    const f = await fixture(view); f.choose(f.b);
    await press(f.session, 'a'); assert.equal(f.session.view, 'roots');
    assert.equal(f.session.entries[f.session.selectedIndex].id, 'r-b');
    assert.deepEqual(f.saved().roots.map(r => r.id), ['r-a', 'r-b']);
    assert.equal(f.saved().primaryId, 'r-a'); assert.equal(writes(f), 0);
    assert.equal(f.generated(), 0);
  });
}

for (const error of [new DOMException('not permitted', 'NotAllowedError'), new Error('database unavailable')]) {
  test(`[UX-04] ${error.name} adding from a child preserves the child and committed registrations`, async () => {
    const f = await fixture(); await press(f.session, 'Enter'); const before = snapshot(f.session);
    f.choose(directory('Work'));
    if (error.name === 'NotAllowedError') f.failPick(error); else f.failSave(error);
    await assert.rejects(press(f.session, 'a'), e => e === error);
    assert.deepEqual(snapshot(f.session), before); assert.equal(f.saved().primaryId, 'r-a');
    assert.deepEqual(f.saved().roots.map(r => r.id), ['r-a', 'r-b']);
    assert.equal(f.session.busy, false);
  });
}

test('[UX-04] selecting a newly added denied root does not change the default or enumerate it', async () => {
  const work = directory('Work', [], { permission: 'denied' });
  const f = await fixture(); f.choose(work); await press(f.session, 'a');
  assert.equal(f.session.view, 'roots'); await press(f.session, 'Enter');
  assert.equal(f.session.view, 'permission'); assert.equal(f.saved().primaryId, 'r-a');
  assert.equal(methods(work, 'requestPermission').length, 0);
  assert.equal(methods(work, 'values').length, 0);
  await press(f.session, 'Enter'); assert.equal(f.saved().primaryId, 'r-a');
  assert.equal(f.session.view, 'permission');
});

test('[UX-05] filter input owns r/a/?/j; input Enter and activation Enter are distinct', async () => {
  const f = await fixture('roots'); await press(f.session, '/'); const before = snapshot(f.session);
  for (const key of ['r', 'a', '?', 'j']) {
    assert.equal(await press(f.session, key), false); assert.deepEqual(snapshot(f.session), before);
  }
  f.session.setFilter('Books'); await press(f.session, 'Enter');
  assert.equal(f.session.inputMode, 'normal'); assert.equal(f.session.filter, 'Books');
  assert.equal(f.saved().primaryId, 'r-a'); assert.equal(writes(f), 0);
  await press(f.session, '/'); assert.equal(f.session.filter, 'Books');
  await press(f.session, 'Escape'); assert.equal(f.session.filter, '');
  assert.equal(f.session.view, 'roots'); assert.equal(f.ioCalls.filter(c => c.method === 'pick').length, 0);
});

for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'isComposing']) {
  test(`[UX-08] ${modifier} r/a/? and filter Enter/Esc leave the active state untouched`, async () => {
    const f = await fixture(); const before = snapshot(f.session);
    for (const key of ['r', 'a', '?']) assert.equal(await press(f.session, key, { [modifier]: true }), false);
    assert.deepEqual(snapshot(f.session), before);
    await press(f.session, '/'); const input = snapshot(f.session);
    for (const key of ['Enter', 'Escape']) assert.equal(await press(f.session, key, { [modifier]: true }), false);
    assert.deepEqual(snapshot(f.session), input);
    assert.equal(f.ioCalls.filter(c => c.method === 'pick').length, 0);
  });
}

test('[UX-08] repeated r/a/Enter/l/Esc neither act nor complete an unfinished key sequence', async () => {
  const f = await fixture(); const before = snapshot(f.session);
  for (const key of ['r', 'a', 'Enter', 'l', 'Escape']) await press(f.session, key, { repeat: true });
  assert.deepEqual(snapshot(f.session), before); assert.equal(writes(f), 0);
  assert.equal(f.ioCalls.filter(c => c.method === 'pick').length, 0);
});

test('[UX-08] busy save consumes r/a/confirm with no duplicate or deferred action', { timeout: 2000 }, async () => {
  const started = deferred(), gate = deferred();
  const f = await fixture('roots', { saveHook: async () => { started.resolve(); await gate.promise; } });
  await press(f.session, 'j'); const switching = press(f.session, 'Enter');
  await started.promise;
  try {
    for (const key of ['r', 'a', 'Enter', 'l']) assert.equal(await press(f.session, key), true);
    assert.equal(writes(f), 1); assert.equal(f.ioCalls.filter(c => c.method === 'pick').length, 0);
  } finally { gate.resolve(); await switching; }
  assert.equal(f.saved().primaryId, 'r-b'); assert.equal(f.session.view, 'browse');
  await Promise.resolve(); assert.equal(writes(f), 1);
  assert.equal(f.ioCalls.filter(c => c.method === 'pick').length, 0);
});

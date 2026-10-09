import test from 'node:test';
import assert from 'node:assert/strict';
import { contract, directory, file, state, sessionFixture, press, deferred } from './helpers/local-browser-fixtures.mjs';

test('[UI-04] selecting a registered row by mouse does not persist the primary', async () => {
  const f = await sessionFixture(); await press(f.session, 'h');
  assert.equal(typeof f.session.select, 'function', 'Session.select(index) is required for DOM selection');
  f.session.select(1);
  assert.equal(f.session.selectedIndex, 1); assert.equal(f.saved().primaryId, 'r-a');
  assert.equal(f.ioCalls.filter(c => c.method === 'save').length, 0);
  await press(f.session, 'Enter'); assert.equal(f.saved().primaryId, 'r-b');
});

test('[UI-04] mouse selection uses the filtered list and ignores invalid indices', async () => {
  const f = await sessionFixture(); f.session.setFilter('pdf');
  assert.equal(typeof f.session.select, 'function');
  f.session.select(1); assert.equal(f.session.entries[f.session.selectedIndex].name, 'z.pdf');
  for (const index of [-1, 100, NaN, 0.5]) {
    f.session.select(index); assert.equal(f.session.selectedIndex, 1);
  }
  await press(f.session, 'Enter'); assert.match(f.calls[0][1], /\/z.pdf$/);
});

test('[UI-03] mouse selection cannot mutate a pending read', async () => {
  const gate = deferred();
  const f = await sessionFixture();
  const first = f.a.values; f.a.values = async function* () { await gate.promise; yield* first.call(this); };
  assert.equal(typeof f.session.select, 'function');
  const refreshing = f.session.refresh();
  try { f.session.select(2); assert.equal(f.session.selectedIndex, 0); }
  finally { gate.resolve(); await refreshing; }
});

test('[UI-06] the registered-folder button works inside a child and Esc restores its filter', async () => {
  const f = await sessionFixture(); await press(f.session, 'Enter'); f.session.setFilter('lesson');
  assert.equal(typeof f.session.openRoots, 'function', 'Session.openRoots() is required for the toolbar');
  f.session.openRoots(); assert.equal(f.session.view, 'roots');
  await press(f.session, 'Escape');
  assert.equal(f.session.view, 'browse'); assert.equal(f.session.filter, 'lesson');
  assert.equal(f.session.entries[0].name, 'lesson.pdf');
});

test('[UI-04] removing the active root invalidates its chooser cancellation snapshot', async () => {
  const f = await sessionFixture(); await press(f.session, 'Enter');
  assert.equal(typeof f.session.openRoots, 'function'); assert.equal(typeof f.session.removeRoot, 'function');
  f.session.openRoots(); await f.session.removeRoot('r-a');
  assert.equal(f.saved().primaryId, 'r-b'); await press(f.session, 'Escape');
  assert.notEqual(f.session.activeRootId, 'r-a');
  assert.equal(f.session.view, 'roots'); assert.deepEqual(f.session.entries.map(e => e.id), ['r-b']);
});

test('[UI-04] failed removal preserves the chooser and cancellation snapshot', async () => {
  const f = await sessionFixture(); await press(f.session, 'Enter'); f.session.setFilter('lesson');
  assert.equal(typeof f.session.openRoots, 'function'); assert.equal(typeof f.session.removeRoot, 'function');
  f.session.openRoots(); f.failSave(new Error('quota'));
  await assert.rejects(f.session.removeRoot('r-a'), /quota/);
  assert.equal(f.saved().primaryId, 'r-a'); assert.equal(f.session.busy, false);
  await press(f.session, 'Escape'); assert.equal(f.session.filter, 'lesson');
});

test('[UI-02] removing the last registered root returns to the empty screen without reading it', async () => {
  const a = directory('University', [file('a.pdf')]);
  const f = await sessionFixture({ a, roots: [{ id: 'r-a', handle: a }] });
  await press(f.session, 'h'); assert.equal(typeof f.session.removeRoot, 'function');
  const reads = a.calls.filter(c => c.method === 'values').length;
  await f.session.removeRoot('r-a');
  assert.equal(f.session.view, 'empty'); assert.equal(f.session.activeRootId, null);
  assert.equal(f.session.selectedIndex, -1); assert.equal(f.saved().primaryId, null);
  assert.equal(a.calls.filter(c => c.method === 'values').length, reads);
});

test('[DB-04] confirming an unchanged in-memory primary still detects another tab changing it', async () => {
  const roots = [{ id: 'a', handle: directory('A') }, { id: 'b', handle: directory('B') }];
  let revision = 1; let persisted = state(roots, 'a');
  function storage() {
    let expected;
    return {
      load: async () => { expected = revision; return persisted; },
      save: async next => {
        if (expected !== revision) throw Object.assign(new Error('Registry changed'), { code: 'storage-conflict' });
        persisted = next; expected = ++revision;
      }, pick: async () => assert.fail('no picker'), newId: () => assert.fail('no new ID'),
    };
  }
  const first = new (contract().FolderRegistry)(storage());
  const second = new (contract().FolderRegistry)(storage());
  await first.restore(); await second.restore(); await second.activate('b');
  await assert.rejects(first.activate('a'), { code: 'storage-conflict' });
  assert.equal(persisted.primaryId, 'b'); assert.equal(first.primaryId, 'a');
  await first.restore(); await first.activate('a'); assert.equal(persisted.primaryId, 'a');
});

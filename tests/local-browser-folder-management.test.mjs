import test from 'node:test';
import assert from 'node:assert/strict';
import { directory, file, state, registryFixture, sessionFixture, press, deferred } from './helpers/local-browser-fixtures.mjs';

function snapshot(registry) {
  return state(registry.roots.map(root => ({ ...root })), registry.primaryId);
}

test('[FM-04/FM-05] unregistering a revoked primary preserves remaining handles and order without any filesystem access', async () => {
  const handles = [directory('Same'), directory('Same', [], { permission: 'denied' }), directory('Other')];
  const roots = handles.map((handle, i) => ({ id: `r-${i}`, handle }));
  const f = registryFixture(state(roots)); await f.registry.restore();
  for (const handle of handles) {
    handle.setPermission('denied'); handle.calls.length = 0;
    for (const method of ['queryPermission', 'requestPermission', 'values', 'removeEntry']) {
      handle[method] = () => assert.fail(`Unregister must not call ${method}`);
    }
  }
  await f.registry.remove('r-0');
  assert.deepEqual(snapshot(f.registry), state(roots.slice(1), 'r-1'));
  assert.deepEqual(f.saved(), state(roots.slice(1), 'r-1'));
  assert.equal(f.registry.roots[0].handle, handles[1]);
  assert.equal(f.registry.roots[1].handle, handles[2]);
  assert.equal(f.generated(), 0);
});

test('[FM-05/FM-08] pending unregister publishes neither half of the change and rejects overlapping mutations', async () => {
  const gate = deferred();
  const roots = ['a', 'b', 'c'].map(id => ({ id, handle: directory(id) }));
  const f = registryFixture(state(roots), { saveHook: () => gate.promise });
  await f.registry.restore(); const before = f.saved();
  const removing = f.registry.remove('a');
  try {
    assert.deepEqual(snapshot(f.registry), before); assert.deepEqual(f.saved(), before);
    await assert.rejects(f.registry.remove('b'), /progress/i);
    await assert.rejects(f.registry.add(), /progress/i);
    await assert.rejects(f.registry.activate('c'), /progress/i);
    assert.equal(f.calls.filter(call => call.method === 'save').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'pick').length, 0);
  } finally { gate.resolve(); await removing; }
  assert.deepEqual(snapshot(f.registry), state(roots.slice(1), 'b'));
  assert.deepEqual(f.saved(), state(roots.slice(1), 'b'));
});

test('[FM-07] a delayed failed unregister retains the primary, handles and full registration order', async () => {
  const gate = deferred();
  const roots = ['a', 'b', 'c'].map(id => ({ id, handle: directory(id) }));
  const f = registryFixture(state(roots), { saveHook: () => gate.promise });
  await f.registry.restore(); const before = f.saved();
  const removing = f.registry.remove('a');
  const rejected = assert.rejects(removing, /commit aborted/);
  assert.deepEqual(snapshot(f.registry), before);
  gate.reject(new Error('commit aborted')); await rejected;
  assert.deepEqual(snapshot(f.registry), before); assert.deepEqual(f.saved(), before);
  assert.equal(f.generated(), 0);
});

test('[FM-05] an unknown or already removed ID cannot unregister a different folder or write again', async () => {
  const roots = ['a', 'b'].map(id => ({ id, handle: directory('Same') }));
  const f = registryFixture(state(roots)); await f.registry.restore();
  await f.registry.remove('b'); const before = f.saved();
  const writes = f.calls.filter(call => call.method === 'save').length;
  for (const id of ['b', 'missing', '', 1, null]) await assert.rejects(f.registry.remove(id), /unknown|registered/i);
  assert.deepEqual(snapshot(f.registry), before); assert.deepEqual(f.saved(), before);
  assert.equal(f.calls.filter(call => call.method === 'save').length, writes);
});

test('[FM-04/FM-05] unregistering another root preserves Escape return to the active child, filter and selection', async () => {
  const f = await sessionFixture(); await press(f.session, 'Enter');
  f.session.setFilter('lesson'); const before = f.session.entries[0];
  f.session.openRoots(); f.session.setFilter('Books');
  await f.session.removeRoot('r-b'); await press(f.session, 'Escape');
  assert.equal(f.session.view, 'browse'); assert.equal(f.session.activeRootId, 'r-a');
  assert.match(f.session.location, /course/); assert.equal(f.session.filter, 'lesson');
  assert.equal(f.session.selectedIndex, 0); assert.equal(f.session.entries[0].name, before.name);
  assert.deepEqual(f.saved().roots.map(root => root.id), ['r-a']); assert.equal(f.saved().primaryId, 'r-a');
});

test('[FM-03/FM-06] reauthorization retains PDF identity but unregistering and re-registering the same folder creates a new identity', async () => {
  const a = directory('Library', [file('lesson.pdf')], { requestedPermission: 'granted' });
  const f = await sessionFixture({ a, roots: [{ id: 'r-a', handle: a }] });
  await press(f.session, 'Enter'); const original = f.calls[0][1];
  a.setPermission('prompt'); f.session.openRoots(); await press(f.session, 'Enter');
  assert.equal(f.session.view, 'permission'); assert.equal(f.saved().primaryId, 'r-a');
  await press(f.session, 'Enter'); await press(f.session, 'Enter');
  assert.equal(f.calls[1][1], original); assert.equal(f.saved().roots[0].id, 'r-a');
  await f.session.removeRoot('r-a'); assert.equal(f.session.view, 'empty');
  f.choose(a); await press(f.session, 'Enter'); await press(f.session, 'Enter');
  assert.notEqual(f.calls[2][1], original); assert.notEqual(f.saved().roots[0].id, 'r-a');
  assert.equal(f.saved().roots[0].handle, a); assert.match(f.calls[2][1], /\/lesson\.pdf$/);
});

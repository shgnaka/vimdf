import test from 'node:test';
import assert from 'node:assert/strict';
import { contract, directory, state, registryFixture, methods } from './helpers/local-browser-fixtures.mjs';

function twoRoots(options = {}) {
  const a = directory('University');
  const b = directory('Books', [], options);
  const f = registryFixture(state([{ id: 'a', handle: a }, { id: 'b', handle: b }], 'a'));
  return { ...f, a, b };
}
function summary(registry) {
  return { ids: registry.roots.map(root => root.id), primaryId: registry.primaryId };
}

test('the first added folder becomes the persisted primary using read permission only', async () => {
  const f = registryFixture();
  const handle = directory('University');
  f.choose(handle);
  const added = await f.registry.add();
  assert.equal(added.id, 'root-1');
  assert.equal(added.handle, handle);
  assert.deepEqual(summary(f.registry), { ids: ['root-1'], primaryId: 'root-1' });
  assert.equal(f.saved().primaryId, 'root-1');
  assert.equal(f.saved().roots[0].handle, handle);
  assert.equal(f.saved().version, 1);
  assert.deepEqual(f.calls.find(call => call.method === 'pick').options, { mode: 'read' });
  assert.deepEqual(methods(handle, 'queryPermission')[0].options, { mode: 'read' });
  assert.equal(methods(handle, 'requestPermission').length, 0);
});

test('adding more folders preserves registration order and the existing primary', async () => {
  const f = registryFixture();
  const a = directory('University'), b = directory('Books');
  f.choose(a); await f.registry.add();
  f.choose(b); await f.registry.add();
  assert.deepEqual(summary(f.registry), { ids: ['root-1', 'root-2'], primaryId: 'root-1' });
  assert.deepEqual(f.saved().roots.map(root => root.handle), [a, b]);
});

test('registering the same physical folder reuses its ID without saving or changing primary', async () => {
  const f = registryFixture();
  const a = directory('University', [], { identity: 'same-directory' });
  const again = directory('Renamed display', [], { identity: 'same-directory' });
  f.choose(a); await f.registry.add();
  const saves = f.calls.filter(call => call.method === 'save').length;
  f.choose(again);
  const root = await f.registry.add();
  assert.equal(root.id, 'root-1');
  assert.deepEqual(summary(f.registry), { ids: ['root-1'], primaryId: 'root-1' });
  assert.equal(f.generated(), 1);
  assert.equal(f.calls.filter(call => call.method === 'save').length, saves);
});

test('different folders with the same display name can both be registered', async () => {
  const f = registryFixture();
  f.choose(directory('Documents')); await f.registry.add();
  f.choose(directory('Documents')); await f.registry.add();
  assert.equal(f.registry.roots.length, 2);
  assert.notEqual(f.registry.roots[0].id, f.registry.roots[1].id);
});

test('cancelling the folder picker leaves registration and primary unchanged', async () => {
  const f = twoRoots(); await f.registry.restore();
  const before = f.saved();
  assert.equal(await f.registry.add(), null);
  assert.deepEqual(f.saved(), before);
  assert.deepEqual(summary(f.registry), { ids: ['a', 'b'], primaryId: 'a' });
  assert.equal(f.calls.filter(call => call.method === 'save').length, 0);
});

test('picker failures propagate without changing registered folders', async () => {
  const f = twoRoots(); await f.registry.restore();
  f.failPick(new Error('picker unavailable'));
  await assert.rejects(f.registry.add(), /picker unavailable/);
  assert.deepEqual(summary(f.registry), { ids: ['a', 'b'], primaryId: 'a' });
  assert.equal(f.calls.filter(call => call.method === 'save').length, 0);
});

test('a picked folder without read permission is not registered', async () => {
  const f = registryFixture();
  const denied = directory('No access', [], { permission: 'denied' });
  f.choose(denied);
  assert.equal(await f.registry.add(), null);
  assert.deepEqual(summary(f.registry), { ids: [], primaryId: null });
  assert.equal(f.generated(), 0);
  assert.equal(f.saved(), null);
  assert.equal(methods(denied, 'requestPermission').length, 0);
});

test('restoration loads all registrations and returns only the saved primary without scanning', async () => {
  const a = directory('University'), b = directory('Books');
  const f = registryFixture(state([{ id: 'a', handle: a }, { id: 'b', handle: b }], 'b'));
  const primary = await f.registry.restore();
  assert.equal(primary.id, 'b');
  assert.equal(primary.handle, b);
  assert.deepEqual(summary(f.registry), { ids: ['a', 'b'], primaryId: 'b' });
  assert.deepEqual(methods(b, 'queryPermission')[0].options, { mode: 'read' });
  assert.equal(methods(a, 'queryPermission').length, 0);
  assert.equal(methods(a, 'values').length + methods(b, 'values').length, 0);
  assert.equal(f.calls.filter(call => call.method === 'save').length, 0);
});

test('an unavailable primary is retained without requesting permission or choosing another root', async () => {
  const f = twoRoots(); f.a.setPermission('prompt');
  assert.equal(await f.registry.restore(), null);
  assert.deepEqual(summary(f.registry), { ids: ['a', 'b'], primaryId: 'a' });
  assert.equal(methods(f.a, 'requestPermission').length, 0);
  assert.equal(methods(f.b, 'queryPermission').length, 0);
  assert.equal(f.saved().primaryId, 'a');
});

test('activating a readable registered folder persists its existing ID as primary', async () => {
  const f = twoRoots(); await f.registry.restore();
  const selected = await f.registry.activate('b');
  assert.equal(selected.id, 'b');
  assert.equal(selected.handle, f.b);
  assert.deepEqual(summary(f.registry), { ids: ['a', 'b'], primaryId: 'b' });
  assert.equal(f.saved().primaryId, 'b');
  assert.equal(f.generated(), 0);
  assert.deepEqual(methods(f.b, 'queryPermission')[0].options, { mode: 'read' });
});

test('an unknown root cannot be activated or authorized', async () => {
  const f = twoRoots(); await f.registry.restore();
  await assert.rejects(f.registry.activate('missing'), /registered|unknown/i);
  await assert.rejects(f.registry.authorize('missing'), /registered|unknown/i);
  assert.equal(f.saved().primaryId, 'a');
  assert.equal(f.calls.filter(call => call.method === 'save').length, 0);
});

test('activation without permission never prompts, persists or changes primary', async () => {
  const f = twoRoots({ permission: 'prompt' }); await f.registry.restore();
  assert.equal(await f.registry.activate('b'), null);
  assert.equal(f.registry.primaryId, 'a');
  assert.equal(f.saved().primaryId, 'a');
  assert.equal(methods(f.b, 'requestPermission').length, 0);
  assert.equal(f.calls.filter(call => call.method === 'save').length, 0);
});

test('explicit authorization requests read access and persists primary only after grant', async () => {
  const f = twoRoots({ permission: 'prompt', requestedPermission: 'granted' });
  await f.registry.restore();
  const root = await f.registry.authorize('b');
  assert.equal(root.id, 'b');
  assert.deepEqual(methods(f.b, 'requestPermission')[0].options, { mode: 'read' });
  assert.equal(f.registry.primaryId, 'b');
  assert.equal(f.saved().primaryId, 'b');
});

test('denied authorization preserves primary and registrations', async () => {
  const f = twoRoots({ permission: 'denied' }); await f.registry.restore();
  assert.equal(await f.registry.authorize('b'), null);
  assert.deepEqual(methods(f.b, 'requestPermission')[0].options, { mode: 'read' });
  assert.deepEqual(summary(f.registry), { ids: ['a', 'b'], primaryId: 'a' });
  assert.equal(f.saved().primaryId, 'a');
  assert.equal(f.calls.filter(call => call.method === 'save').length, 0);
});

test('permission API failures propagate without changing primary', async () => {
  const f = twoRoots(); await f.registry.restore();
  f.b.queryPermission = async () => { throw new Error('query failed'); };
  await assert.rejects(f.registry.activate('b'), /query failed/);
  f.b.requestPermission = async () => { throw new Error('request failed'); };
  await assert.rejects(f.registry.authorize('b'), /request failed/);
  assert.equal(f.registry.primaryId, 'a');
  assert.equal(f.saved().primaryId, 'a');
});

test('failure to save a primary change leaves both memory and persistence unchanged', async () => {
  const f = twoRoots(); await f.registry.restore();
  f.failSave(new Error('database full'));
  await assert.rejects(f.registry.activate('b'), /database full/);
  assert.deepEqual(summary(f.registry), { ids: ['a', 'b'], primaryId: 'a' });
  assert.equal(f.saved().primaryId, 'a');
});

test('failure to save after a permission grant still preserves the previous primary', async () => {
  const f = twoRoots({ permission: 'prompt', requestedPermission: 'granted' });
  await f.registry.restore();
  f.failSave(new Error('database full'));
  await assert.rejects(f.registry.authorize('b'), /database full/);
  assert.equal(methods(f.b, 'requestPermission').length, 1);
  assert.deepEqual(summary(f.registry), { ids: ['a', 'b'], primaryId: 'a' });
  assert.equal(f.saved().primaryId, 'a');
});

test('failure to load registrations does not prompt or overwrite persistence', async () => {
  const { FolderRegistry } = contract();
  const registry = new FolderRegistry({
    load: async () => { throw new Error('load failed'); },
    save: async () => assert.fail('must not overwrite'),
    pick: async () => assert.fail('must not prompt'),
    newId: () => assert.fail('must not generate an ID'),
  });
  await assert.rejects(registry.restore(), /load failed/);
});

test('failure to save a new registration never exposes a partially added folder', async () => {
  const f = twoRoots(); await f.registry.restore();
  f.choose(directory('Work')); f.failSave(new Error('save failed'));
  await assert.rejects(f.registry.add(), /save failed/);
  assert.deepEqual(summary(f.registry), { ids: ['a', 'b'], primaryId: 'a' });
  assert.deepEqual(f.saved().roots.map(root => root.id), ['a', 'b']);
});

test('failure to save the first registration does not create an unsaved primary', async () => {
  const f = registryFixture();
  f.choose(directory('University')); f.failSave(new Error('save failed'));
  await assert.rejects(f.registry.add(), /save failed/);
  assert.deepEqual(summary(f.registry), { ids: [], primaryId: null });
  assert.equal(f.saved(), null);
});

test('removing a non-primary folder preserves the current primary', async () => {
  const f = twoRoots(); await f.registry.restore();
  await f.registry.remove('b');
  assert.deepEqual(summary(f.registry), { ids: ['a'], primaryId: 'a' });
  assert.deepEqual(f.saved().roots.map(root => root.id), ['a']);
});

test('removing the primary selects the first remaining registration deterministically', async () => {
  const a = directory('A'), b = directory('B'), c = directory('C', [], { permission: 'denied' });
  const f = registryFixture(state([
    { id: 'a', handle: a }, { id: 'c', handle: c }, { id: 'b', handle: b },
  ], 'a'));
  await f.registry.restore(); await f.registry.remove('a');
  assert.deepEqual(summary(f.registry), { ids: ['c', 'b'], primaryId: 'c' });
  assert.equal(f.saved().primaryId, 'c');
  assert.equal(methods(c, 'requestPermission').length, 0);
});

test('removing the last registration clears primary and references without deleting local files', async () => {
  const handle = directory('A');
  handle.removeEntry = () => { assert.fail('must not modify local files'); };
  const f = registryFixture(state([{ id: 'a', handle }]));
  await f.registry.restore(); await f.registry.remove('a');
  assert.deepEqual(summary(f.registry), { ids: [], primaryId: null });
  assert.deepEqual(f.saved(), state());
  assert.equal(await f.registry.restore(), null);
});

test('failure to save a removal preserves registrations and primary', async () => {
  const f = twoRoots(); await f.registry.restore();
  f.failSave(new Error('remove failed'));
  await assert.rejects(f.registry.remove('a'), /remove failed/);
  assert.deepEqual(summary(f.registry), { ids: ['a', 'b'], primaryId: 'a' });
  assert.deepEqual(f.saved().roots.map(root => root.id), ['a', 'b']);
});

test('failure to compare duplicate handles does not create a duplicate registration', async () => {
  const f = twoRoots(); await f.registry.restore();
  f.a.isSameEntry = async () => { throw new Error('comparison failed'); };
  f.b.isSameEntry = async () => { throw new Error('comparison failed'); };
  const picked = directory('Work');
  picked.isSameEntry = async () => { throw new Error('comparison failed'); };
  f.choose(picked);
  await assert.rejects(f.registry.add(), /comparison failed/);
  assert.deepEqual(summary(f.registry), { ids: ['a', 'b'], primaryId: 'a' });
  assert.equal(f.calls.filter(call => call.method === 'save').length, 0);
});

test('an empty stored registry restores without querying or prompting', async () => {
  const f = registryFixture(state());
  assert.equal(await f.registry.restore(), null);
  assert.deepEqual(summary(f.registry), { ids: [], primaryId: null });
  assert.deepEqual(f.calls.map(call => call.method), ['load']);
});

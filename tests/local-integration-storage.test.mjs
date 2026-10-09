import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore, IDBVersionChangeEvent } from 'fake-indexeddb';
import { implementation, broadcastFixture, openDB, record, storedState, settled } from './helpers/local-integration.mjs';

async function fixture(t, options = {}) {
  const create = await implementation('src/local-browser/indexeddb.ts', 'createFolderStorage');
  const factory = options.factory ?? new IDBFactory(); const bus = options.bus ?? broadcastFixture();
  const notices = []; const versionChanges = [];
  const { factory: unusedFactory, bus: unusedBus, ...adapterOptions } = options;
  const storage = await create({ indexedDB: factory, BroadcastChannel: bus.Channel,
    pick: () => assert.fail('storage initialization must not open a picker'),
    newId: () => crypto.randomUUID(), onChanged: value => notices.push(value),
    onVersionChange: value => versionChanges.push(value), ...adapterOptions });
  t.after(() => storage.close());
  return { factory, bus, notices, versionChanges, storage };
}

test('[DB-01] fresh storage is null and saves a versioned envelope in the specified store', async t => {
  const f = await fixture(t); assert.equal(await f.storage.load(), null);
  const state = storedState(); await f.storage.save(state);
  assert.deepEqual(await record(f.factory), { revision: 1, state });
  assert.deepEqual(await f.storage.load(), state);
});

test('[DB-01] a new adapter restores ordering, IDs and primary without generating IDs or prompting', async t => {
  const factory = new IDBFactory(); await record(factory, { revision: 6, state: storedState('b') }, true);
  const f = await fixture(t, { factory, newId: () => assert.fail('restoration must preserve IDs') });
  assert.deepEqual(await f.storage.load(), storedState('b'));
  assert.equal((await record(factory)).revision, 6);
});

test('[DB-02] request success followed by transaction abort rejects and retains the old record', async t => {
  const f = await fixture(t); await f.storage.load(); await f.storage.save(storedState());
  const put = IDBObjectStore.prototype.put; let successfulRequest = false;
  t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
    const request = put.apply(this, args);
    request.addEventListener('success', () => { successfulRequest = true; this.transaction.abort(); }, { once: true });
    return request;
  });
  await assert.rejects(f.storage.save(storedState('b')));
  assert.equal(successfulRequest, true, 'must reach put success before abort');
  assert.deepEqual(await record(f.factory), { revision: 1, state: storedState() });
  assert.equal(f.bus.sent.length, 1, 'only the earlier committed write was announced');
});

test('[DB-03] competing whole-state writes from one revision commit exactly once', async t => {
  const factory = new IDBFactory(); const bus = broadcastFixture();
  const a = await fixture(t, { factory, bus }); const b = await fixture(t, { factory, bus });
  await a.storage.load(); await b.storage.load();
  const states = [storedState('a'), storedState('b')];
  const results = await Promise.allSettled([a.storage.save(states[0]), b.storage.save(states[1])]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const loser = results.find(r => r.status === 'rejected'); assert.equal(loser.reason.code, 'storage-conflict');
  const winner = results.findIndex(r => r.status === 'fulfilled');
  assert.deepEqual(await record(factory), { revision: 1, state: states[winner] });
  assert.equal(bus.sent.length, 1);
});

test('[DB-03] a stale save neither overwrites the winner nor retries without a new load', async t => {
  const factory = new IDBFactory();
  const a = await fixture(t, { factory }); const b = await fixture(t, { factory });
  await a.storage.load(); await b.storage.load(); await a.storage.save(storedState('b'));
  for (let i = 0; i < 2; i++) await assert.rejects(b.storage.save(storedState()), { code: 'storage-conflict' });
  assert.equal((await record(factory)).revision, 1);
  await b.storage.load(); await b.storage.save(storedState());
  assert.deepEqual(await record(factory), { revision: 2, state: storedState() });
});

test('[DB-02] every fulfilled save is already visible to another independent transaction', async t => {
  const f = await fixture(t); await f.storage.load();
  for (const primary of ['a', 'b', 'a']) {
    await f.storage.save(storedState(primary)); assert.equal((await record(f.factory)).state.primaryId, primary);
  }
  assert.equal((await record(f.factory)).revision, 3);
});

test('[DB-05] committed changes broadcast revision only and do not silently replace a loaded snapshot', async t => {
  const factory = new IDBFactory(); const bus = broadcastFixture();
  const a = await fixture(t, { factory, bus }); const b = await fixture(t, { factory, bus });
  await a.storage.load(); const before = await b.storage.load();
  await a.storage.save(storedState('b')); await settled();
  assert.deepEqual(bus.sent, [{ name: 'vimdf.local-browser.registry.v1', data: { revision: 1 } }]);
  assert.equal(before, null); assert.equal(b.notices.length, 1);
  await assert.rejects(b.storage.save(storedState()), { code: 'storage-conflict' });
});

test('[DB-05] foreground revision check notices missed broadcasts without updating the expected revision', async t => {
  const f = await fixture(t); await f.storage.load();
  assert.equal(await f.storage.checkRevision(), false);
  await record(f.factory, { revision: 3, state: storedState('b') }, true);
  assert.equal(await f.storage.checkRevision(), true);
  await assert.rejects(f.storage.save(storedState()), { code: 'storage-conflict' });
  await f.storage.load(); assert.equal(await f.storage.checkRevision(), false);
});

test('[DB-06] invalid and future envelopes are rejected without resetting the stored value', async t => {
  for (const invalid of [{ revision: -1, state: storedState() }, { revision: 0.5, state: storedState() },
    { revision: Number.MAX_SAFE_INTEGER + 1, state: storedState() }, { revision: NaN, state: storedState() },
    { revision: 1, state: { ...storedState(), version: 2 } }, { state: storedState() }, { revision: 1 }]) {
    const factory = new IDBFactory(); await record(factory, invalid, true);
    const f = await fixture(t, { factory }); await assert.rejects(f.storage.load(), /invalid|version|revision/i);
    await assert.rejects(f.storage.save(storedState()), /load|restore|invalid/i);
    assert.deepEqual(await record(factory), invalid); assert.equal(f.bus.sent.length, 0);
  }
});

test('[DB-06] future DB schema does not get reopened as an empty version-one database', async t => {
  const create = await implementation('src/local-browser/indexeddb.ts', 'createFolderStorage');
  const factory = new IDBFactory(); const db = await openDB(factory, 2); db.close();
  await assert.rejects(create({ indexedDB: factory, BroadcastChannel: broadcastFixture().Channel,
    pick: () => assert.fail('no picker'), newId: () => assert.fail('no ID') }));
  const intact = await openDB(factory, 2); assert.equal(intact.version, 2); intact.close();
});

test('[DB-06] quota failure retains old data and publishes no revision notification', async t => {
  const f = await fixture(t); await f.storage.load(); await f.storage.save(storedState());
  t.mock.method(IDBObjectStore.prototype, 'put', () => { throw new DOMException('full', 'QuotaExceededError'); });
  await assert.rejects(f.storage.save(storedState('b')), { name: 'QuotaExceededError' });
  assert.deepEqual(await record(f.factory), { revision: 1, state: storedState() }); assert.equal(f.bus.sent.length, 1);
});

test('[DB-06] versionchange closes the old connection so an upgrade completes', { timeout: 2000 }, async t => {
  const f = await fixture(t); await f.storage.load();
  const upgraded = await openDB(f.factory, 2);
  try { assert.equal(upgraded.version, 2); assert.equal(f.versionChanges.length, 1); }
  finally { upgraded.close(); }
});

test('[DB-06] failed open propagates without a picker, fallback storage or success notification', async t => {
  const create = await implementation('src/local-browser/indexeddb.ts', 'createFolderStorage');
  await assert.rejects(create({ indexedDB: { open() { throw new DOMException('unavailable', 'SecurityError'); } },
    BroadcastChannel: broadcastFixture().Channel, pick: () => assert.fail('no picker'),
    newId: () => assert.fail('no ID') }), { name: 'SecurityError' });
});

test('[DB-06] a blocked open request reports the reason instead of silently showing success', async t => {
  const create = await implementation('src/local-browser/indexeddb.ts', 'createFolderStorage');
  const factory = new IDBFactory(); let calls = 0;
  // Version 1 has no older schema to upgrade. Inject just the native request
  // event; actual blocking across extension windows is a manual release check.
  const storage = await create({ indexedDB: { open() {
    const r = factory.open('vimdf.local-browser', 1);
    queueMicrotask(() => r.dispatchEvent(new IDBVersionChangeEvent('blocked', { oldVersion: 0, newVersion: 1 })));
    return r;
  } }, BroadcastChannel: broadcastFixture().Channel,
    pick: () => assert.fail('no picker'), newId: () => 'id', onBlocked: () => { calls++; } });
  t.after(() => storage.close()); assert.equal(calls, 1);
});

test('[DB-06] exhausted revision cannot overflow into an unsafe integer or publish a successful write', async t => {
  const factory = new IDBFactory(); const envelope = { revision: Number.MAX_SAFE_INTEGER, state: storedState() };
  await record(factory, envelope, true); const f = await fixture(t, { factory }); await f.storage.load();
  await assert.rejects(f.storage.save(storedState('b')), /revision|exhaust|overflow/i);
  assert.deepEqual(await record(factory), envelope); assert.equal(f.bus.sent.length, 0);
});

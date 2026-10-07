import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalPasswordStore } from '../src/common/password-store.ts';

function fixture(incognito = false, signal) {
  const calls = [];
  let data = {};
  let queue = Promise.resolve();
  const storage = {
    async setAccessLevel(value) { calls.push(['protect',value]); },
    async get() { calls.push(['read']); return structuredClone(data); },
    async set(value) { calls.push(['write']); data = structuredClone(value); },
  };
  const lock = fn => { const result = queue.then(fn); queue = result.catch(()=>{}); return result; };
  const store = new LocalPasswordStore(storage, incognito, lock, signal);
  return {store,calls,storage,lock};
}
const draft = (password, shared=true) => ({name:'Course',password,shared});

test('storage access is restricted before loading or saving secrets', async () => {
  const f=fixture(); await f.store.register(draft('a'));
  assert.deepEqual(f.calls[0], ['protect',{accessLevel:'TRUSTED_CONTEXTS'}]);
  assert.equal((await f.store.vault()).version,1);
});
test('incognito reads no normal-profile secrets and writes nothing', async () => {
  const f=fixture(true);
  assert.deepEqual(await f.store.read('pdf'),{records:[],rememberedId:null});
  await assert.rejects(f.store.register(draft('a')));
  await assert.rejects(f.store.clear());
  assert.deepEqual(f.calls,[]);
});
test('successful manual save reuses existing secret and preserves its scope', async () => {
  const f=fixture(); await f.store.register(draft('a',false));
  const before=await f.store.vault(); await f.store.save('pdf',draft('a'));
  const after=await f.store.vault();
  assert.equal(after.records.length,1); assert.equal(after.records[0].shared,false);
  assert.equal(after.remembered.pdf,before.records[0].id);
});
test('editing and disabling a password persist, empty replacement is rejected', async () => {
  const f=fixture(); await f.store.register(draft('a'));
  const id=(await f.store.vault()).records[0].id;
  await f.store.update(id,{password:' b ',name:'Changed',enabled:false});
  assert.equal((await f.store.vault()).records[0].password,' b ');
  assert.equal((await f.store.vault()).records[0].enabled,false);
  await assert.rejects(f.store.update(id,{password:''}));
  assert.equal((await f.store.vault()).records[0].password,' b ');
});
test('deleting registration also removes remembered document links', async () => {
  const f=fixture(); await f.store.save('pdf',draft('a'));
  const id=(await f.store.vault()).records[0].id;
  await f.store.remove(id);
  assert.deepEqual(await f.store.read('pdf'),{records:[],rememberedId:null});
});
test('reordering controls candidate order and clear removes all registrations', async () => {
  const f=fixture(); await f.store.register(draft('a')); await f.store.register(draft('b'));
  const id=(await f.store.vault()).records[1].id; await f.store.move(id,-1);
  assert.deepEqual((await f.store.read('pdf')).records.map(x=>x.password),['b','a']);
  await f.store.clear(); assert.deepEqual((await f.store.vault()).records,[]);
});
test('global autofill switch hides stored candidates without deleting them', async () => {
  const f=fixture(); await f.store.register(draft('a')); await f.store.setAutoFill(false);
  assert.deepEqual((await f.store.read('pdf')).records,[]);
  assert.equal((await f.store.vault()).records.length,1);
});
test('simultaneous registrations from different instances do not lose updates', async () => {
  const f=fixture(); const second=new LocalPasswordStore(f.storage,false,f.lock);
  await Promise.all([f.store.register(draft('a')),second.register(draft('b'))]);
  assert.equal((await f.store.vault()).records.length,2);
});
test('cancelled document does not write queued registration', async () => {
  const controller=new AbortController(); const f=fixture(false,controller.signal);
  controller.abort(); await assert.rejects(f.store.save('pdf',draft('a')),{name:'AbortError'});
  assert.equal(f.calls.filter(x=>x[0]==='write').length,0);
});
test('corrupt vault is not silently overwritten; explicit clear recovers it', async () => {
  const f=fixture(); await f.storage.set({'vimdf.passwords.v1':{version:99}});
  await assert.rejects(f.store.register(draft('a')));
  await f.store.clear(); assert.equal((await f.store.vault()).version,1);
});

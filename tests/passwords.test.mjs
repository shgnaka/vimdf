import nodeTest from 'node:test';
import assert from 'node:assert/strict';

// Contract tests exercise the same implementation used by the viewer.
const api = () => import('../src/viewer/passwords.ts');
const test = (name, fn) => nodeTest(name, {timeout: 2000}, fn);
const record = (id, password, extra = {}) => ({id, name: id, password, enabled: true, shared: true, ...extra});
const records = [record('a', 'wrong'), record('b', 'correct')];

function fixture({password = 'correct', encrypted = true, readError = false, saveError = false, answers = [], autoFill = true} = {}) {
  let resolve, reject;
  const attempts = [], prompts = [], remembered = [], saved = [], notices = [];
  let destroyed = 0;
  const task = {
    promise: new Promise((yes, no) => {resolve = yes; reject = no;}),
    destroy() {destroyed++; reject(new DOMException('Cancelled', 'AbortError')); return Promise.resolve();},
  };
  const document = {numPages: 1};
  const request = (reason) => task.onPassword((value) => {
    attempts.push(value);
    queueMicrotask(() => value === password ? resolve(document) : request(2));
  }, reason);
  const store = {
    async read() {if (readError) throw new Error('Storage unavailable'); return {records, rememberedId: null};},
    async remember(...args) {if (saveError) throw new Error('Storage unavailable'); remembered.push(args);},
    async save(...args) {if (saveError) throw new Error('Storage unavailable'); saved.push(args);},
  };
  const options = {task, documentKey: 'https://example.test/a.pdf', store, autoFill,
    async prompt(info) {prompts.push(info); return answers.shift() ?? null;},
    onSaveError() {notices.push(true);},
  };
  return {options, attempts, prompts, remembered, saved, notices, document, reject,
    get destroyed() {return destroyed;},
    start() {queueMicrotask(() => encrypted ? request(1) : resolve(document));},
  };
}

async function run(f) {
  const {openWithPasswords} = await api();
  const result = openWithPasswords(f.options);
  f.start();
  return result;
}

test('document identity removes fragment but keeps signed query', async () => {
  const {documentKey} = await api();
  assert.equal(documentKey('https://example.test/a.pdf?token=123#page=4'), 'https://example.test/a.pdf?token=123');
  assert.notEqual(documentKey('https://example.test/a.pdf?id=1'), documentKey('https://example.test/a.pdf?id=2'));
});
test('local file identity keeps path and removes fragment', async () => {
  assert.equal((await api()).documentKey('file:///tmp/a.pdf#page=2'), 'file:///tmp/a.pdf');
});
test('filename alone cannot identify a document', async () => {
  const {documentKey} = await api();
  assert.throws(() => documentKey('a.pdf'));
});
test('successful remembered candidate precedes shared candidates', async () => {
  assert.deepEqual((await api()).selectCandidates(records, 'b', true).map(x => x.id), ['b', 'a']);
});
test('disabled and unshared unrelated records are excluded', async () => {
  const xs = [record('a','a',{enabled:false}), record('b','b',{shared:false}), record('c','c')];
  assert.deepEqual((await api()).selectCandidates(xs, null, true).map(x => x.id), ['c']);
});
test('remembered document-only password may be used for its own document', async () => {
  assert.deepEqual((await api()).selectCandidates([record('a','a',{shared:false})], 'a', true).map(x => x.id), ['a']);
});
test('autofill disabled returns no candidates', async () => {
  assert.deepEqual((await api()).selectCandidates(records, 'b', false), []);
});
test('same secret is tried only once, even with multiple names', async () => {
  assert.equal((await api()).selectCandidates([record('a','x'),record('b','x')],null,true).length,1);
});
test('registration rejects empty secret, duplicates and more than 100 entries', async () => {
  const {validateRegistration} = await api();
  assert.throws(() => validateRegistration([],record('c','')));
  assert.throws(() => validateRegistration(records,record('c','correct')));
  assert.throws(() => validateRegistration(Array.from({length:100},(_,i)=>record(String(i),String(i))),record('c','new')));
});
test('password whitespace and Unicode are valid without normalization', async () => {
  const {validateRegistration} = await api();
  for (const value of [' ', ' 日本語🔑 ', 'e\u0301']) assert.doesNotThrow(() => validateRegistration([],record('c',value)));
});
test('autofill retries registered candidates and remembers only success', async () => {
  const f=fixture(); assert.equal(await run(f), f.document);
  assert.deepEqual(f.attempts,['wrong','correct']); assert.equal(f.prompts.length,0);
  assert.deepEqual(f.remembered,[[f.options.documentKey,'b']]); assert.deepEqual(f.saved,[]);
});
test('all saved candidates failing falls back to manual input', async () => {
  const f=fixture({password:'manual',answers:[{password:'manual',remember:false}]});
  await run(f); assert.deepEqual(f.attempts,['wrong','correct','manual']);
  assert.equal(f.prompts[0].incorrect,true); assert.deepEqual(f.saved,[]); assert.deepEqual(f.remembered,[]);
});
test('invalid manual entry prompts again without restarting automatic guesses', async () => {
  const f=fixture({autoFill:false,answers:[{password:'bad',remember:false},{password:'correct',remember:false}]});
  await run(f); assert.deepEqual(f.attempts,['bad','correct']);
  assert.deepEqual(f.prompts.map(x=>x.incorrect),[false,true]);
});
test('manual registration is persisted only after successful decryption', async () => {
  const f=fixture({autoFill:false,answers:[{password:'bad',name:'bad',remember:true,shared:true},{password:'correct',name:'course',remember:true,shared:false}]});
  await run(f); assert.deepEqual(f.saved,[[f.options.documentKey,{password:'correct',name:'course',shared:false}]]);
});
test('non-encrypted PDF never accesses the password store', async () => {
  const f=fixture({encrypted:false}); f.options.store.read=()=>assert.fail('Unexpected password read');
  assert.equal(await run(f),f.document); assert.deepEqual(f.attempts,[]); assert.deepEqual(f.prompts,[]);
});
test('cancel destroys loading task and rejects with AbortError', async () => {
  const f=fixture({autoFill:false}); await assert.rejects(run(f),{name:'AbortError'});
  assert.equal(f.destroyed,1); assert.deepEqual(f.saved,[]);
});
test('storage read failure allows manual decryption', async () => {
  const f=fixture({readError:true,answers:[{password:'correct',remember:false}]});
  assert.equal(await run(f),f.document); assert.deepEqual(f.attempts,['correct']);
});
test('persistence failure preserves opened document and emits notice', async () => {
  const f=fixture({saveError:true}); assert.equal(await run(f),f.document); assert.equal(f.notices.length,1);
});
test('ordinary PDF/network errors retain their original identity', async () => {
  const {openWithPasswords}=await api(); const f=fixture(); const error=new Error('Invalid PDF structure');
  const result=openWithPasswords(f.options); f.reject(error);
  await assert.rejects(result,e=>e===error); assert.deepEqual(f.saved,[]); assert.deepEqual(f.prompts,[]);
});
test('abort during prompt ignores a late response and never saves', async () => {
  const {openWithPasswords}=await api(); const f=fixture({autoFill:false});
  const controller=new AbortController(); let answer; let entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  f.options.signal=controller.signal;
  f.options.prompt=()=>{entered(); return new Promise(resolve=>{answer=resolve;});};
  const result=openWithPasswords(f.options); const rejected=assert.rejects(result,{name:'AbortError'});
  f.start(); await ready; controller.abort(); await rejected;
  answer({password:'correct',remember:true,name:'late',shared:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.destroyed,1); assert.deepEqual(f.attempts,[]); assert.deepEqual(f.saved,[]);
});

test('abort while storage read is pending never supplies a password', async () => {
  const {openWithPasswords}=await api(); const f=fixture();
  const controller=new AbortController(); let release; let entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  f.options.signal=controller.signal;
  f.options.store.read=()=>{entered();return new Promise(resolve=>{release=resolve;});};
  const result=openWithPasswords(f.options); const rejected=assert.rejects(result,{name:'AbortError'});
  f.start();await ready;controller.abort();await rejected;
  release({records,rememberedId:null});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.attempts,[]);assert.deepEqual(f.prompts,[]);
});
test('prompt failure rejects safely instead of leaving the PDF load pending', async () => {
  const f=fixture({autoFill:false});
  f.options.prompt=async()=>{throw new Error('secret must not escape');};
  await assert.rejects(run(f),error=>error.message==='Unable to request a PDF password');
  assert.equal(f.destroyed,1);assert.deepEqual(f.saved,[]);
});

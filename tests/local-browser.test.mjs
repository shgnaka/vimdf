import test from 'node:test';
import assert from 'node:assert/strict';
// Missing production module is an intentional red test, not a skipped test.
let api, loadError;
try { api = await import('../src/local-browser/model.ts'); } catch (e) { loadError = e; }
function contract() { assert.ok(api, `Local browser implementation required: ${loadError?.message}`); return api; }
const file = name => ({name,kind:'file',async getFile(){return new File(['%PDF-1.7'],name);}});
const dir = (name,children=[]) => ({name,kind:'directory',async *values(){yield* children;}});
async function fixture(children) {
  const calls=[];
  const browser=new (contract().LocalBrowser)(dir('root',children),{rootId:'root-a',openPdf:async (...args)=>calls.push(args)});
  await browser.refresh(); return {browser,calls};
}
const message={type:'vimdf.openLocalBrowser',version:1};
test('only allowlisted sender ID can invoke the exact versioned command',()=>{
  const {acceptExternalOpen:f}=contract();
  assert.equal(f(message,{id:'trusted'},['trusted']),true);
  for(const sender of [{id:'other'},{},{id:'trusted',incognito:true}]) assert.equal(f(message,sender,['trusted']),false);
  assert.equal(f(message,{id:'trusted'},[]),false);
});
test('spoofed from, malformed payloads, versions and arbitrary URLs are rejected',()=>{
  const {acceptExternalOpen:f}=contract();
  for(const m of [null,[],{},'open',{...message,version:2},{...message,type:'open'},{...message,url:'file:///secret'},{...message,from:'Vimium C'}])
    assert.equal(f(m,{id:'trusted'},['trusted']),false);
});
test('directories sort first and only case-insensitive PDF suffixes appear',async()=>{
  const {browser:b}=await fixture([file('z.PDF'),file('notes.txt'),dir('b'),file('a.pdf'),dir('a')]);
  assert.deepEqual(b.entries.map(e=>e.name),['a','b','a.pdf','z.PDF']); assert.equal(b.selectedIndex,0);
});
test('j/k clamp selection and gg/G select endpoints',async()=>{
  const {browser:b}=await fixture([file('a.pdf'),file('b.pdf')]);
  b.key('k');assert.equal(b.selectedIndex,0); b.key('j');b.key('j');assert.equal(b.selectedIndex,1);
  b.key('gg');assert.equal(b.selectedIndex,0);b.key('G');assert.equal(b.selectedIndex,1);
});
test('empty directory has no selection and Enter is harmless',async()=>{
  const {browser:b,calls}=await fixture([]);assert.equal(b.selectedIndex,-1);await b.enter();assert.deepEqual(calls,[]);
});
test('filter is case-insensitive partial matching and resets selection',async()=>{
  const {browser:b}=await fixture([file('Alpha.pdf'),file('Beta.pdf')]);b.key('G');b.setFilter('ALP');
  assert.deepEqual(b.entries.map(e=>e.name),['Alpha.pdf']);assert.equal(b.selectedIndex,0);
  b.setFilter('missing');assert.equal(b.selectedIndex,-1);b.setFilter('');assert.equal(b.entries.length,2);
});
test('Enter descends; parent cannot escape registered root',async()=>{
  const {browser:b}=await fixture([dir('sub',[file('child.pdf')]),file('root.pdf')]);
  await b.enter();assert.deepEqual(b.entries.map(e=>e.name),['child.pdf']);
  await b.parent();await b.parent();assert.deepEqual(b.entries.map(e=>e.name),['sub','root.pdf']);
});
test('opening a PDF supplies bytes and a stable non-blob identity',async()=>{
  const {browser:b,calls}=await fixture([file('a.pdf')]);await b.enter();await b.enter();
  assert.ok(calls[0][0] instanceof File);assert.equal(await calls[0][0].text(),'%PDF-1.7');
  assert.equal(calls[0][1],calls[1][1]);assert.equal(typeof calls[0][1],'string');assert.ok(!calls[0][1].startsWith('blob:'));
});
test('same filename in different subdirectories has different identity',async()=>{
  const {browser:b,calls}=await fixture([dir('a',[file('x.pdf')]),dir('b',[file('x.pdf')])]);
  await b.enter();await b.enter();await b.parent();b.key('j');await b.enter();await b.enter();
  assert.notEqual(calls[0][1],calls[1][1]);
});
test('failed file read never invokes the PDF viewer',async()=>{
  const bad=file('bad.pdf');bad.getFile=async()=>{throw new Error('gone');};
  const {browser:b,calls}=await fixture([bad]);await assert.rejects(b.enter(),/gone/);assert.deepEqual(calls,[]);
});
test('directory enumeration failures propagate and can be retried',async()=>{
  const root=dir('root');root.values=async function*(){throw new Error('denied');};
  const b=new (contract().LocalBrowser)(root,{rootId:'r',openPdf:async()=>{}});
  await assert.rejects(b.refresh(),/denied/);root.values=async function*(){yield file('ok.pdf');};await b.refresh();assert.equal(b.entries[0].name,'ok.pdf');
});
test('listing is not a recursive scan',async()=>{
  const child=dir('sub');child.values=async function*(){assert.fail('must not enumerate child');};
  const {browser:b}=await fixture([child]);assert.equal(b.entries.length,1);
});

test('different registered roots never share a document identity',async()=>{
  const calls=[];const {LocalBrowser}=contract();
  for(const rootId of ['one','two']){const b=new LocalBrowser(dir('same',[file('x.pdf')]),{rootId,openPdf:async(...a)=>calls.push(a)});await b.refresh();await b.enter();}
  assert.notEqual(calls[0][1],calls[1][1]);
});
function accessFixture(permission='prompt') {
  const calls=[];let saved=null;
  const handle={kind:'directory',name:'root',queryPermission:async()=>{calls.push('query');return permission;},requestPermission:async()=>{calls.push('request');return permission;}};
  const access=new (contract().RootAccess)({load:async()=>saved,save:async value=>{saved=value;calls.push('save');},clear:async()=>{saved=null;calls.push('clear');},pick:async()=>{calls.push('pick');return handle;},newId:()=> 'root-id'});
  return {access,calls,handle,setSaved:value=>{saved=value;},setPermission:value=>{permission=value;}};
}
test('restoring without grant never requests permission automatically',async()=>{
  const f=accessFixture();f.setSaved({id:'r',handle:f.handle});assert.equal(await f.access.restore(),null);assert.deepEqual(f.calls,['query']);
});
test('restoring granted handle preserves root ID',async()=>{
  const f=accessFixture('granted');f.setSaved({id:'r',handle:f.handle});const value=await f.access.restore();assert.equal(value.id,'r');assert.equal(value.handle,f.handle);
});
test('explicit folder choice stores handle and root ID',async()=>{
  const f=accessFixture('granted');const value=await f.access.choose();assert.equal(value.id,'root-id');assert.equal(value.handle,f.handle);assert.ok(f.calls.includes('save'));
});
test('explicit denied permission returns no accessible root',async()=>{
  const f=accessFixture('denied');f.setSaved({id:'r',handle:f.handle});assert.equal(await f.access.authorize(),null);assert.ok(f.calls.includes('request'));
});
test('forget clears saved root without modifying local files',async()=>{
  const f=accessFixture('granted');f.setSaved({id:'r',handle:f.handle});await f.access.forget();assert.equal(await f.access.restore(),null);assert.deepEqual(f.calls,['clear']);
});

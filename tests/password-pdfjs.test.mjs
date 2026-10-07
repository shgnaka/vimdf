import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openWithPasswords } from '../src/viewer/passwords.ts';

for (const algorithm of ['RC4-128','AES-256']) {
  test(`real PDF.js decrypts ${algorithm} fixture after incorrect automatic candidate`, {timeout:10000}, async () => {
    const fixture=JSON.parse(await readFile(new URL(`./fixtures/${algorithm}.json`,import.meta.url),'utf8'));
    const task=getDocument({data:new Uint8Array(Buffer.from(fixture.base64,'base64'))});
    const remembered=[];
    const store={
      async read() { return {rememberedId:null,records:[
        {id:'wrong',name:'wrong',password:'incorrect',enabled:true,shared:true},
        {id:'right',name:'right',password:fixture.password,enabled:true,shared:true},
      ]}; },
      async remember(...args) {remembered.push(args);},
      async save() {assert.fail('Unexpected manual save');},
    };
    try {
      const pdf=await openWithPasswords({task,store,documentKey:'fixture',autoFill:true,
        async prompt() {assert.fail('Valid registered password should decrypt');}});
      assert.equal(pdf.numPages,1);
      assert.deepEqual(remembered,[['fixture','right']]);
      const page=await pdf.getPage(1); assert.equal(page.view[2],100);
    } finally {await task.destroy();}
  });
}

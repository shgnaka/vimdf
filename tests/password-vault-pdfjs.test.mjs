import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openWithPasswords } from '../src/viewer/passwords.ts';
import { lessonPdf } from './helpers/pdf-bytes.mjs';
import { created, master, v2, draft, documentKey, noSecrets, unseal } from './helpers/password-vault-fixtures.mjs';

for (const algorithm of ['RC4-128', 'AES-256']) {
  test(`[SEC-01/SEC-07] real ${algorithm} PDF.js uses decrypted registrations, retries and remembers only success`, { timeout: 15000 }, async () => {
    const pdfFixture = JSON.parse(await readFile(new URL(`./fixtures/${algorithm}.json`, import.meta.url), 'utf8'));
    const f = await created(); await f.store.register(draft('fixture-wrong-password'));
    await f.store.register(draft(pdfFixture.password, { name: 'fixture-right-PDF-name' }));
    const right = (await f.store.vault()).records[1]; const task = getDocument({ data: new Uint8Array(Buffer.from(pdfFixture.base64, 'base64')) });
    const supplied = []; const read = f.store.read.bind(f.store);
    const store = { read: async key => { const value = await read(key); supplied.push(...value.records.map(r => r.password)); return value; },
      remember: f.store.remember.bind(f.store), save: f.store.save.bind(f.store) };
    try {
      const pdf = await openWithPasswords({ task, store, documentKey, autoFill: true,
        async prompt() { assert.fail('Saved encrypted registrations should open the PDF'); } });
      assert.equal(pdf.numPages, 1); assert.deepEqual(supplied, ['fixture-wrong-password', pdfFixture.password]);
      assert.equal((await unseal(f.io.snapshot()[v2])).remembered[documentKey], right.id);
      noSecrets(f.io.snapshot(), [pdfFixture.password, 'fixture-right-PDF-name']);
      await f.store.lock(); await f.store.unlock(master); assert.equal((await f.store.read(documentKey)).rememberedId, right.id);
    } finally { await task.destroy(); }
  });
  test(`[SEC-08/SEC-24] real ${algorithm} PDF can open by unsaved manual input while the vault stays locked`, { timeout: 15000 }, async () => {
    const pdfFixture = JSON.parse(await readFile(new URL(`./fixtures/${algorithm}.json`, import.meta.url), 'utf8'));
    const f = await created(); await f.store.register(draft('must-not-be-tried')); await f.store.lock();
    const before = f.io.snapshot(); const task = getDocument({ data: new Uint8Array(Buffer.from(pdfFixture.base64, 'base64')) });
    let prompts = 0;
    try {
      const pdf = await openWithPasswords({ task, store: f.store, documentKey, autoFill: true,
        async prompt({ incorrect }) { prompts++; assert.equal(incorrect, false); return { password: pdfFixture.password, remember: false }; } });
      assert.equal(pdf.numPages, 1); assert.equal(prompts, 1); assert.equal((await f.store.status()).state, 'locked');
      assert.deepEqual(f.io.snapshot(), before);
    } finally { await task.destroy(); }
  });
}

test('[SEC-08] real unencrypted PDF never requests an unlock or accesses the vault', { timeout: 10000 }, async () => {
  const task = getDocument({ data: lessonPdf() });
  try {
    const pdf = await openWithPasswords({ task, documentKey, autoFill: true,
      store: { async read() { assert.fail('Unencrypted PDF must not read secrets'); },
        async remember() { assert.fail('Unencrypted PDF must not write secrets'); }, async save() { assert.fail('Unexpected save'); } },
      async prompt() { assert.fail('Unencrypted PDF must not prompt for a password'); } });
    assert.equal(pdf.numPages, 2);
  } finally { await task.destroy(); }
});
test('[SEC-07/SEC-22] encryption write failure after manual decryption leaves the real PDF open with an unsaved notice', { timeout: 15000 }, async () => {
  const pdfFixture = JSON.parse(await readFile(new URL('./fixtures/AES-256.json', import.meta.url), 'utf8'));
  const f = await created(); const before = f.io.snapshot(); f.io.faults.set = new Error('fixture-quota');
  const task = getDocument({ data: new Uint8Array(Buffer.from(pdfFixture.base64, 'base64')) }); let notice = 0;
  try {
    const pdf = await openWithPasswords({ task, store: f.store, documentKey, autoFill: false,
      async prompt() { return { password: pdfFixture.password, name: 'fixture-save-failure', shared: true, remember: true }; },
      onSaveError() { notice++; } });
    assert.equal(pdf.numPages, 1); assert.equal((await pdf.getPage(1)).view[2], 100); assert.equal(notice, 1);
    assert.deepEqual(f.io.snapshot(), before);
  } finally { await task.destroy(); }
});

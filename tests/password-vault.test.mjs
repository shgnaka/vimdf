import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { master, nextMaster, v1, v2, draft, record, payload, documentKey, unrelated,
  production, policy, vaultFixture, created, populated, storageFixture, seal, unseal,
  flip, noSecrets, oracleRawKey, rejectsUnchanged, deferred, turn } from './helpers/password-vault-fixtures.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);
const permit = f => f.store.authorizePlaintext(master);
const backup = f => f.store.exportBackup();

test('[fixture] independent Web Crypto oracle preserves exact strings and rejects a wrong key', async () => {
  const value = payload(); const cipher = await seal(value);
  assert.deepEqual(await unseal(cipher), value);
  await assert.rejects(unseal(cipher, nextMaster));
});
test('[fixture] independent oracle authenticates metadata and ciphertext', async () => {
  for (const mutation of [c => { c.kdf.salt = flip(c.kdf.salt); }, c => { c.cipher.iv = flip(c.cipher.iv); },
    c => { c.ciphertext = flip(c.ciphertext); }]) {
    const c = await seal(); mutation(c); await assert.rejects(unseal(c));
  }
});

test('[SEC-01] production factory uses the encrypted store instead of the plaintext implementation', async t => {
  const io = storageFixture(); const saved = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const locks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    storage: { local: io.storage }, extension: { inIncognitoContext: false } } });
  Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: { request: (_name, action) => io.withLock(action) } });
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'chrome', saved); else delete globalThis.chrome;
    if (locks) Object.defineProperty(globalThis.navigator, 'locks', locks); else delete globalThis.navigator.locks;
  });
  const store = production.createPasswordStore();
  assert.equal(store.constructor.name, 'EncryptedPasswordStore');
  await store.create(master, master); await store.register(draft());
  assert.ok(io.snapshot()[v2]); assert.equal(io.snapshot()[v1], undefined);
  noSecrets(io.snapshot(), [draft().name, draft().password]);
});
test('[SEC-05/SEC-06] policy exposes bounded security parameters without fixing an undecided idle duration', () => {
  const p = policy();
  for (const key of ['idleTimeoutMs', 'minMasterLength', 'maxImportBytes', 'maxPlaintextBytes', 'minKdfIterations', 'maxKdfIterations'])
    assert.ok(Number.isSafeInteger(p[key]) && p[key] > 0, `Invalid policy: ${key}`);
  assert.ok(p.minKdfIterations >= 600000); assert.ok(p.maxKdfIterations >= p.minKdfIterations);
});

// Real Chrome storage returns object members in a different order from the
// writer. Cryptographic AAD and session identity must use canonical fields.
function reordered(value) {
  if (Array.isArray(value)) return value.map(reordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, reordered(value[k])]));
  return value;
}
test('[SEC-01/SEC-03/SEC-14] reordered storage fields preserve creation, unlock, reauthentication and restore generations', async () => {
  const f = vaultFixture(); f.io.hooks.get = async () => f.io.replace(reordered(f.io.snapshot()));
  await f.store.create(master, master); assert.equal((await f.store.status()).state, 'unlocked');
  await f.store.register(draft()); await f.store.lock(); await f.store.unlock(master);
  const token = await permit(f); assert.equal(JSON.parse((await f.store.exportPlaintext(token, { confirmed: true })).text).records.length, 1);
  const ticket = await f.store.prepareRestore(JSON.stringify(reordered(await seal())), master);
  await f.store.restore(ticket.token, { confirmed: true }); await f.store.unlock(master);
  assert.deepEqual(await f.store.vault(), payload());
});
test('[SEC-21] reordered Chrome-style legacy/envelope fields still verify readback before migration deletion', async () => {
  const old = payload(), f = vaultFixture({ initial: { [v1]: old } });
  f.io.hooks.get = async () => f.io.replace(reordered(f.io.snapshot()));
  await f.store.migrate(master, master); assert.equal(f.io.snapshot()[v1], undefined);
  assert.equal((await f.store.status()).state, 'unlocked'); assert.deepEqual(await unseal(f.io.snapshot()[v2]), old);
});
test('[SEC-01/SEC-08] empty profile needs explicit creation before saving and remains usable without persistence', async () => {
  const f = vaultFixture(); assert.equal((await f.store.status()).state, 'uninitialized');
  assert.deepEqual(await f.store.read(documentKey), { records: [], rememberedId: null });
  await rejectsUnchanged(f, () => f.store.register(draft()));
  await rejectsUnchanged(f, () => f.store.exportBackup());
});
for (const [password, confirmation, label] of [['', '', 'empty'], [master, nextMaster, 'mismatched confirmation']]) {
  test(`[SEC-01/SEC-02] creation rejects ${label} without writing`, async () => {
    const f = vaultFixture(); await rejectsUnchanged(f, () => f.store.create(password, confirmation));
  });
}
test('[SEC-02] master creation enforces its published length boundary without trimming', async () => {
  const f = vaultFixture(); const n = policy().minMasterLength;
  await rejectsUnchanged(f, () => f.store.create('x'.repeat(n - 1), 'x'.repeat(n - 1)));
  const exact = 'x'.repeat(n); await f.store.create(exact, exact); await f.store.lock();
  await f.store.unlock(exact); assert.equal((await f.store.status()).state, 'unlocked');
});
test('[SEC-01] registration and every journaled write are encrypted with a real independently decryptable key', async () => {
  const f = await populated(); const value = f.io.snapshot()[v2];
  assert.equal(value.format, 'vimdf-password-vault'); assert.equal(value.version, 2);
  assert.equal(value.cipher.name, 'AES-GCM'); assert.equal(value.cipher.length, 256); assert.equal(value.cipher.tagLength, 128);
  assert.equal(value.kdf.name, 'PBKDF2'); assert.equal(value.kdf.hash, 'SHA-256');
  assert.ok(value.kdf.iterations >= 600000 && value.kdf.iterations <= policy().maxKdfIterations);
  assert.ok(Buffer.from(value.kdf.salt, 'base64').length >= 16); assert.equal(Buffer.from(value.cipher.iv, 'base64').length, 12);
  assert.deepEqual(await unseal(value), await f.store.vault());
  assert.deepEqual(Object.keys(value).sort(), ['cipher', 'ciphertext', 'format', 'kdf', 'version']);
  assert.deepEqual(Object.keys(value.kdf).sort(), ['hash', 'iterations', 'name', 'salt']);
  assert.deepEqual(Object.keys(value.cipher).sort(), ['iv', 'length', 'name', 'tagLength']);
  const raw = Buffer.from(await oracleRawKey(value));
  const persisted = JSON.stringify(f.io.snapshot());
  for (const representation of [raw.toString('base64'), raw.toString('hex'), JSON.stringify([...raw])])
    assert.equal(persisted.includes(representation), false, 'Derived encryption key must not be persisted');
  noSecrets(f.io.snapshot(), [draft().password, draft().name, 'fixture-another-PDF-secret', 'fixture-second-private-name']);
  for (const c of f.io.calls.filter(c => c.method === 'set')) {
    noSecrets(c.values, [draft().password, draft().name]);
    if (c.values[v2]) {
      const key = Buffer.from(await oracleRawKey(c.values[v2]));
      for (const representation of [key.toString('base64'), key.toString('hex'), JSON.stringify([...key]), JSON.stringify(new Uint8Array(key))])
        assert.equal(JSON.stringify(c.values).includes(representation), false, 'A write must never contain its derived key');
    }
  }
  assert.deepEqual(f.io.calls[0], { method: 'protect', value: { accessLevel: 'TRUSTED_CONTEXTS' } });
});
test('[SEC-02] Unicode, whitespace and newlines survive registration, restart, unlock and export', async () => {
  const f = vaultFixture(); const m = `  ${master}-e\u0301-🔐\n `;
  await f.store.create(m, m); await f.store.register(draft(' \n日本語🔑e\u0301\n ', { name: ' \n名前🔐\n ' }));
  const other = f.another(); await other.unlock(m);
  const [r] = (await other.vault()).records;
  assert.equal(r.password, ' \n日本語🔑e\u0301\n '); assert.equal(r.name, ' \n名前🔐\n ');
  const token = await other.authorizePlaintext(m); const out = await other.exportPlaintext(token, { confirmed: true });
  assert.equal(JSON.parse(out.text).records[0].password, r.password);
  await other.lock(); await assert.rejects(() => other.unlock(m.trim()));
  await assert.rejects(() => other.unlock(m.normalize('NFC')));
});
test('[SEC-04] even saving unchanged contents uses a fresh IV and authenticates under the same master', async () => {
  const f = await populated(); const before = f.io.snapshot()[v2];
  await f.store.setAutoFill(true); const after = f.io.snapshot()[v2];
  assert.notEqual(after.cipher.iv, before.cipher.iv); assert.notEqual(after.ciphertext, before.ciphertext);
  assert.deepEqual(await unseal(after), await unseal(before));
});
test('[SEC-03/SEC-06] restart is locked; correct unlock preserves records and wrong unlock never overwrites', async () => {
  const f = await populated(); const other = f.another();
  assert.equal((await other.status()).state, 'locked');
  assert.deepEqual(await other.read(documentKey), { records: [], rememberedId: null });
  await assert.rejects(() => other.vault()); const before = f.io.snapshot();
  await assert.rejects(() => other.unlock(nextMaster)); assert.deepEqual(f.io.snapshot(), before);
  assert.equal((await other.status()).state, 'locked'); await other.unlock(master);
  assert.deepEqual(await other.vault(), await f.store.vault());
});
for (const [label, mutation] of [
  ['format', c => { c.format = 'not-vimdf'; }], ['version', c => { c.version = 999; }],
  ['KDF', c => { c.kdf.name = 'unknown'; }], ['hash', c => { c.kdf.hash = 'SHA-1'; }],
  ['iterations', c => { c.kdf.iterations += 1; }], ['salt', c => { c.kdf.salt = flip(c.kdf.salt); }],
  ['cipher', c => { c.cipher.name = 'AES-CBC'; }], ['key length', c => { c.cipher.length = 128; }],
  ['tag length', c => { c.cipher.tagLength = 96; }], ['IV', c => { c.cipher.iv = flip(c.cipher.iv); }],
  ['ciphertext', c => { c.ciphertext = flip(c.ciphertext); }],
  ['authentication tag', c => { const b = Buffer.from(c.ciphertext, 'base64'); b[b.length - 1] ^= 1; c.ciphertext = b.toString('base64'); }],
]) {
  test(`[SEC-03/SEC-04] altered ${label} rejects unlock and restore, preserving source data`, async () => {
    const c = await seal(); mutation(c); const f = vaultFixture({ initial: { [v2]: c } });
    await rejectsUnchanged(f, () => f.store.unlock(master));
    await rejectsUnchanged(f, () => f.store.prepareRestore(JSON.stringify(c), master));
    assert.equal((await f.store.status()).state, 'locked');
  });
}
for (const [label, mutation] of [
  ['negative KDF', c => { c.kdf.iterations = -1; }], ['fractional KDF', c => { c.kdf.iterations = 1.5; }],
  ['oversized KDF', c => { c.kdf.iterations = Number.MAX_SAFE_INTEGER; }],
  ['weak KDF', c => { c.kdf.iterations = 599999; }],
  ['unknown outer field', c => { c.extra = 'unexpected-metadata'; }],
  ['unknown KDF field', c => { c.kdf.extra = 'unexpected-metadata'; }],
  ['invalid base64', c => { c.kdf.salt = '%%%'; }], ['short salt', c => { c.kdf.salt = 'YQ=='; }],
  ['short IV', c => { c.cipher.iv = 'YQ=='; }], ['missing tag', c => { c.ciphertext = 'YQ=='; }],
]) {
  test(`[SEC-05] ${label} is rejected before expensive crypto`, async () => {
    const c = await seal(); mutation(c); const f = vaultFixture(); f.crypto.calls.length = 0;
    await rejectsUnchanged(f, () => f.store.prepareRestore(JSON.stringify(c), master));
    assert.equal(f.crypto.calls.filter(c => ['deriveKey', 'deriveBits', 'decrypt'].includes(c.method)).length, 0);
  });
}
for (const [label, contents] of [
  ['bad logical version', payload({ version: 99 })], ['non-boolean switch', payload({ autoFill: 'yes' })],
  ['empty password', payload({ records: [record('one', '')] })],
  ['duplicate IDs', payload({ records: [record('same', 'one'), record('same', 'two')] })],
  ['duplicate secrets', payload({ records: [record('one', 'same'), record('two', 'same')] })],
  ['too many records', payload({ records: Array.from({ length: 101 }, (_, i) => record(String(i), `secret-${i}`)) })],
  ['invalid record type', payload({ records: [{ ...record('one', 'one'), enabled: 'yes' }] })],
  ['dangling document link', payload({ remembered: { [documentKey]: 'absent-id' } })],
]) {
  test(`[SEC-05/SEC-14] authenticated but invalid payload: ${label}`, async () => {
    const text = JSON.stringify(await seal(contents)); const f = await populated();
    await rejectsUnchanged(f, () => f.store.prepareRestore(text, master));
    assert.deepEqual(await f.store.vault(), await unseal(f.io.snapshot()[v2]));
  });
}
test('[SEC-05] malformed JSON and input above the policy byte limit are rejected before deriving', async () => {
  const f = vaultFixture(); const limit = policy().maxImportBytes;
  for (const text of ['{', 'null', '[]', ' '.repeat(limit + 1)]) await rejectsUnchanged(f, () => f.store.prepareRestore(text, master));
  assert.equal(f.crypto.calls.filter(c => ['deriveKey', 'deriveBits', 'decrypt'].includes(c.method)).length, 0);
});
test('[SEC-05/SEC-13] authenticated payload with exactly 100 unique registrations can be restored', async () => {
  const value = payload({ records: Array.from({ length: 100 }, (_, i) => record(`boundary-${i}`, `boundary-secret-${i}`)), remembered: {} });
  const f = vaultFixture(); const ticket = await f.store.prepareRestore(JSON.stringify(await seal(value)), master);
  assert.equal(ticket.preview.recordCount, 100); await f.store.restore(ticket.token, { confirmed: true });
  await f.store.unlock(master); assert.deepEqual(await f.store.vault(), value);
});
test('[SEC-05] decrypted content above its byte limit cannot enter the active vault', async () => {
  const f = vaultFixture(); const c = await seal(payload({ records: [record('one', 'x'.repeat(policy().maxPlaintextBytes + 1))], remembered: {} }));
  await rejectsUnchanged(f, () => f.store.prepareRestore(JSON.stringify(c), master));
});
test('[SEC-06] manual lock stops access and mutation without deleting registered secrets', async () => {
  const f = await populated(); const before = f.io.snapshot(); await f.store.lock();
  assert.equal((await f.store.status()).state, 'locked'); assert.deepEqual(await f.store.read(documentKey), { records: [], rememberedId: null });
  await rejectsUnchanged(f, () => f.store.vault()); await rejectsUnchanged(f, () => f.store.register(draft('new')));
  assert.deepEqual(f.io.snapshot(), before); await f.store.unlock(master); assert.equal((await f.store.vault()).records.length, 2);
});
test('[SEC-06] injected clock expires idle access at the configured boundary, not a fixed product default', async () => {
  const f = await populated(); f.advance(999); await f.store.checkIdle();
  assert.equal((await f.store.status()).state, 'unlocked'); f.advance(1); await f.store.checkIdle();
  assert.equal((await f.store.status()).state, 'locked'); assert.deepEqual(await f.store.read(documentKey), { records: [], rememberedId: null });
});
test('[SEC-06] explicit activity refreshes the idle deadline without writing secrets or deleting registrations', async () => {
  const f = await populated(); const before = f.io.snapshot(); f.advance(900); await f.store.noteActivity();
  f.advance(999); await f.store.checkIdle(); assert.equal((await f.store.status()).state, 'unlocked');
  f.advance(1); await f.store.checkIdle(); assert.equal((await f.store.status()).state, 'locked'); assert.deepEqual(f.io.snapshot(), before);
});
test('[SEC-06] lock during pending real decrypt ignores a late successful unlock', async () => {
  const f = await populated(); await f.store.lock(); const entered = deferred(), release = deferred();
  f.crypto.hooks.decrypt = async () => { entered.resolve(); await release.promise; };
  const result = f.store.unlock(master); const rejected = assert.rejects(result);
  await entered.promise; await f.store.lock(); release.resolve(); await rejected;
  assert.equal((await f.store.status()).state, 'locked'); assert.deepEqual(await f.store.read(documentKey), { records: [], rememberedId: null });
});
test('[SEC-07] edits, ordering, disabling, remembered links and the global switch survive encryption', async () => {
  const f = await populated(); let value = await f.store.vault(); const [a, b] = value.records;
  await f.store.move(b.id, -1); await f.store.update(a.id, { enabled: false, name: 'changed', password: ' changed 🔑 ' });
  await f.store.setAutoFill(false); assert.deepEqual((await f.store.read(documentKey)).records, []);
  await f.store.setAutoFill(true); value = await f.store.vault(); assert.deepEqual(value.records.map(r => r.id), [b.id, a.id]);
  assert.equal(value.records[1].password, ' changed 🔑 '); assert.equal(value.records[1].enabled, false);
  await f.store.remove(a.id); assert.equal((await f.store.vault()).remembered[documentKey], undefined);
  assert.deepEqual(await unseal(f.io.snapshot()[v2]), await f.store.vault());
});
test('[SEC-07] saving an existing secret reuses its registration and scope after decryption', async () => {
  const f = await populated(); const second = (await f.store.vault()).records[1];
  await f.store.save('https://fixture.invalid/another.pdf', draft(second.password));
  const value = await f.store.vault(); assert.equal(value.records.length, 2); assert.equal(value.records[1].shared, false);
  assert.equal(value.remembered['https://fixture.invalid/another.pdf'], second.id);
});

test('[SEC-10] locked and unlocked backups export exactly the committed ciphertext without deriving or decrypting', async () => {
  const f = await populated(); const cipher = f.io.snapshot()[v2]; f.crypto.calls.length = 0;
  const first = await backup(f); await f.store.lock(); const second = await backup(f);
  assert.deepEqual(JSON.parse(first.text), cipher); assert.deepEqual(JSON.parse(second.text), cipher);
  assert.equal(f.crypto.calls.length, 0); assert.equal((await f.store.status()).state, 'locked');
  noSecrets(first, [draft().name, draft().password]);
  assert.equal(first.mimeType, 'application/json'); assert.match(first.filename, /^vimdf-passwords-\d{8}-\d{6}\.vimdf-vault\.json$/);
});
for (const [label, initial] of [['uninitialized', {}], ['legacy', { [v1]: payload() }], ['invalid envelope', { [v2]: { version: 999 } }]]) {
  test(`[SEC-11] ${label} cannot be exported as an encrypted backup`, async () => {
    const f = vaultFixture({ initial }); await rejectsUnchanged(f, () => backup(f));
  });
}
test('[SEC-11/SEC-12] backup read failure preserves storage and does not leak a secret-bearing error', async () => {
  const f = await populated(); f.io.faults.get = new Error(`storage unavailable: ${master}`);
  await rejectsUnchanged(f, () => backup(f), e => !e.message.includes(master));
});
test('[SEC-10/SEC-12] aborted backup creates no result and changes no storage', async () => {
  const f = await populated(); const control = new AbortController(); control.abort();
  await rejectsUnchanged(f, () => f.store.exportBackup({ signal: control.signal }), { name: 'AbortError' });
});
test('[SEC-13] restore into a new profile preserves all records, ordering, switches and associations then locks', async () => {
  const value = payload({ autoFill: false }); const c = await seal(value); const f = vaultFixture({ initial: unrelated });
  const ticket = await f.store.prepareRestore(JSON.stringify(c), master);
  assert.deepEqual(ticket.preview, { recordCount: 2, replacesExisting: false }); assert.equal(f.io.snapshot()[v2], undefined);
  await f.store.restore(ticket.token, { confirmed: true }); assert.equal((await f.store.status()).state, 'locked');
  await f.store.unlock(master); assert.deepEqual(await f.store.vault(), value);
  for (const [key, value] of Object.entries(unrelated)) assert.deepEqual(f.io.snapshot()[key], value);
});
test('[SEC-13/SEC-15] replacement uses the backup master and invalidates old unlocked contexts', async () => {
  const f = await populated(); const other = f.another(); await other.unlock(master);
  const incoming = payload({ autoFill: false }); const c = await seal(incoming, nextMaster);
  const ticket = await f.store.prepareRestore(JSON.stringify(c), nextMaster);
  assert.deepEqual(ticket.preview, { recordCount: 2, replacesExisting: true });
  await f.store.restore(ticket.token, { confirmed: true }); await assert.rejects(() => f.store.unlock(master));
  assert.deepEqual(await other.read(documentKey), { records: [], rememberedId: null });
  await f.store.unlock(nextMaster); assert.deepEqual(await f.store.vault(), incoming);
});
test('[SEC-14] existing locked vault cannot be replaced merely by knowing the incoming master', async () => {
  const f = await populated(); await f.store.lock(); const text = JSON.stringify(await seal(payload(), nextMaster));
  await rejectsUnchanged(f, async () => { const p = await f.store.prepareRestore(text, nextMaster); return f.store.restore(p.token, { confirmed: true }); });
});
test('[SEC-14] restore without confirmation, cancelled preview and replay never overwrite', async () => {
  const f = await populated(); const text = JSON.stringify(await seal());
  const first = await f.store.prepareRestore(text, master); await rejectsUnchanged(f, () => f.store.restore(first.token, { confirmed: false }));
  const second = await f.store.prepareRestore(text, master); await f.store.discardPrepared(second.token);
  await rejectsUnchanged(f, () => f.store.restore(second.token, { confirmed: true }));
  const third = await f.store.prepareRestore(text, master); await f.store.restore(third.token, { confirmed: true });
  await rejectsUnchanged(f, () => f.store.restore(third.token, { confirmed: true }));
});
test('[SEC-14/SEC-22] a concurrent registration invalidates a prepared replacement', async () => {
  const f = await populated(); const ticket = await f.store.prepareRestore(JSON.stringify(await seal()), master);
  const other = f.another(); await other.unlock(master); await other.register(draft('concurrent-secret'));
  await rejectsUnchanged(f, () => f.store.restore(ticket.token, { confirmed: true }));
  assert.equal((await other.vault()).records.length, 3);
});
test('[SEC-14] restore quota failure preserves the previous vault and consumes its prepared permission', async () => {
  const f = await populated(); const p = await f.store.prepareRestore(JSON.stringify(await seal()), master);
  f.io.faults.set = new Error('quota'); await rejectsUnchanged(f, () => f.store.restore(p.token, { confirmed: true }));
  f.io.faults.set = null; await rejectsUnchanged(f, () => f.store.restore(p.token, { confirmed: true }));
  assert.equal((await f.store.vault()).records.length, 2);
});

test('[SEC-16] unlocked state alone cannot authorize plaintext and wrong reauthentication preserves data', async () => {
  const f = await populated(); await rejectsUnchanged(f, () => f.store.exportPlaintext(undefined, { confirmed: true }));
  await rejectsUnchanged(f, () => f.store.authorizePlaintext(nextMaster), e => !e.message.includes(nextMaster));
  assert.equal((await f.store.status()).state, 'unlocked');
});
test('[SEC-16/SEC-18] plaintext export authenticates, includes disabled entries in order and excludes document metadata', async () => {
  const f = await populated(); const second = (await f.store.vault()).records[1]; await f.store.update(second.id, { enabled: false });
  const before = f.io.snapshot(), token = await permit(f); noSecrets(token, [draft().password]);
  const out = await f.store.exportPlaintext(token, { confirmed: true });
  assert.deepEqual(JSON.parse(out.text), { format: 'vimdf-password-export', version: 1,
    records: (await f.store.vault()).records.map(({ name, password, enabled, shared }) => ({ name, password, enabled, shared })) });
  noSecrets(out, []); assert.equal(out.mimeType, 'application/json');
  assert.match(out.filename, /^vimdf-passwords-\d{8}-\d{6}\.plaintext\.json$/); assert.deepEqual(f.io.snapshot(), before);
  await rejectsUnchanged(f, () => f.store.exportPlaintext(token, { confirmed: true }));
});
test('[SEC-16/SEC-19] locked plaintext export uses a one-shot reauthentication without unlocking ordinary access', async () => {
  const f = await populated(); await f.store.lock(); const token = await permit(f);
  assert.equal((await f.store.status()).state, 'locked'); const out = await f.store.exportPlaintext(token, { confirmed: true });
  assert.equal(JSON.parse(out.text).records.length, 2); assert.equal((await f.store.status()).state, 'locked');
  assert.deepEqual(await f.store.read(documentKey), { records: [], rememberedId: null });
});
test('[SEC-02/SEC-18] JSON export preserves HTML-like names and formula-like passwords as literal strings', async () => {
  const f = await created();
  const values = ['=1+1', '+fixture', '-fixture', '@fixture', '<script>fixture-only</script>'];
  for (const value of values) await f.store.register(draft(value, { name: '<img src=x onerror=fixture-only>' }));
  const token = await permit(f), out = await f.store.exportPlaintext(token, { confirmed: true });
  assert.deepEqual(JSON.parse(out.text).records.map(r => r.password), values);
  assert.ok(JSON.parse(out.text).records.every(r => r.name === '<img src=x onerror=fixture-only>'));
  assert.match(out.filename, /\.plaintext\.json$/);
});
test('[SEC-16/SEC-17] declined output confirmation consumes permission and changes nothing', async () => {
  const f = await populated(); const token = await permit(f);
  await rejectsUnchanged(f, () => f.store.exportPlaintext(token, { confirmed: false }));
  await rejectsUnchanged(f, () => f.store.exportPlaintext(token, { confirmed: true }));
});
for (const [label, invalidate] of [
  ['lock', f => f.store.lock()], ['edit', async f => f.store.update((await f.store.vault()).records[0].id, { name: 'changed' })],
  ['cancel', async (f, token) => f.store.discardPrepared(token)], ['reset', f => f.store.reset({ confirmed: true })],
  ['master change', f => f.store.changeMasterPassword(master, nextMaster, nextMaster)],
  ['restore', async f => { const t = await f.store.prepareRestore(JSON.stringify(await seal()), master); await f.store.restore(t.token, { confirmed: true }); }],
]) {
  test(`[SEC-17] ${label} invalidates a previous plaintext permission`, async () => {
    const f = await populated(); const token = await permit(f); await invalidate(f, token);
    await rejectsUnchanged(f, () => f.store.exportPlaintext(token, { confirmed: true }));
  });
}
test('[SEC-17/SEC-22] another instance editing the vault prevents stale plaintext output', async () => {
  const f = await populated(); const token = await permit(f); const other = f.another(); await other.unlock(master);
  await other.register(draft('new-secret-from-other-context'));
  await rejectsUnchanged(f, () => f.store.exportPlaintext(token, { confirmed: true }));
});
test('[SEC-17] permission cannot be reused in another store or after the configured idle deadline', async () => {
  const f = await populated(); const token = await permit(f); const other = f.another();
  await assert.rejects(() => other.exportPlaintext(token, { confirmed: true }));
  f.advance(1000); await f.store.checkIdle(); await rejectsUnchanged(f, () => f.store.exportPlaintext(token, { confirmed: true }));
});
test('[SEC-17] delayed successful reauthentication after lock cannot yield an output permission', async () => {
  const f = await populated(); const entered = deferred(), release = deferred();
  f.crypto.hooks.decrypt = async () => { entered.resolve(); await release.promise; };
  const result = permit(f); const rejected = assert.rejects(result);
  await entered.promise; await f.store.lock(); release.resolve(); await rejected;
  assert.equal((await f.store.status()).state, 'locked');
});
test('[SEC-19] aborted output consumes its permission and never writes secrets', async () => {
  const f = await populated(); const token = await permit(f); const control = new AbortController(); control.abort();
  await rejectsUnchanged(f, () => f.store.exportPlaintext(token, { confirmed: true, signal: control.signal }), { name: 'AbortError' });
  await rejectsUnchanged(f, () => f.store.exportPlaintext(token, { confirmed: true }));
});

test('[SEC-20] master change reencrypts with a new salt, locks all old contexts and leaves old backups readable', async () => {
  const f = await populated(); const other = f.another(); await other.unlock(master);
  const oldBackup = await backup(f), old = f.io.snapshot()[v2], value = await f.store.vault();
  await f.store.changeMasterPassword(master, nextMaster, nextMaster); const changed = f.io.snapshot()[v2];
  assert.notEqual(changed.kdf.salt, old.kdf.salt); assert.notEqual(changed.cipher.iv, old.cipher.iv);
  assert.equal((await f.store.status()).state, 'locked'); assert.deepEqual(await other.read(documentKey), { records: [], rememberedId: null });
  await assert.rejects(() => f.store.unlock(master)); await f.store.unlock(nextMaster); assert.deepEqual(await f.store.vault(), value);
  assert.deepEqual(await unseal(JSON.parse(oldBackup.text), master), value); await assert.rejects(unseal(JSON.parse(oldBackup.text), nextMaster));
  noSecrets(f.io.snapshot(), [draft().password]);
});
for (const [label, oldValue, newValue, confirmation] of [
  ['wrong current master', nextMaster, nextMaster, nextMaster], ['mismatched new master', master, nextMaster, master],
  ['empty new master', master, '', ''],
]) {
  test(`[SEC-20] ${label} cannot change the active master`, async () => {
    const f = await populated(); await rejectsUnchanged(f, () => f.store.changeMasterPassword(oldValue, newValue, confirmation));
    assert.deepEqual(await unseal(f.io.snapshot()[v2]), await f.store.vault());
  });
}
test('[SEC-20/SEC-22] master-change write failure leaves old data readable and never enables the new password', async () => {
  const f = await populated(); f.io.faults.set = new Error('quota');
  await rejectsUnchanged(f, () => f.store.changeMasterPassword(master, nextMaster, nextMaster));
  f.io.faults.set = null; await f.store.lock(); await f.store.unlock(master); await assert.rejects(() => f.store.unlock(nextMaster));
});
test('[SEC-21] explicit v1 migration preserves data and removes plaintext only after encrypted readback verification', async () => {
  const old = payload(); const f = vaultFixture({ initial: { [v1]: old, ...unrelated } });
  assert.equal((await f.store.status()).state, 'legacy'); assert.deepEqual(await f.store.read(documentKey), { records: [], rememberedId: null });
  await rejectsUnchanged(f, () => f.store.register(draft())); await f.store.migrate(master, master);
  assert.equal(f.io.snapshot()[v1], undefined); assert.deepEqual(await unseal(f.io.snapshot()[v2]), old);
  const written = f.io.calls.findIndex(c => c.method === 'set' && v2 in c.values);
  const removed = f.io.calls.findIndex(c => c.method === 'remove' && c.keys.includes(v1));
  assert.ok(written >= 0 && removed > written);
  assert.ok(f.io.calls.slice(written + 1, removed).some(c => c.method === 'get'));
  for (const [key, value] of Object.entries(unrelated)) assert.deepEqual(f.io.snapshot()[key], value);
});
test('[SEC-21] migration write failure preserves v1 and cannot silently switch to ordinary plaintext saving', async () => {
  const f = vaultFixture({ initial: { [v1]: payload() } }); f.io.faults.set = new Error('quota');
  await rejectsUnchanged(f, () => f.store.migrate(master, master)); f.io.faults.set = null;
  await rejectsUnchanged(f, () => f.store.register(draft())); assert.equal(f.io.snapshot()[v2], undefined);
});
test('[SEC-21] deletion failure is incomplete migration, blocks export/edit/autofill, and can resume after restart', async () => {
  const old = payload(); const f = vaultFixture({ initial: { [v1]: old } }); f.io.faults.remove = new Error('delete failed');
  await assert.rejects(() => f.store.migrate(master, master)); assert.deepEqual(f.io.snapshot()[v1], old); assert.ok(f.io.snapshot()[v2]);
  const other = f.another(); assert.equal((await other.status()).state, 'migration-pending');
  assert.deepEqual(await other.read(documentKey), { records: [], rememberedId: null });
  await assert.rejects(() => other.exportBackup()); await assert.rejects(() => other.register(draft()));
  await assert.rejects(() => other.authorizePlaintext(master));
  f.io.faults.remove = null; await other.migrate(master, master);
  assert.equal(f.io.snapshot()[v1], undefined); assert.deepEqual(await unseal(f.io.snapshot()[v2]), old);
});
test('[SEC-21] failed encrypted readback leaves legacy records recoverable and migration retryable', async () => {
  const old = payload(); const f = vaultFixture({ initial: { [v1]: old } });
  f.io.hooks.get = async keys => { if (f.io.snapshot()[v2] && (keys === v2 || keys == null || Array.isArray(keys) && keys.includes(v2))) throw new Error('readback failed'); };
  await assert.rejects(() => f.store.migrate(master, master)); assert.deepEqual(f.io.snapshot()[v1], old);
  delete f.io.hooks.get; await f.store.migrate(master, master);
  assert.equal(f.io.snapshot()[v1], undefined); assert.deepEqual(await unseal(f.io.snapshot()[v2]), old);
});
test('[SEC-21] corrupt v2 beside v1 never triggers fallback, overwrite or plaintext deletion', async () => {
  const c = await seal(); c.ciphertext = flip(c.ciphertext); const f = vaultFixture({ initial: { [v1]: payload(), [v2]: c } });
  await rejectsUnchanged(f, () => f.store.migrate(master, master));
  assert.deepEqual(await f.store.read(documentKey), { records: [], rememberedId: null });
});
test('[SEC-22] simultaneous registrations through real store instances keep both encrypted updates', async () => {
  const f = await created(); const other = f.another(); await other.unlock(master);
  await Promise.all([f.store.register(draft('first-concurrent-secret')), other.register(draft('second-concurrent-secret'))]);
  assert.deepEqual((await unseal(f.io.snapshot()[v2])).records.map(r => r.password).sort(), ['first-concurrent-secret', 'second-concurrent-secret']);
});
test('[SEC-22] write failure preserves the committed record and exposes no secret from an underlying error', async () => {
  const f = await populated(); f.io.faults.set = new Error(`quota: ${draft().password}`);
  await rejectsUnchanged(f, () => f.store.register(draft('new-unsaved-secret')), e => !e.message.includes(draft().password));
  f.io.faults.set = null; await f.store.register(draft('new-unsaved-secret')); assert.equal((await f.store.vault()).records.length, 3);
});
test('[SEC-22] abort before queued mutation begins does not write a later document registration', async () => {
  const control = new AbortController(); const f = await created({ signal: control.signal }); const release = deferred();
  const holding = f.io.withLock(() => release.promise); const before = f.io.snapshot();
  const result = f.store.save(documentKey, draft()); const rejected = assert.rejects(result, { name: 'AbortError' });
  control.abort(); release.resolve(); await holding; await rejected; await turn(); assert.deepEqual(f.io.snapshot(), before);
});
test('[SEC-23] reset without knowing the master deletes only vault and legacy residue, not PDF/settings metadata', async () => {
  const f = await populated({ initial: unrelated }); await f.store.lock();
  await f.io.storage.set({ [v1]: payload() }); await f.store.reset({ confirmed: true });
  assert.equal((await f.store.status()).state, 'uninitialized'); assert.deepEqual(f.io.snapshot(), unrelated);
});
test('[SEC-23] cancelled or failed reset does not claim success or delete unrelated keys', async () => {
  const f = await populated({ initial: unrelated }); await rejectsUnchanged(f, () => f.store.reset({ confirmed: false }));
  f.io.faults.remove = new Error('remove failed'); await rejectsUnchanged(f, () => f.store.reset({ confirmed: true }));
  assert.notEqual((await f.store.status()).state, 'uninitialized');
});
test('[SEC-23] clearing individual registrations retains the master and requires unlocking first', async () => {
  const f = await populated(); await f.store.clear(); assert.deepEqual((await f.store.vault()).records, []);
  await f.store.lock(); await rejectsUnchanged(f, () => f.store.clear()); await f.store.unlock(master);
  assert.deepEqual((await f.store.vault()).remembered, {}); assert.ok(f.io.snapshot()[v2]);
});
test('[SEC-24] incognito cannot read, unlock, write, export, restore, migrate, change or reset the normal vault', async () => {
  const initial = { [v1]: payload(), [v2]: await seal(), ...unrelated }; const f = vaultFixture({ initial, incognito: true });
  assert.equal((await f.store.status()).state, 'incognito');
  assert.deepEqual(await f.store.read(documentKey), { records: [], rememberedId: null });
  for (const action of [() => f.store.create(master, master), () => f.store.unlock(master), () => f.store.vault(),
    () => f.store.register(draft()), () => f.store.exportBackup(), () => f.store.authorizePlaintext(master),
    () => f.store.exportPlaintext('anything', { confirmed: true }), () => f.store.prepareRestore('{}', master),
    () => f.store.restore('anything', { confirmed: true }), () => f.store.migrate(master, master),
    () => f.store.changeMasterPassword(master, nextMaster, nextMaster), () => f.store.reset({ confirmed: true })])
    await rejectsUnchanged(f, action);
  assert.deepEqual(f.io.calls, []); assert.deepEqual(f.io.snapshot(), initial);
});

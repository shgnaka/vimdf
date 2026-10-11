import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import * as production from '../../src/common/password-store.ts';

export const v1 = 'vimdf.passwords.v1';
export const v2 = 'vimdf.passwords.v2';
export const master = 'VimDF-fixture-master-only-2026-Long-Random-Unique-!7r9u2z4';
export const nextMaster = 'VimDF-fixture-next-only-2026-Long-Random-Unique-!8s0v3a5';
export const documentKey = 'https://fixture.invalid/private-course.pdf?token=fixture-only';
export const localKey = 'https://local-pdf.vimdf.invalid/fixture-root/private.pdf';
export const draft = (password = 'fixture-PDF-secret-日本語-🔑', extra = {}) =>
  ({ name: 'fixture-private-registration-name', password, shared: true, ...extra });
export const record = (id, password, extra = {}) =>
  ({ id, name: `fixture-private-name-${id}`, password, enabled: true, shared: true, ...extra });
export const payload = (extra = {}) => ({ version: 1, autoFill: true,
  records: [record('first', 'fixture-first-secret-🔑'),
    record('second', ' \nfixture-second-secret-e\u0301🔐\n ', { enabled: false, shared: false })],
  remembered: { [documentKey]: 'first', [localKey]: 'second' }, ...extra });
export const unrelated = {
  'vimdf.customCss.v1': { version: 1, css: '.vimdf-ui { color: blue; }' },
  'vimdf.localBrowser.launcher.v1': { version: 1, enabled: false, allowedIds: [] },
  [`vimdf:marks:${localKey}`]: { a: { page: 2, x: 0, y: 10 } },
  [`vimdf:highlights:${localKey}`]: [{ id: 'retained', page: 2 }],
  [`vimdf:state:${localKey}`]: { page: 2, scrollTop: 123 },
};
export const policy = () => {
  const value = production.PASSWORD_VAULT_POLICY;
  assert.ok(value, 'Export PASSWORD_VAULT_POLICY from the production password store');
  return value;
};
export const turn = () => new Promise(resolve => setImmediate(resolve));
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function storageFixture(initial = {}) {
  let data = structuredClone(initial), queue = Promise.resolve();
  const calls = [], faults = { get: null, set: null, remove: null }, hooks = {};
  const storage = {
    async setAccessLevel(value) { calls.push({ method: 'protect', value }); },
    async get(keys) {
      calls.push({ method: 'get', keys });
      if (hooks.get) await hooks.get(keys);
      if (faults.get) throw faults.get;
      const result = structuredClone(data);
      if (keys == null) return result;
      return Object.fromEntries((typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys))
        .filter(key => key in result).map(key => [key, result[key]]));
    },
    async set(values) {
      calls.push({ method: 'set', values: structuredClone(values) });
      if (hooks.set) await hooks.set(values);
      if (faults.set) throw faults.set;
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      const names = typeof keys === 'string' ? [keys] : keys;
      calls.push({ method: 'remove', keys: [...names] });
      if (hooks.remove) await hooks.remove(names);
      if (faults.remove) throw faults.remove;
      for (const key of names) delete data[key];
    },
  };
  const withLock = action => { const result = queue.then(action); queue = result.catch(() => {}); return result; };
  return { storage, calls, faults, hooks, withLock,
    snapshot: () => structuredClone(data),
    replace: value => { data = structuredClone(value); },
  };
}

// Observe the real Web Crypto boundary; never supply an implementation of the vault.
export function cryptoFixture() {
  const calls = [], hooks = {};
  const subtle = new Proxy(webcrypto.subtle, { get(target, name) {
    const fn = target[name];
    if (typeof fn !== 'function') return fn;
    return async (...args) => {
      calls.push({ method: name, algorithm: structuredClone(args[0]) });
      if (hooks[name]) await hooks[name](...args);
      return fn.apply(target, args);
    };
  } });
  return { calls, hooks, crypto: { subtle,
    getRandomValues: array => webcrypto.getRandomValues(array), randomUUID: () => webcrypto.randomUUID() } };
}

export function vaultFixture({ initial = {}, incognito = false, io = storageFixture(initial),
  crypto = cryptoFixture(), signal, idleTimeoutMs = 1000 } = {}) {
  assert.equal(typeof production.EncryptedPasswordStore, 'function',
    'Implement EncryptedPasswordStore in the production password-store.ts');
  let time = Date.UTC(2026, 9, 10, 10, 0, 0);
  const options = { storage: io.storage, incognito, withLock: io.withLock,
    crypto: crypto.crypto, now: () => time, idleTimeoutMs, signal };
  const store = new production.EncryptedPasswordStore(options);
  return { store, io, crypto, options, advance: ms => { time += ms; },
    another: () => new production.EncryptedPasswordStore(options) };
}
export async function created(options) {
  const f = vaultFixture(options);
  await f.store.create(master, master);
  assert.equal((await f.store.status()).state, 'unlocked');
  return f;
}
export async function populated(options) {
  const f = await created(options);
  await f.store.save(documentKey, draft());
  await f.store.register(draft('fixture-another-PDF-secret', { name: 'fixture-second-private-name', shared: false }));
  return f;
}

const encode = value => new TextEncoder().encode(value);
const b64 = value => Buffer.from(value).toString('base64');
const binary = value => new Uint8Array(Buffer.from(value, 'base64'));
// This portable envelope/AAD contract is specified in docs/pdf-password-protection.md.
// The oracle calls Web Crypto directly, independently of all production vault helpers.
export const aad = envelope => encode(JSON.stringify([envelope.format, envelope.version,
  envelope.kdf.name, envelope.kdf.hash, envelope.kdf.iterations, envelope.kdf.salt,
  envelope.cipher.name, envelope.cipher.length, envelope.cipher.tagLength, envelope.cipher.iv]));
async function oracleKey(password, envelope) {
  const material = await webcrypto.subtle.importKey('raw', encode(password), 'PBKDF2', false, ['deriveKey']);
  return webcrypto.subtle.deriveKey({ name: 'PBKDF2', hash: envelope.kdf.hash,
    iterations: envelope.kdf.iterations, salt: binary(envelope.kdf.salt) }, material,
  { name: 'AES-GCM', length: envelope.cipher.length }, false, ['encrypt', 'decrypt']);
}
export async function seal(value = payload(), password = master) {
  const envelope = { format: 'vimdf-password-vault', version: 2,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000,
      salt: b64(webcrypto.getRandomValues(new Uint8Array(16))) },
    cipher: { name: 'AES-GCM', length: 256, tagLength: 128,
      iv: b64(webcrypto.getRandomValues(new Uint8Array(12))) }, ciphertext: '' };
  envelope.ciphertext = b64(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: binary(envelope.cipher.iv),
    additionalData: aad(envelope), tagLength: 128 }, await oracleKey(password, envelope), encode(JSON.stringify(value))));
  return envelope;
}
export async function unseal(envelope, password = master) {
  const bytes = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: binary(envelope.cipher.iv),
    additionalData: aad(envelope), tagLength: envelope.cipher.tagLength },
  await oracleKey(password, envelope), binary(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function oracleRawKey(envelope, password = master) {
  const material = await webcrypto.subtle.importKey('raw', encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: envelope.kdf.hash,
    iterations: envelope.kdf.iterations, salt: binary(envelope.kdf.salt) }, material, 256));
}
export function flip(value) {
  const bytes = Buffer.from(value, 'base64'); bytes[0] ^= 1; return bytes.toString('base64');
}
export function noSecrets(value, secrets = []) {
  const serialized = JSON.stringify(value) ?? '';
  for (const secret of [master, nextMaster, documentKey, localKey, ...secrets]) {
    for (const encoding of [secret, JSON.stringify(secret).slice(1, -1), b64(encode(secret))])
      assert.equal(serialized.includes(encoding), false, 'Secret is present in persistent/export metadata');
  }
}
export async function rejectsUnchanged(f, action, pattern) {
  const before = f.io.snapshot();
  // The callback keeps synchronous missing-method errors inside assert.rejects.
  await assert.rejects(async () => action(), pattern);
  assert.deepEqual(f.io.snapshot(), before);
}

export { production };

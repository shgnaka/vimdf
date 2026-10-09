import assert from 'node:assert/strict';

// The production module is intentionally absent on this specification branch.
let implementation;
let loadError;
try {
  implementation = await import('../../src/local-browser/model.ts');
} catch (error) {
  loadError = error;
}
export function contract() {
  assert.ok(implementation, `Local browser implementation required: ${loadError?.message}`);
  return implementation;
}

let nextHandleId = 0;
export function file(name, text = '%PDF-1.7') {
  return { name, kind: 'file', async getFile() { return new File([text], name); } };
}
export function directory(name, children = [], options = {}) {
  let permission = options.permission ?? 'granted';
  let requestedPermission = options.requestedPermission ?? permission;
  const identity = options.identity ?? `handle-${++nextHandleId}`;
  const calls = [];
  return {
    name, kind: 'directory', identity, calls,
    async *values() { calls.push({ method: 'values' }); yield* children; },
    async queryPermission(options) {
      calls.push({ method: 'queryPermission', options });
      return permission;
    },
    async requestPermission(options) {
      calls.push({ method: 'requestPermission', options });
      permission = requestedPermission;
      return permission;
    },
    async isSameEntry(other) {
      calls.push({ method: 'isSameEntry', other });
      return other?.identity === identity;
    },
    setPermission(value) { permission = value; },
    setRequestedPermission(value) { requestedPermission = value; },
  };
}
export async function browserFixture(children, rootId = 'root-a') {
  const calls = [];
  const browser = new (contract().LocalBrowser)(directory('root', children), {
    rootId, openPdf: async (...args) => { calls.push(args); },
  });
  await browser.refresh();
  return { browser, calls };
}
export function state(roots = [], primaryId = roots[0]?.id ?? null) {
  return { version: 1, roots, primaryId };
}
function copyState(value) {
  if (value == null) return null;
  return { ...value, roots: value.roots?.map(root => ({ ...root })) };
}
export function registryFixture(initial = null, options = {}) {
  let persisted = copyState(initial);
  let picked;
  let pickError = new DOMException('cancelled', 'AbortError');
  let saveError;
  let generated = 0;
  const calls = [];
  const registry = new (contract().FolderRegistry)({
    load: async () => { calls.push({ method: 'load' }); return copyState(persisted); },
    save: async value => {
      calls.push({ method: 'save', value: copyState(value) });
      if (saveError) throw saveError;
      if (options.saveHook) await options.saveHook(value);
      persisted = copyState(value);
    },
    pick: async options => {
      calls.push({ method: 'pick', options });
      if (pickError) throw pickError;
      return picked;
    },
    newId: () => { generated += 1; return `root-${generated}`; },
  });
  return {
    registry, calls,
    saved: () => copyState(persisted),
    generated: () => generated,
    choose: handle => { picked = handle; pickError = null; },
    failPick: error => { pickError = error; },
    failSave: error => { saveError = error; },
  };
}
export function methods(handle, method) {
  return handle.calls.filter(call => call.method === method);
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function press(session, key, options = {}) {
  return session.key({ key, ...options });
}
export async function sessionFixture(options = {}) {
  const a = options.a ?? directory('University', [
    directory('course', [file('lesson.pdf')]), file('a.pdf'), file('z.pdf'),
  ]);
  const b = options.b ?? directory('Books', [
    directory('novels', [file('book.pdf')]), file('x.pdf'),
  ]);
  const roots = options.roots ?? [{ id: 'r-a', handle: a }, { id: 'r-b', handle: b }];
  const access = registryFixture(state(roots, options.primaryId ?? 'r-a'), options);
  const calls = [];
  const create = () => new (contract().LocalBrowserSession)({
    registry: access.registry, openPdf: async (...args) => { calls.push(args); },
  });
  const session = create();
  await session.start();
  return { ...access, ioCalls: access.calls, a, b, session, calls, create };
}

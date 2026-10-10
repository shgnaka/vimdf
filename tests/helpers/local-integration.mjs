import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';

// Missing production modules are test failures, never substitutes or skips.
export async function implementation(path, exported) {
  const url = new URL(`../../${path}`, import.meta.url);
  let module;
  try { module = await import(url); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === url.href) {
      assert.fail(`Integration implementation required: ${path} (${exported})`);
    }
    throw error;
  }
  assert.equal(typeof module[exported], 'function', `${path} must export ${exported}`);
  return module[exported];
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function settled() { await nextTurn(); await nextTurn(); }

export function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    hasListener: listener => listeners.has(listener),
  };
}

export const launcherKey = 'vimdf.localBrowser.launcher.v1';
export const vimiumId = 'a'.repeat(32);
export const vimdfId = 'b'.repeat(32);
export const launchCommand = Object.freeze({ type: 'vimdf.openLocalBrowser', version: 1 });

export function chromeFixture(options = {}) {
  const calls = [];
  const persistent = options.persistent ?? {};
  if (!options.persistent && options.settings !== undefined) persistent[launcherKey] = options.settings;
  const windows = new Map([[7, { id: 7, incognito: false, type: 'normal' }],
    [9, { id: 9, incognito: true, type: 'normal' }]]);
  let focused = 7;
  let createError;
  let settingsGate;
  const chrome = {
    extension: { inIncognitoContext: options.incognito ?? false },
    runtime: {
      id: vimdfId, onMessageExternal: event(), onMessage: event(),
      getURL: path => `chrome-extension://${vimdfId}/${path}`,
    },
    action: { onClicked: event() },
    storage: {
      local: {
        async get(keys) {
          calls.push({ method: 'local.get', keys });
          if (settingsGate) await settingsGate;
          if (typeof keys === 'string') return { [keys]: persistent[keys] };
          return { ...keys, ...persistent };
        },
        async set(values) { calls.push({ method: 'local.set', values }); Object.assign(persistent, values); },
      },
      sync: { get() { assert.fail('launcher settings must not use sync storage'); },
        set() { assert.fail('launcher settings must not use sync storage'); } },
    },
    windows: {
      async getLastFocused() {
        calls.push({ method: 'windows.getLastFocused', id: focused });
        const window = windows.get(focused);
        if (!window) throw new Error('Window closed');
        return { ...window };
      },
      async get(id) {
        calls.push({ method: 'windows.get', id });
        if (!windows.has(id)) throw new Error('Window closed');
        return { ...windows.get(id) };
      },
    },
    tabs: {
      async create(value) {
        calls.push({ method: 'tabs.create', value });
        if (createError) throw createError;
        if (!windows.has(value.windowId)) throw new Error('Window closed');
        return { id: 20, ...value };
      },
    },
  };
  return {
    chrome, calls, persistent, windows,
    focus: id => { focused = id; }, failCreate: error => { createError = error; },
    holdSettings: promise => { settingsGate = promise; },
    dispatch(message = launchCommand, sender = { id: vimiumId }) {
      assert.equal(chrome.runtime.onMessageExternal.listeners.size, 1, 'exactly one external listener');
      const listener = [...chrome.runtime.onMessageExternal.listeners][0];
      const responses = []; const replied = deferred();
      const returned = listener(message, sender, value => { responses.push(value); replied.resolve(value); });
      return { returned, responses, replied: replied.promise };
    },
  };
}

export const enabledLauncher = () => ({ version: 1, enabled: true, allowedIds: [vimiumId] });

export function broadcastFixture() {
  const channels = new Set(); const sent = [];
  class Channel extends EventTarget {
    constructor(name) { super(); this.name = name; this.onmessage = null; channels.add(this); }
    postMessage(data) {
      sent.push({ name: this.name, data: structuredClone(data) });
      for (const channel of channels) if (channel !== this && channel.name === this.name) {
        queueMicrotask(() => {
          if (!channels.has(channel)) return;
          const event = new MessageEvent('message', { data: structuredClone(data) });
          channel.dispatchEvent(event); channel.onmessage?.(event);
        });
      }
    }
    close() { channels.delete(this); }
  }
  return { Channel, sent, channels };
}

export async function openDB(factory, version = 1) {
  return new Promise((resolve, reject) => {
    const request = factory.open('vimdf.local-browser', version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('registry')) request.result.createObjectStore('registry');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

export async function record(factory, value, write = false) {
  const db = await openDB(factory);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('registry', write ? 'readwrite' : 'readonly');
      const store = tx.objectStore('registry');
      const request = write ? store.put(value, 'state') : store.get('state');
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error ?? new DOMException('aborted', 'AbortError'));
      tx.onerror = () => {};
    });
  } finally { db.close(); }
}

// Cloneable opaque values test IDB transactions only. Native handle cloning is
// tested in the Chromium suite; these values are never passed to FolderRegistry.
export function storedState(primaryId = 'a') {
  return { version: 1, roots: [
    { id: 'a', handle: { kind: 'directory', name: 'University', token: 'native-a' } },
    { id: 'b', handle: { kind: 'directory', name: 'Books', token: 'native-b' } },
  ], primaryId };
}

export function pdfFixture() {
  const calls = []; const history = [];
  let current = null; let loadHook; let saveHook;
  const runtime = {
    snapshot() { return current ? { ...current } : null; },
    async save(snapshot) {
      calls.push({ method: 'save', snapshot: structuredClone(snapshot) });
      if (saveHook) await saveHook(snapshot);
    },
    async load(source, options = {}) {
      calls.push({ method: 'load', source, signal: options.signal });
      if (loadHook) await loadHook(source, options);
      if (options.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      current = { identity: source.identity, page: 1, scroll: 0 };
    },
    suspend() { calls.push({ method: 'suspend' }); },
    resume() { calls.push({ method: 'resume' }); },
    resetTransient() { calls.push({ method: 'resetTransient' }); },
    dispose() { calls.push({ method: 'dispose' }); current = null; },
  };
  return {
    runtime, calls, history,
    options: { createRuntime: () => runtime, history: {
      pushState: (value, ...args) => history.push({ value, args }), replaceState() {},
    }, onMode: mode => calls.push({ method: 'mode', mode }) },
    show: value => { current = { ...value }; }, current: () => current,
    holdLoad: hook => { loadHook = hook; }, holdSave: hook => { saveHook = hook; },
  };
}

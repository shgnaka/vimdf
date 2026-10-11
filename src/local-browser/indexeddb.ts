import type { FolderState, FolderStorage } from "./registry.ts";

interface Options {
  indexedDB: Pick<IDBFactory, "open">;
  BroadcastChannel?: typeof BroadcastChannel;
  pick: FolderStorage["pick"];
  newId: FolderStorage["newId"];
  onChanged?: (value: { revision: number }) => void;
  onVersionChange?: (event: IDBVersionChangeEvent) => void;
  onBlocked?: (event: IDBVersionChangeEvent) => void;
}
interface Envelope { revision: number; state: FolderState }
function envelope(value: unknown): Envelope | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object") throw new Error("Invalid registry envelope");
  const record = value as Envelope;
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error("Invalid registry revision");
  if (!record.state || record.state.version !== 1 || !Array.isArray(record.state.roots)
      || !(record.state.primaryId === null || typeof record.state.primaryId === "string")) {
    throw new Error("Invalid registry state version");
  }
  return record;
}
export interface IndexedFolderStorage extends FolderStorage {
  checkRevision(): Promise<boolean>;
  close(): void;
}
export async function createFolderStorage(options: Options): Promise<IndexedFolderStorage> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = options.indexedDB.open("vimdf.local-browser", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("registry")) request.result.createObjectStore("registry");
    };
    request.onblocked = event => options.onBlocked?.(event);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  let expected: number | null = null;
  let closed = false;
  const channel = options.BroadcastChannel ? new options.BroadcastChannel("vimdf.local-browser.registry.v1") : null;
  const close = () => { if (closed) return; closed = true; db.close(); channel?.close(); };
  db.onversionchange = event => { close(); options.onVersionChange?.(event); };
  if (channel) channel.onmessage = event => {
    const revision = event.data?.revision;
    if (Number.isSafeInteger(revision) && revision >= 0 && revision !== expected) options.onChanged?.({ revision });
  };
  const read = (): Promise<Envelope | null> => new Promise((resolve, reject) => {
    if (closed) { reject(new Error("Folder storage closed; reload required")); return; }
    const tx = db.transaction("registry", "readonly");
    const request = tx.objectStore("registry").get("state");
    tx.oncomplete = () => { try { resolve(envelope(request.result)); } catch (error) { reject(error); } };
    tx.onabort = () => reject(tx.error ?? new DOMException("Read aborted", "AbortError"));
    tx.onerror = () => {};
  });
  return {
    pick: options.pick, newId: options.newId, close,
    async load() {
      expected = null;
      const value = await read();
      expected = value?.revision ?? 0;
      return value?.state ?? null;
    },
    async checkRevision() { return ((await read())?.revision ?? 0) !== expected; },
    save(state) {
      return new Promise<void>((resolve, reject) => {
        if (closed || expected === null) { reject(new Error("Load the registry successfully before saving")); return; }
        const revision = expected;
        const tx = db.transaction("registry", "readwrite");
        const store = tx.objectStore("registry");
        let failure: unknown;
        const abort = (error: unknown) => { failure = error; tx.abort(); };
        const request = store.get("state");
        request.onsuccess = () => {
          try {
            const actual = envelope(request.result)?.revision ?? 0;
            if (actual !== revision) {
              abort(Object.assign(new Error("Folder registry changed; reload before saving"), { code: "storage-conflict" }));
              return;
            }
            if (revision === Number.MAX_SAFE_INTEGER) { abort(new Error("Registry revision exhausted")); return; }
            store.put({ revision: revision + 1, state }, "state");
          } catch (error) { abort(error); }
        };
        tx.onabort = () => reject(failure ?? tx.error ?? new DOMException("Save aborted", "AbortError"));
        tx.onerror = () => {};
        tx.oncomplete = () => {
          expected = revision + 1;
          // A failed notification cannot turn a committed save into a failure.
          try { channel?.postMessage({ revision: expected }); } catch { /* foreground check also detects changes */ }
          resolve();
        };
      });
    },
  };
}

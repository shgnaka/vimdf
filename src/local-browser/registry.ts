import type { LocalDirectoryHandle } from "./directory.ts";

export interface RegisteredFolder {
  readonly id: string;
  readonly handle: LocalDirectoryHandle;
}

export interface FolderState {
  readonly version: 1;
  readonly roots: readonly RegisteredFolder[];
  readonly primaryId: string | null;
}

export interface FolderStorage {
  load(): Promise<unknown>;
  /** Resolve only when the complete state has committed atomically. */
  save(state: FolderState): Promise<void>;
  pick(options: { mode: "read" }): Promise<LocalDirectoryHandle>;
  newId(): string;
}

function isDirectory(value: unknown): value is LocalDirectoryHandle {
  if (value === null || typeof value !== "object") return false;
  const handle = value as Partial<LocalDirectoryHandle>;
  return handle.kind === "directory" && typeof handle.name === "string"
    && typeof handle.values === "function" && typeof handle.queryPermission === "function"
    && typeof handle.requestPermission === "function" && typeof handle.isSameEntry === "function";
}

function snapshot(roots: readonly RegisteredFolder[], primaryId: string | null): FolderState {
  return Object.freeze({
    version: 1 as const,
    roots: Object.freeze(roots.map(root => Object.freeze({ id: root.id, handle: root.handle }))),
    primaryId,
  });
}

function storedState(value: unknown): FolderState {
  if (value === null) return snapshot([], null);
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid folder registry");
  const state = value as Partial<FolderState>;
  if (state.version !== 1 || !Array.isArray(state.roots)) throw new Error("Invalid folder registry version or roots");
  const ids = new Set<string>();
  for (const root of state.roots) {
    if (!root || typeof root.id !== "string" || !root.id || ids.has(root.id) || !isDirectory(root.handle)) {
      throw new Error("Invalid or duplicate registered folder");
    }
    ids.add(root.id);
  }
  if (state.roots.length === 0 ? state.primaryId !== null
    : typeof state.primaryId !== "string" || !ids.has(state.primaryId)) {
    throw new Error("Invalid primary folder");
  }
  return snapshot(state.roots, state.primaryId as string | null);
}

export class FolderRegistry {
  private readonly storage: FolderStorage;
  private state = snapshot([], null);
  private busy = false;
  private restoreFailed = false;

  constructor(storage: FolderStorage) { this.storage = storage; }

  get roots(): readonly RegisteredFolder[] { return this.state.roots; }
  get primaryId(): string | null { return this.state.primaryId; }

  restore(): Promise<RegisteredFolder | null> {
    return this.exclusive(async () => {
      try {
        this.state = storedState(await this.storage.load());
        this.restoreFailed = false;
      } catch (error) {
        this.restoreFailed = true;
        throw error;
      }
      const root = this.roots.find(root => root.id === this.primaryId);
      return root && await root.handle.queryPermission({ mode: "read" }) === "granted" ? root : null;
    });
  }

  add(): Promise<RegisteredFolder | null> {
    return this.exclusive(async () => {
      this.assertWritable();
      let handle: LocalDirectoryHandle;
      try {
        // Invoke before any await: the browser's transient user activation is
        // available here, rather than in a queued continuation.
        handle = await this.storage.pick({ mode: "read" });
      } catch (error) {
        if (error !== null && typeof error === "object" && "name" in error && error.name === "AbortError") return null;
        throw error;
      }
      if (!isDirectory(handle)) throw new Error("Invalid selected folder handle");
      for (const root of this.roots) {
        if (await root.handle.isSameEntry(handle)) return root;
      }
      if (await handle.queryPermission({ mode: "read" }) !== "granted") return null;
      const id = this.storage.newId();
      if (typeof id !== "string" || !id || this.roots.some(root => root.id === id)) {
        throw new Error("A new unique registered folder ID is required");
      }
      const root = Object.freeze({ id, handle });
      await this.commit([...this.roots, root], this.primaryId ?? id);
      return root;
    });
  }

  activate(id: string): Promise<RegisteredFolder | null> {
    return this.exclusive(async () => {
      this.assertWritable();
      const root = this.registered(id);
      if (await root.handle.queryPermission({ mode: "read" }) !== "granted") return null;
      await this.makePrimary(root);
      return root;
    });
  }

  authorize(id: string): Promise<RegisteredFolder | null> {
    return this.exclusive(async () => {
      this.assertWritable();
      const root = this.registered(id);
      // No query/load/queue before requestPermission: this call belongs to
      // the explicit permission-confirmation gesture, not the earlier choice.
      if (await root.handle.requestPermission({ mode: "read" }) !== "granted") return null;
      await this.makePrimary(root);
      return root;
    });
  }

  remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      this.assertWritable();
      this.registered(id);
      const roots = this.roots.filter(root => root.id !== id);
      const primaryId = this.primaryId === id ? roots[0]?.id ?? null : this.primaryId;
      await this.commit(roots, primaryId);
    });
  }

  private registered(id: string): RegisteredFolder {
    const root = this.roots.find(root => root.id === id);
    if (!root) throw new Error("Unknown registered folder");
    return root;
  }

  private assertWritable(): void {
    if (this.restoreFailed) throw new Error("Restore the folder registry successfully before changing it");
  }

  private async makePrimary(root: RegisteredFolder): Promise<void> {
    if (root.id !== this.primaryId) await this.commit(this.roots, root.id);
  }

  private async commit(roots: readonly RegisteredFolder[], primaryId: string | null): Promise<void> {
    const next = snapshot(roots, primaryId);
    await this.storage.save(next);
    this.state = next;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    // Reject overlap rather than queueing a gesture-dependent picker/request.
    // Cross-tab serialization belongs to the real storage adapter.
    if (this.busy) throw new Error("Folder registry operation in progress");
    this.busy = true;
    try { return await operation(); }
    finally { this.busy = false; }
  }
}

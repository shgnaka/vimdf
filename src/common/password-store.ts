import { validateRegistration, type PasswordAnswer, type PasswordRecord, type PasswordStore } from "../viewer/passwords.ts";

const STORAGE_KEY = "vimdf.passwords.v1";
export interface PasswordVault {
  version: 1;
  autoFill: boolean;
  records: PasswordRecord[];
  remembered: Record<string, string>;
}
interface Storage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
}
type Lock = <T>(action: () => Promise<T>) => Promise<T>;

function emptyVault(): PasswordVault {
  return { version: 1, autoFill: true, records: [], remembered: {} };
}

function decode(value: unknown): PasswordVault {
  if (value === undefined) return emptyVault();
  const v = value as PasswordVault;
  if (v?.version !== 1 || typeof v.autoFill !== "boolean" || !Array.isArray(v.records) ||
      v.records.length > 100 || !v.remembered || typeof v.remembered !== "object" ||
      Array.isArray(v.remembered) || !v.records.every(r =>
        r && typeof r.id === "string" && typeof r.name === "string" &&
        typeof r.password === "string" && r.password.length > 0 &&
        typeof r.enabled === "boolean" && typeof r.shared === "boolean") ||
      !Object.values(v.remembered).every(id => typeof id === "string")) {
    throw new Error("Password storage is invalid; delete all saved passwords to reset it");
  }
  return v;
}

/** All mutations use a cross-page Web Lock to avoid lost updates. */
export class LocalPasswordStore implements PasswordStore {
  private ready: Promise<void> | undefined;
  private storage: Storage;
  private incognito: boolean;
  private lock: Lock;
  private signal?: AbortSignal;
  constructor(
    storage: Storage,
    incognito: boolean,
    lock: Lock,
    signal?: AbortSignal,
  ) {
    this.storage = storage;
    this.incognito = incognito;
    this.lock = lock;
    this.signal = signal;
  }

  private async protect(): Promise<void> {
    if (this.incognito) throw new Error("Password saving is disabled in incognito");
    this.ready ??= this.storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await this.ready;
  }

  async vault(): Promise<PasswordVault> {
    if (this.incognito) return { ...emptyVault(), autoFill: false };
    await this.protect();
    return decode((await this.storage.get(STORAGE_KEY))[STORAGE_KEY]);
  }

  private async change(action: (vault: PasswordVault) => void, reset = false): Promise<void> {
    await this.protect();
    await this.lock(async () => {
      const vault = reset ? emptyVault() : await this.vault();
      if (this.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      action(vault);
      await this.storage.set({ [STORAGE_KEY]: vault });
    });
  }

  async read(key: string): Promise<{ records: PasswordRecord[]; rememberedId: string | null }> {
    const v = await this.vault();
    return { records: v.autoFill ? v.records : [], rememberedId: v.remembered[key] ?? null };
  }

  async remember(key: string, id: string): Promise<void> {
    await this.change(v => {
      if (v.records.some(r => r.id === id && r.enabled)) v.remembered[key] = id;
    });
  }

  async save(key: string, draft: Pick<PasswordAnswer, "name" | "password" | "shared">): Promise<void> {
    await this.change(v => {
      let record = v.records.find(r => r.password === draft.password);
      if (!record) {
        validateRegistration(v.records, draft);
        record = { ...draft, id: crypto.randomUUID(), enabled: true };
        v.records.push(record);
      }
      v.remembered[key] = record.id;
    });
  }

  async register(draft: Pick<PasswordAnswer, "name" | "password" | "shared">): Promise<void> {
    await this.change(v => {
      validateRegistration(v.records, draft);
      v.records.push({ ...draft, id: crypto.randomUUID(), enabled: true });
    });
  }

  async update(id: string, patch: Partial<Omit<PasswordRecord, "id">>): Promise<void> {
    await this.change(v => {
      const record = v.records.find(r => r.id === id);
      if (!record) throw new Error("Password no longer exists");
      const next = { ...record, ...patch };
      validateRegistration(v.records.filter(r => r.id !== id), next);
      Object.assign(record, next);
    });
  }

  async remove(id: string): Promise<void> {
    await this.change(v => {
      v.records = v.records.filter(r => r.id !== id);
      for (const key of Object.keys(v.remembered)) if (v.remembered[key] === id) delete v.remembered[key];
    });
  }

  async move(id: string, direction: -1 | 1): Promise<void> {
    await this.change(v => {
      const from = v.records.findIndex(r => r.id === id), to = from + direction;
      if (from >= 0 && to >= 0 && to < v.records.length) [v.records[from], v.records[to]] = [v.records[to], v.records[from]];
    });
  }

  async setAutoFill(value: boolean): Promise<void> { await this.change(v => { v.autoFill = value; }); }
  async clear(): Promise<void> { await this.change(() => {}, true); }
}

export function createPasswordStore(signal?: AbortSignal): LocalPasswordStore {
  return new LocalPasswordStore(
    chrome.storage.local,
    chrome.extension.inIncognitoContext,
    action => new Promise((resolve, reject) => {
      void navigator.locks.request("vimdf-password-vault", async () => {
        try { resolve(await action()); } catch (error) { reject(error); }
      }).catch(reject);
    }),
    signal,
  );
}

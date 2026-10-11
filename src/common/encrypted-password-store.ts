import { validateRegistration, type PasswordAnswer, type PasswordRecord, type PasswordStore } from "../viewer/passwords.ts";
import type { PasswordVault } from "./password-store.ts";

const V1 = "vimdf.passwords.v1", V2 = "vimdf.passwords.v2";
export const PASSWORD_VAULT_POLICY = Object.freeze({ idleTimeoutMs: 15 * 60_000, minMasterLength: 12,
  maxImportBytes: 2 * 1024 * 1024, maxPlaintextBytes: 1024 * 1024,
  minKdfIterations: 600_000, maxKdfIterations: 2_000_000 });
interface Storage {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
}
interface Envelope { format: "vimdf-password-vault"; version: 2;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; length: 256; tagLength: 128; iv: string }; ciphertext: string }
export interface VaultSession { key?: CryptoKey; signature?: string; epoch: number; activity: number }
interface Options { storage: Storage; incognito: boolean; withLock: <T>(action: () => Promise<T>) => Promise<T>;
  crypto: Crypto; now: () => number; idleTimeoutMs: number; signal?: AbortSignal; session?: VaultSession;
  onInvalidate?: () => void }
type Draft = Pick<PasswordAnswer, "name" | "password" | "shared">;
type Ticket = { kind: "plain" | "restore"; epoch: number; generation: string; expires: number;
  payload?: PasswordVault; envelope?: Envelope };
const sessions = new WeakMap<Storage, Set<WeakRef<EncryptedPasswordStore>>>();
const encode = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
const empty = (): PasswordVault => ({ version: 1, autoFill: true, records: [], remembered: {} });
const invalid = (): Error => new Error("Invalid password or corrupt password vault");
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function fields(value: unknown, names: string[]): boolean {
  return object(value) && Object.keys(value).length === names.length && names.every(n => Object.hasOwn(value, n));
}
function b64(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(Array.from(new Uint8Array(bytes instanceof Uint8Array ? bytes : bytes), b => String.fromCharCode(b)).join(""));
}
function binary(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid();
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (b64(bytes) !== value) throw invalid();
  return bytes;
}
function envelope(value: unknown): Envelope {
  if (!fields(value, ["format", "version", "kdf", "cipher", "ciphertext"])) throw invalid();
  const e = value as unknown as Envelope;
  if (e.format !== "vimdf-password-vault" || e.version !== 2 ||
      !fields(e.kdf, ["name", "hash", "iterations", "salt"]) || !fields(e.cipher, ["name", "length", "tagLength", "iv"]) ||
      e.kdf.name !== "PBKDF2" || e.kdf.hash !== "SHA-256" || !Number.isSafeInteger(e.kdf.iterations) ||
      e.kdf.iterations < PASSWORD_VAULT_POLICY.minKdfIterations || e.kdf.iterations > PASSWORD_VAULT_POLICY.maxKdfIterations ||
      e.cipher.name !== "AES-GCM" || e.cipher.length !== 256 || e.cipher.tagLength !== 128 ||
      binary(e.kdf.salt).length < 16 || binary(e.kdf.salt).length > 64 || binary(e.cipher.iv).length !== 12 ||
      binary(e.ciphertext).length < 16 || encode(JSON.stringify(e)).length > PASSWORD_VAULT_POLICY.maxImportBytes) throw invalid();
  // Chrome storage may reorder object properties. Wire order is not identity.
  return { format: e.format, version: e.version,
    kdf: { name: e.kdf.name, hash: e.kdf.hash, iterations: e.kdf.iterations, salt: e.kdf.salt },
    cipher: { name: e.cipher.name, length: e.cipher.length, tagLength: e.cipher.tagLength, iv: e.cipher.iv }, ciphertext: e.ciphertext };
}
function payload(value: unknown): PasswordVault {
  if (!fields(value, ["version", "autoFill", "records", "remembered"])) throw invalid();
  const v = value as unknown as PasswordVault;
  if (v.version !== 1 || typeof v.autoFill !== "boolean" || !Array.isArray(v.records) || v.records.length > 100 || !object(v.remembered)) throw invalid();
  const ids = new Set<string>(), secrets = new Set<string>();
  for (const r of v.records) {
    if (!fields(r, ["id", "name", "password", "enabled", "shared"]) || typeof r.id !== "string" || !r.id ||
        typeof r.name !== "string" || typeof r.password !== "string" || !r.password.length ||
        typeof r.enabled !== "boolean" || typeof r.shared !== "boolean" || ids.has(r.id) || secrets.has(r.password)) throw invalid();
    ids.add(r.id); secrets.add(r.password);
  }
  if (!Object.values(v.remembered).every(id => typeof id === "string" && ids.has(id)) ||
      encode(JSON.stringify(v)).length > PASSWORD_VAULT_POLICY.maxPlaintextBytes) throw invalid();
  return { version: 1, autoFill: v.autoFill,
    records: v.records.map(({ id, name, password, enabled, shared }) => ({ id, name, password, enabled, shared })),
    remembered: Object.fromEntries(Object.entries(v.remembered).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
}
const signature = (e: Envelope): string => JSON.stringify(e.kdf);
const generation = (value: unknown): string => value === undefined ? "absent" : JSON.stringify(envelope(value));
const aad = (e: Envelope): Uint8Array<ArrayBuffer> => encode(JSON.stringify([e.format, e.version,
  e.kdf.name, e.kdf.hash, e.kdf.iterations, e.kdf.salt, e.cipher.name, e.cipher.length, e.cipher.tagLength, e.cipher.iv]));

/** Keys live only in the page. All persisted writes are authenticated ciphertext. */
export class EncryptedPasswordStore implements PasswordStore {
  private options: Options;
  private ready?: Promise<void>;
  private session: VaultSession;
  private tickets = new Map<string, Ticket>();
  constructor(options: Options) {
    this.options = options;
    this.session = options.session ?? { epoch: 0, activity: options.now() };
    const family = sessions.get(options.storage) ?? new Set(); family.add(new WeakRef(this)); sessions.set(options.storage, family);
  }
  private assertActive(signal?: AbortSignal): void {
    if (this.options.incognito) throw new Error("Password vault is disabled in incognito");
    if (this.options.signal?.aborted || signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  }
  private async protect(): Promise<void> {
    this.assertActive();
    try { this.ready ??= this.options.storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }); await this.ready; }
    catch { this.ready = undefined; throw new Error("Unable to protect password storage"); }
    this.assertActive();
  }
  private async data(): Promise<Record<string, unknown>> {
    await this.protect();
    try { const result = await this.options.storage.get([V1, V2]); this.assertActive(); return result; }
    catch (e) { if (e instanceof DOMException && e.name === "AbortError") throw e; throw new Error("Unable to read password storage"); }
  }
  private async write(e: Envelope): Promise<void> {
    this.assertActive();
    try { await this.options.storage.set({ [V2]: e }); }
    catch { throw new Error("Unable to save password vault"); }
  }
  private async removeKeys(keys: string[]): Promise<void> {
    this.assertActive();
    try { await this.options.storage.remove(keys); }
    catch { throw new Error("Unable to remove remaining plaintext or password vault; migration may be incomplete"); }
  }
  private guard(epoch: number, signal?: AbortSignal): void {
    this.assertActive(signal);
    if (epoch !== this.session.epoch) throw new Error("Password operation expired; authenticate again");
  }
  invalidate(): void { this.session.key = undefined; this.session.signature = undefined; this.session.epoch++; this.tickets.clear(); }
  private invalidateAll(): void {
    for (const reference of sessions.get(this.options.storage) ?? []) {
      const store = reference.deref(); if (store) store.invalidate(); else sessions.get(this.options.storage)?.delete(reference);
    }
    this.options.onInvalidate?.();
  }
  async lock(): Promise<void> { this.invalidate(); }
  async noteActivity(): Promise<void> { this.assertActive(); await this.checkIdle(); if (this.session.key) this.session.activity = this.options.now(); }
  async checkIdle(): Promise<void> {
    if (this.options.now() - this.session.activity >= this.options.idleTimeoutMs) this.invalidate();
  }
  async status(): Promise<{ state: "uninitialized" | "legacy" | "migration-pending" | "locked" | "unlocked" | "incognito" }> {
    if (this.options.incognito) return { state: "incognito" };
    await this.checkIdle(); const data = await this.data();
    if (data[V1] !== undefined) { this.invalidate(); return { state: data[V2] === undefined ? "legacy" : "migration-pending" }; }
    if (data[V2] === undefined) { this.invalidate(); return { state: "uninitialized" }; }
    if (this.session.key) {
      try { if (signature(envelope(data[V2])) !== this.session.signature) this.invalidate(); } catch { this.invalidate(); }
    }
    return { state: this.session.key ? "unlocked" : "locked" };
  }
  private master(password: string, confirmation: string): void {
    if (typeof password !== "string" || password.length < PASSWORD_VAULT_POLICY.minMasterLength || password !== confirmation)
      throw new Error(`Master password must match its confirmation and contain at least ${PASSWORD_VAULT_POLICY.minMasterLength} characters`);
  }
  private async derive(master: string, e: Envelope): Promise<CryptoKey> {
    try {
      const material = await this.options.crypto.subtle.importKey("raw", encode(master), "PBKDF2", false, ["deriveKey"]);
      return await this.options.crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", iterations: e.kdf.iterations, salt: binary(e.kdf.salt) },
        material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    } catch { throw invalid(); }
  }
  private async decrypt(e: Envelope, key: CryptoKey): Promise<PasswordVault> {
    try {
      const bytes = await this.options.crypto.subtle.decrypt({ name: "AES-GCM", iv: binary(e.cipher.iv), additionalData: aad(e), tagLength: 128 }, key, binary(e.ciphertext));
      if (bytes.byteLength > PASSWORD_VAULT_POLICY.maxPlaintextBytes) throw invalid();
      return payload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch { throw invalid(); }
  }
  private async encrypt(v: PasswordVault, key: CryptoKey, e: Envelope): Promise<Envelope> {
    const next = structuredClone(e); next.cipher.iv = b64(this.options.crypto.getRandomValues(new Uint8Array(12)));
    try { next.ciphertext = b64(await this.options.crypto.subtle.encrypt({ name: "AES-GCM", iv: binary(next.cipher.iv), additionalData: aad(next), tagLength: 128 }, key, encode(JSON.stringify(payload(v))))); }
    catch { throw new Error("Unable to encrypt password vault"); }
    return next;
  }
  private async newVault(v: PasswordVault, master: string): Promise<{ envelope: Envelope; key: CryptoKey }> {
    const e: Envelope = { format: "vimdf-password-vault", version: 2,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PASSWORD_VAULT_POLICY.minKdfIterations,
        salt: b64(this.options.crypto.getRandomValues(new Uint8Array(16))) },
      cipher: { name: "AES-GCM", length: 256, tagLength: 128, iv: "" }, ciphertext: "" };
    const key = await this.derive(master, e); return { envelope: await this.encrypt(v, key, e), key };
  }
  private enable(key: CryptoKey, e: Envelope): void { this.session.key = key; this.session.signature = signature(e); this.session.activity = this.options.now(); }
  async create(master: string, confirmation: string): Promise<void> {
    this.assertActive(); this.master(master, confirmation); const epoch = this.session.epoch;
    await this.options.withLock(async () => {
      const d = await this.data(); if (d[V1] !== undefined || d[V2] !== undefined) throw new Error("Password vault already exists");
      const next = await this.newVault(empty(), master); this.guard(epoch); await this.write(next.envelope); this.enable(next.key, next.envelope);
    });
  }
  private current(d: Record<string, unknown>): Envelope {
    if (d[V1] !== undefined || d[V2] === undefined) throw new Error("Create or finish migrating the password vault first");
    return envelope(d[V2]);
  }
  async unlock(master: string): Promise<void> {
    this.assertActive(); const epoch = this.session.epoch, d = await this.data(), e = this.current(d);
    const key = await this.derive(master, e); await this.decrypt(e, key); this.guard(epoch);
    if (generation((await this.data())[V2]) !== JSON.stringify(e)) throw new Error("Password vault changed; authenticate again");
    this.guard(epoch); this.enable(key, e);
  }
  private async access(d?: Record<string, unknown>): Promise<{ envelope: Envelope; key: CryptoKey }> {
    await this.checkIdle(); const e = this.current(d ?? await this.data());
    if (!this.session.key || this.session.signature !== signature(e)) { this.invalidate(); throw new Error("Unlock the password vault first"); }
    return { envelope: e, key: this.session.key };
  }
  async vault(): Promise<PasswordVault> {
    this.assertActive(); const { envelope: e, key } = await this.access(), epoch = this.session.epoch;
    const v = await this.decrypt(e, key); this.guard(epoch); return v;
  }
  async read(key: string): Promise<{ records: PasswordRecord[]; rememberedId: string | null }> {
    if (this.options.incognito) return { records: [], rememberedId: null };
    if ((await this.status()).state !== "unlocked") return { records: [], rememberedId: null };
    const v = await this.vault(); return { records: v.autoFill ? v.records : [], rememberedId: v.remembered[key] ?? null };
  }
  private async change(action: (v: PasswordVault) => void): Promise<void> {
    this.assertActive(); const epoch = this.session.epoch;
    await this.options.withLock(async () => {
      this.guard(epoch); const { envelope: e, key } = await this.access(); const v = await this.decrypt(e, key);
      action(v); const next = await this.encrypt(v, key, e); this.guard(epoch); await this.write(next); this.tickets.clear();
    });
  }
  async register(draft: Draft): Promise<void> { await this.change(v => { validateRegistration(v.records, draft); v.records.push({ ...draft, id: this.options.crypto.randomUUID(), enabled: true }); }); }
  async save(key: string, draft: Draft): Promise<void> { await this.change(v => {
    let r = v.records.find(r => r.password === draft.password);
    if (!r) { validateRegistration(v.records, draft); r = { ...draft, id: this.options.crypto.randomUUID(), enabled: true }; v.records.push(r); }
    Object.defineProperty(v.remembered, key, { value: r.id, enumerable: true, configurable: true, writable: true });
  }); }
  async remember(key: string, id: string): Promise<void> { await this.change(v => {
    if (v.records.some(r => r.id === id && r.enabled)) Object.defineProperty(v.remembered, key, { value: id, enumerable: true, configurable: true, writable: true });
  }); }
  async update(id: string, patch: Partial<Omit<PasswordRecord, "id">>): Promise<void> { await this.change(v => {
    const r = v.records.find(r => r.id === id); if (!r) throw new Error("Password no longer exists");
    const next = { ...r, ...patch, id }; validateRegistration(v.records.filter(r => r.id !== id), next); Object.assign(r, next);
  }); }
  async remove(id: string): Promise<void> { await this.change(v => { v.records = v.records.filter(r => r.id !== id); for (const key of Object.keys(v.remembered)) if (v.remembered[key] === id) delete v.remembered[key]; }); }
  async move(id: string, direction: -1 | 1): Promise<void> { await this.change(v => {
    const i = v.records.findIndex(r => r.id === id), j = i + direction;
    if (i >= 0 && j >= 0 && j < v.records.length) [v.records[i], v.records[j]] = [v.records[j], v.records[i]];
  }); }
  async setAutoFill(value: boolean): Promise<void> { await this.change(v => { v.autoFill = value; }); }
  async clear(): Promise<void> { await this.change(v => { v.records = []; v.remembered = {}; }); }
  private output(text: string, suffix: string): { text: string; filename: string; mimeType: string } {
    const date = new Date(this.options.now()).toISOString().replace(/[-:]/g, "");
    return { text, mimeType: "application/json", filename: `vimdf-passwords-${date.slice(0, 8)}-${date.slice(9, 15)}.${suffix}.json` };
  }
  async exportBackup(options: { signal?: AbortSignal } = {}): Promise<{ text: string; filename: string; mimeType: string }> {
    this.assertActive(options.signal); const d = await this.data(); const e = this.current(d); this.assertActive(options.signal);
    return this.output(JSON.stringify(e), "vimdf-vault");
  }
  private ticket(value: Omit<Ticket, "epoch" | "expires">): string {
    const token = this.options.crypto.randomUUID(); this.tickets.set(token, { ...value, epoch: this.session.epoch, expires: this.options.now() + this.options.idleTimeoutMs }); return token;
  }
  private take(token: string, kind: Ticket["kind"], confirmed: boolean): Ticket {
    const value = this.tickets.get(token); this.tickets.delete(token); this.assertActive();
    if (!confirmed || !value || value.kind !== kind || value.epoch !== this.session.epoch || this.options.now() >= value.expires) throw new Error("Password operation expired or was not confirmed; authenticate again");
    return value;
  }
  async authorizePlaintext(master: string): Promise<string> {
    this.assertActive(); const epoch = this.session.epoch, d = await this.data(), e = this.current(d);
    const v = await this.decrypt(e, await this.derive(master, e)); this.guard(epoch);
    if (generation((await this.data())[V2]) !== JSON.stringify(e)) throw new Error("Password vault changed; authenticate again");
    this.guard(epoch); return this.ticket({ kind: "plain", generation: JSON.stringify(e), payload: v });
  }
  async exportPlaintext(token: string, options: { confirmed: boolean; signal?: AbortSignal }): Promise<{ text: string; filename: string; mimeType: string }> {
    const t = this.take(token, "plain", options.confirmed); this.assertActive(options.signal);
    const e = this.current(await this.data()); this.guard(t.epoch, options.signal);
    if (JSON.stringify(e) !== t.generation) throw new Error("Password vault changed; authenticate again");
    const records = t.payload!.records.map(({ name, password, enabled, shared }) => ({ name, password, enabled, shared }));
    return this.output(JSON.stringify({ format: "vimdf-password-export", version: 1, records }), "plaintext");
  }
  async prepareRestore(text: string, master: string): Promise<{ token: string; preview: { recordCount: number; replacesExisting: boolean } }> {
    this.assertActive(); const epoch = this.session.epoch;
    if (typeof text !== "string" || encode(text).length > PASSWORD_VAULT_POLICY.maxImportBytes) throw invalid();
    let e: Envelope; try { e = envelope(JSON.parse(text)); } catch { throw invalid(); }
    const d = await this.data(); if (d[V1] !== undefined) throw new Error("Finish migrating or reset the password vault first");
    if (d[V2] !== undefined) await this.access(d);
    const v = await this.decrypt(e, await this.derive(master, e)); this.guard(epoch);
    return { token: this.ticket({ kind: "restore", envelope: e, generation: generation(d[V2]) }),
      preview: { recordCount: v.records.length, replacesExisting: d[V2] !== undefined } };
  }
  async discardPrepared(token: string): Promise<void> { this.tickets.delete(token); }
  async restore(token: string, options: { confirmed: boolean }): Promise<void> {
    const t = this.take(token, "restore", options.confirmed);
    await this.options.withLock(async () => {
      const d = await this.data(); this.guard(t.epoch);
      if (d[V1] !== undefined || generation(d[V2]) !== t.generation) throw new Error("Password vault changed; validate the backup again");
      if (d[V2] !== undefined) await this.access(d);
      this.guard(t.epoch); await this.write(t.envelope!); this.invalidateAll();
    });
  }
  async changeMasterPassword(old: string, master: string, confirmation: string): Promise<void> {
    this.assertActive(); this.master(master, confirmation); const epoch = this.session.epoch;
    await this.options.withLock(async () => {
      const { envelope: e } = await this.access(); const v = await this.decrypt(e, await this.derive(old, e));
      const next = await this.newVault(v, master); this.guard(epoch); await this.write(next.envelope); this.invalidateAll();
    });
  }
  async migrate(master: string, confirmation: string): Promise<void> {
    this.assertActive(); this.master(master, confirmation); const epoch = this.session.epoch;
    await this.options.withLock(async () => {
      const d = await this.data(); if (d[V1] === undefined) throw new Error("No legacy passwords to migrate");
      const v = payload(d[V1]); let e: Envelope, key: CryptoKey;
      if (d[V2] !== undefined) {
        e = envelope(d[V2]); key = await this.derive(master, e);
        if (JSON.stringify(await this.decrypt(e, key)) !== JSON.stringify(v)) throw new Error("Migration verification failed; plaintext remains");
      } else { const next = await this.newVault(v, master); e = next.envelope; key = next.key; this.guard(epoch); await this.write(e); }
      const readback = this.currentMigration(await this.data());
      if (JSON.stringify(readback) !== JSON.stringify(e) || JSON.stringify(await this.decrypt(readback, key)) !== JSON.stringify(v)) throw new Error("Migration verification failed; plaintext remains");
      this.guard(epoch); await this.removeKeys([V1]); this.enable(key, e);
    });
  }
  private currentMigration(d: Record<string, unknown>): Envelope { return envelope(d[V2]); }
  async reset(options: { confirmed: boolean }): Promise<void> {
    this.assertActive(); if (!options.confirmed) throw new Error("Reset was not confirmed");
    await this.protect(); await this.options.withLock(async () => { await this.removeKeys([V1, V2]); this.invalidateAll(); });
  }
}

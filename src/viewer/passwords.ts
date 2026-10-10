export interface PasswordRecord {
  id: string;
  name: string;
  password: string;
  enabled: boolean;
  shared: boolean;
}

export interface PasswordAnswer {
  name: string;
  password: string;
  remember: boolean;
  shared: boolean;
  retrySaved?: boolean;
}

export interface PasswordStore {
  read(key: string): Promise<{ records: PasswordRecord[]; rememberedId: string | null }>;
  remember(key: string, id: string): Promise<void>;
  save(key: string, draft: Pick<PasswordAnswer, "name" | "password" | "shared">): Promise<void>;
}

export function documentKey(identity: string): string {
  const url = new URL(identity);
  if (!["https:", "http:", "file:"].includes(url.protocol)) {
    throw new Error("A document URL or content hash is required");
  }
  url.hash = "";
  return url.href;
}

export function selectCandidates(records: PasswordRecord[], rememberedId: string | null, enabled: boolean): PasswordRecord[] {
  if (!enabled) return [];
  const eligible = records.filter(r => r.enabled && (r.shared || r.id === rememberedId));
  const ordered = [...eligible.filter(r => r.id === rememberedId), ...eligible.filter(r => r.id !== rememberedId)];
  const seen = new Set<string>();
  return ordered.filter(r => {
    if (seen.has(r.password)) return false;
    seen.add(r.password);
    return true;
  }).slice(0, 100);
}

export function validateRegistration(records: PasswordRecord[], draft: Pick<PasswordRecord, "password">): void {
  if (typeof draft.password !== "string" || draft.password.length === 0) throw new Error("Enter a password");
  if (records.length >= 100) throw new Error("At most 100 passwords can be saved");
  if (records.some(r => r.password === draft.password)) throw new Error("This password is already registered");
}

interface LoadingTask<T> {
  // PDF.js declares this callback as Function rather than a typed signature.
  onPassword: Function | null;
  promise: Promise<T>;
  destroy(): Promise<void>;
}

export interface PasswordLoadOptions<T> {
  task: LoadingTask<T>;
  documentKey: string;
  store: PasswordStore;
  prompt(info: { incorrect: boolean; signal: AbortSignal }): Promise<PasswordAnswer | null>;
  autoFill: boolean;
  signal?: AbortSignal;
  onSaveError?: () => void;
}

/** Install the callback synchronously: PDF.js may request a password immediately. */
export async function openWithPasswords<T>(options: PasswordLoadOptions<T>): Promise<T> {
  const { task, store } = options;
  const lifetime = new AbortController();
  let stopped = false;
  let candidates: Promise<PasswordRecord[]> | undefined;
  let cursor = 0;
  let successfulRecord: PasswordRecord | undefined;
  let successfulAnswer: PasswordAnswer | undefined;
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  // Register the race before destruction can cause a task rejection.
  const completion = Promise.race([task.promise, failure]);
  const fail = (error: unknown): void => {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    rejectFailure(error);
    void task.destroy().catch(() => {});
  };
  const cancel = (): void => fail(new DOMException("PDF loading cancelled", "AbortError"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  task.onPassword = (updatePassword: (password: string) => void, reason: number): void => {
    void (async () => {
      if (stopped) return;
      candidates ??= options.autoFill
        ? store.read(options.documentKey).then(s => selectCandidates(s.records, s.rememberedId, true)).catch(() => [])
        : Promise.resolve([]);
      const saved = await candidates;
      if (stopped) return;
      successfulRecord = saved[cursor++];
      successfulAnswer = undefined;
      if (successfulRecord) {
        updatePassword(successfulRecord.password);
        return;
      }
      const answer = await options.prompt({ incorrect: reason === 2, signal: lifetime.signal });
      if (stopped) return;
      if (answer === null) { cancel(); return; }
      if (answer.retrySaved) {
        candidates = undefined; cursor = 0;
        task.onPassword?.(updatePassword, reason);
        return;
      }
      successfulAnswer = answer;
      updatePassword(answer.password);
    })().catch(() => fail(new Error("Unable to request a PDF password")));
  };
  if (options.signal?.aborted) cancel();
  try {
    const pdf = await completion;
    if (stopped) throw new DOMException("PDF loading cancelled", "AbortError");
    try {
      if (successfulRecord) await store.remember(options.documentKey, successfulRecord.id);
      else if (successfulAnswer?.remember) {
        const { name, password, shared } = successfulAnswer;
        await store.save(options.documentKey, { name, password, shared });
      }
    } catch {
      if (!stopped) options.onSaveError?.();
    }
    if (stopped) throw new DOMException("PDF loading cancelled", "AbortError");
    return pdf;
  } finally {
    stopped = true;
    lifetime.abort();
    options.signal?.removeEventListener("abort", cancel);
    task.onPassword = null;
    successfulAnswer = undefined;
    successfulRecord = undefined;
    candidates = undefined;
  }
}

export interface PdfSnapshot { identity: string; page: number; scroll: number }
export interface PdfRuntime {
  snapshot(): PdfSnapshot | null;
  save(snapshot: PdfSnapshot): Promise<void>;
  load(source: { data: ArrayBuffer; identity: string }, options: { signal: AbortSignal }): Promise<void>;
  suspend(): void;
  resume(): void;
  resetTransient(): void;
  dispose(): void;
}
export type PdfMode = "files" | "loading-pdf" | "pdf";
export function createLocalPdfController(options: {
  createRuntime(): PdfRuntime;
  history: Pick<History, "pushState" | "replaceState">;
  onMode(mode: PdfMode): void;
}) {
  const runtime = options.createRuntime();
  let mode: PdfMode = "files";
  let token: string | null = null;
  let loading: AbortController | null = null;
  let disposed = false;
  const setMode = (next: PdfMode) => { mode = next; options.onMode(next); };
  const abortError = () => new DOMException("PDF loading cancelled", "AbortError");
  const save = async () => { const snapshot = runtime.snapshot(); if (snapshot) await runtime.save({ ...snapshot }); };
  runtime.suspend();
  return {
    get mode() { return mode; },
    get documentToken() { return token; },
    async openPdf(file: File, identity: string) {
      if (disposed) throw new Error("PDF controller disposed");
      if (loading) throw new Error("PDF loading in progress");
      const operation = new AbortController(); loading = operation;
      const check = () => { if (operation.signal.aborted || disposed) throw abortError(); };
      runtime.suspend(); runtime.resetTransient(); setMode("loading-pdf");
      try {
        await save(); check();
        const data = await file.arrayBuffer(); check();
        await runtime.load({ data, identity }, { signal: operation.signal }); check();
        token = crypto.randomUUID();
        options.history.pushState({ view: "pdf", token }, "");
        runtime.resetTransient(); runtime.resume(); setMode("pdf");
      } catch (error) { runtime.suspend(); setMode("files"); throw error; }
      finally { if (loading === operation) loading = null; }
    },
    async back() {
      if (disposed) return;
      loading?.abort(); runtime.suspend(); runtime.resetTransient(); setMode("files");
      await save();
      if (!disposed && mode === "files") setMode("files");
    },
    async forward(requested: string) {
      if (disposed || loading || !token || requested !== token) { setMode("files"); return false; }
      runtime.resetTransient(); runtime.resume(); setMode("pdf"); return true;
    },
    cancel() { loading?.abort(); runtime.suspend(); runtime.resetTransient(); setMode("files"); },
    dispose() { if (disposed) return; disposed = true; loading?.abort(); runtime.dispose(); },
  };
}

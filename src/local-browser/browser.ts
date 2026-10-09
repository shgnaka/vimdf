import { FolderRegistry } from "./registry.ts";
import { LocalBrowserSession, type BrowserKey } from "./session.ts";
import { createFolderStorage, type IndexedFolderStorage } from "./indexeddb.ts";
import type { LocalDirectoryHandle } from "./directory.ts";
import { createLocalPdfController } from "./pdf-controller.ts";
import { createViewerRuntime } from "../viewer/runtime";
import { loadSettings } from "../common/settings";

type PickerWindow = Window & { showDirectoryPicker?: (options: { mode: "read" }) => Promise<LocalDirectoryHandle> };
const root = document.querySelector<HTMLElement>('[data-testid="local-browser"]')!;
const list = document.getElementById("browser-list")!;
const filter = document.querySelector<HTMLInputElement>('[data-testid="browser-filter"]')!;
const message = document.getElementById("browser-message")!;
const error = document.getElementById("browser-error")!;
const action = (name: string) => document.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!;
let session: LocalBrowserSession | null = null;
let storage: IndexedFolderStorage | null = null;
let ready = false;
let stale = false;
let checking = false;
let composing = false;
let removingId: string | null = null;
const removeDialog = document.getElementById("remove-root-dialog") as HTMLDialogElement;
let pdf: ReturnType<typeof createLocalPdfController> | null = null;
const folderApi = typeof (window as PickerWindow).showDirectoryPicker === "function";

function showError(reason: unknown) {
  if ((reason as { name?: string })?.name === "AbortError") return;
  if ((reason as { code?: string })?.code === "storage-conflict") announceStale();
  root.hidden = false;
  error.textContent = String(reason instanceof Error ? reason.message : reason);
  error.hidden = false;
}
function announceStale() { stale = true; document.querySelector<HTMLElement>('[data-testid="registry-stale"]')!.hidden = false; render(); }
function render() {
  const mode = pdf?.mode ?? "files";
  root.dataset.mode = mode;
  root.dataset.view = session?.view ?? "empty";
  root.dataset.busy = String(!ready || checking || !!session?.busy || mode === "loading-pdf");
  document.getElementById("files")!.hidden = mode !== "files";
  document.getElementById("pdf-surface")!.hidden = mode === "files";
  document.getElementById("pdf-loading")!.hidden = mode !== "loading-pdf";
  action("retry").hidden = error.hidden;
  action("retry").disabled = checking || !!session?.busy;
  action("add").disabled = !ready || !folderApi || stale || !!session?.busy || checking;
  action("roots").disabled = !ready || !!session?.busy || checking;
  action("authorize").hidden = session?.view !== "permission";
  action("authorize").disabled = !ready || stale || !!session?.busy;
  document.getElementById("browser-fallback")!.hidden = folderApi;
  if (!session) return;
  document.querySelector<HTMLElement>('[data-testid="browser-location"]')!.textContent = session.location;
  filter.readOnly = session.inputMode !== "filter";
  if (!composing && filter.value !== session.filter) filter.value = session.filter;
  document.getElementById("filter-mode")!.textContent = session.inputMode === "filter" ? "FILTER" : "NAMES";
  message.textContent = session.view === "empty" ? "Add a folder to browse its PDFs. You can register several folders."
    : session.view === "permission" ? "Read access is required. Press Enter to confirm, or Esc to choose another folder."
    : session.view === "roots" ? "Select a folder and press Enter to make it the default starting folder."
    : session.entries.length === 0 ? "No matching folders or PDFs." : "";
  const rows = session.entries.map((entry, index) => {
    const row = document.createElement("div"); row.className = "browser-row";
    row.setAttribute("role", "option"); row.setAttribute("aria-label", entry.name);
    row.setAttribute("aria-selected", String(index === session!.selectedIndex));
    const isRoot = "id" in entry;
    const directory = isRoot || entry.kind === "directory";
    const icon = document.createElement("span"); icon.className = "row-icon"; icon.setAttribute("aria-hidden", "true"); icon.textContent = directory ? "▱" : "▤";
    const name = document.createElement("span"); name.className = "row-name"; name.textContent = entry.name;
    if (isRoot && session!.entries.some(other => "id" in other && other.id !== entry.id && other.name === entry.name)) {
      let length = Math.min(8, entry.id.length);
      while (length < entry.id.length && session!.entries.some(other => "id" in other && other.id !== entry.id && other.id.startsWith(entry.id.slice(0, length)))) length++;
      const id = document.createElement("small"); id.className = "row-primary"; id.textContent = ` · ${entry.id.slice(0, length)}`; name.append(id);
      row.setAttribute("aria-label", `${entry.name} ${entry.id.slice(0, length)}`);
    }
    const kind = document.createElement("span"); kind.className = "row-kind"; kind.textContent = directory ? "Folder" : "PDF";
    row.append(icon, name, kind);
    if (isRoot) {
      if (entry.isPrimary) { const badge = document.createElement("span"); badge.className = "row-primary"; badge.textContent = "Default"; row.append(badge); }
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "row-remove"; remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Unregister ${entry.name}`); remove.disabled = stale || session!.busy;
      remove.onclick = event => {
        event.stopPropagation();
        removingId = entry.id;
        document.getElementById("remove-root-description")!.textContent = `${entry.name} · ${entry.id}`;
        removeDialog.showModal(); action("cancel-remove").focus();
      };
      row.append(remove);
    }
    row.onclick = () => {
      session!.select(index);
      list.querySelectorAll('[role="option"]').forEach((element, selected) => element.setAttribute("aria-selected", String(selected === session!.selectedIndex)));
      list.focus();
    };
    row.ondblclick = () => { session!.select(index); dispatch({ key: "Enter" }); };
    return row;
  });
  list.replaceChildren(...rows);
  document.getElementById("browser-count")!.textContent = `${rows.length} items`;
  if (session.inputMode === "filter" && document.activeElement !== filter) filter.focus();
  else if (session.inputMode !== "filter" && document.activeElement === filter) list.focus();
}
function observe(result: unknown) {
  render();
  if (result instanceof Promise) void result.catch(showError).finally(() => { render(); if (pdf?.mode === "files" && session?.inputMode !== "filter") list.focus(); });
}
function operate(operation: () => unknown) {
  if (!ready || stale || checking || session?.busy) return;
  error.hidden = true;
  try { observe(operation()); } catch (reason) { showError(reason); render(); }
}
function dispatch(event: BrowserKey) {
  if (!session || !ready || stale || checking) return false;
  const needsRead = session.view === "browse" && session.inputMode === "normal" && ["Enter", "l", "h"].includes(event.key);
  if (needsRead && !event.repeat) {
    checking = true; render();
    void storage!.checkRevision().then(changed => {
      checking = false;
      if (changed || stale) { announceStale(); return; }
      observe(session!.key(event));
    }).catch(showError).finally(() => { checking = false; render(); });
    return true;
  }
  // Picker and permission requests must start synchronously in this event.
  const result = session.key(event); observe(result); return result !== false;
}
filter.addEventListener("compositionstart", () => { composing = true; });
filter.addEventListener("compositionend", () => { composing = false; session?.setFilter(filter.value); render(); });
filter.addEventListener("input", () => { session?.setFilter(filter.value); render(); });
filter.addEventListener("focus", () => { if (session?.inputMode === "normal") { session.key({ key: "/" }); render(); } });
document.addEventListener("keydown", event => {
  if (pdf?.mode !== "files" || event.isComposing || composing || removeDialog.open) return;
  const target = event.target as HTMLElement;
  if (target.closest("button,a,select,textarea,[contenteditable=true]") || (target instanceof HTMLInputElement && target !== filter)) return;
  if (event.key === "L" && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); history.forward(); return; }
  try { if (dispatch(event)) event.preventDefault(); } catch (reason) { event.preventDefault(); showError(reason); render(); }
});
action("cancel-remove").onclick = () => { removeDialog.close(); removingId = null; list.focus(); };
action("confirm-remove").onclick = () => {
  const id = removingId; removeDialog.close(); removingId = null;
  if (id) operate(() => session!.removeRoot(id));
};
action("add").onclick = () => operate(() => {
  if (session!.view !== "empty" && session!.view !== "roots") session!.openRoots();
  return session!.key({ key: "a" });
});
action("retry").onclick = () => {
  if (!ready) { location.reload(); return; }
  if (stale) { action("reload-registry").click(); return; }
  checking = true; render();
  void storage!.checkRevision().then(changed => {
    checking = false;
    if (changed) { announceStale(); return; }
    error.hidden = true; observe(session!.refresh());
  }).catch(showError).finally(() => { checking = false; render(); });
};
action("roots").onclick = () => { if (ready) { session?.openRoots(); render(); list.focus(); } };
action("authorize").onclick = () => operate(() => session!.key({ key: "Enter" }));
action("settings").onclick = () => { void chrome.runtime.openOptionsPage(); };
action("back").onclick = () => history.back();
action("cancel-pdf").onclick = () => { pdf?.cancel(); render(); };
action("reload-registry").onclick = () => {
  if (!session || session.busy || checking) return;
  ready = false; render();
  void session.start().then(() => { stale = false; error.hidden = true; document.querySelector<HTMLElement>('[data-testid="registry-stale"]')!.hidden = true; })
    .catch(showError).finally(() => { ready = true; render(); list.focus(); });
};
const fileInput = document.getElementById("fallback-file") as HTMLInputElement;
action("pick-file").onclick = () => fileInput.click();
fileInput.onchange = () => {
  const file = fileInput.files?.[0]; fileInput.value = "";
  if (file && pdf) observe(pdf.openPdf(file, `https://local-pdf.vimdf.invalid/${crypto.randomUUID()}/${encodeURIComponent(file.name)}`));
};
window.addEventListener("popstate", event => {
  if (event.state?.view === "pdf") observe(pdf?.forward(event.state.token));
  else observe(pdf?.back());
});
window.addEventListener("focus", () => {
  if (ready && !session?.busy && storage) void storage.checkRevision().then(changed => { if (changed) announceStale(); }).catch(showError);
});
window.addEventListener("pagehide", () => { pdf?.dispose(); storage?.close(); ready = false; }, { once: true });

async function bootstrap() {
  if (chrome.extension.inIncognitoContext || window.parent !== window) throw new Error("Open the local PDF browser in a regular top-level tab.");
  const settings = await loadSettings();
  const runtime = createViewerRuntime(settings, direction => direction === "back" ? history.back() : history.forward());
  pdf = createLocalPdfController({ createRuntime: () => runtime, history, onMode: () => { render(); if (pdf?.mode === "files") list.focus(); } });
  history.replaceState({ view: "files" }, "");
  storage = await createFolderStorage({ indexedDB, BroadcastChannel,
    pick: options => (window as PickerWindow).showDirectoryPicker!(options), newId: () => crypto.randomUUID(),
    onChanged: announceStale, onBlocked: () => showError(new Error("Saved folders are blocked by another tab. Close it and reload.")),
    onVersionChange: () => { ready = false; showError(new Error("Folder storage changed. Reload this tab.")); render(); },
  });
  session = new LocalBrowserSession({ registry: new FolderRegistry(storage), openPdf: (file, identity) => pdf!.openPdf(file, identity) });
  await session.start(); ready = true; root.hidden = false; render(); list.focus();
}
render();
void bootstrap().catch(reason => { ready = false; root.hidden = false; showError(reason); render(); });

import { FolderRegistry } from "./registry.ts";
import { LocalBrowserSession, type BrowserKey } from "./session.ts";
import { createFolderStorage, type IndexedFolderStorage } from "./indexeddb.ts";
import type { LocalDirectoryHandle } from "./directory.ts";
import { createLocalPdfController } from "./pdf-controller.ts";
import { createViewerRuntime } from "../viewer/runtime";
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged } from "../common/settings";
import { HelpPanel } from "../common/help-panel";
import { browserBindings } from "./commands.ts";

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
let historyNotice = "";
let browserSettings = DEFAULT_SETTINGS;
let stopSettings: (() => void) | undefined;
const removeDialog = document.getElementById("remove-root-dialog") as HTMLDialogElement;
let pdf: ReturnType<typeof createLocalPdfController> | null = null;
const folderApi = typeof (window as PickerWindow).showDirectoryPicker === "function";
const help = new HelpPanel(document.getElementById("browser-help") as HTMLDialogElement, () => session?.resetKeySequence());
function toggleHelp() {
  if (!help.dialog.open) {
    const rows = browserBindings(session?.view ?? "empty", folderApi).map(([key, text]) => {
      const row = document.createElement("tr"); row.dataset.command = key;
      const binding = document.createElement("td"); binding.dataset.key = key; binding.textContent = key;
      const description = document.createElement("td"); description.textContent = text;
      row.append(binding, description); return row;
    });
    help.dialog.querySelector("table")!.replaceChildren(...rows);
  }
  help.toggle();
}

function showError(reason: unknown) {
  if ((reason as { code?: string })?.code === "storage-conflict") announceStale();
  root.hidden = false;
  error.textContent = String(reason instanceof Error ? reason.message : reason);
  error.hidden = false;
}
function focusFiles() {
  if (document.querySelector("dialog[open]")) return;
  (folderApi ? list : root).focus({ preventScroll: true });
}
function applyActionVisibility() {
  const focused = document.activeElement;
  const add = action("add"), roots = action("roots");
  add.hidden = !folderApi || !browserSettings.showAddFolderButton;
  roots.hidden = !folderApi || !browserSettings.showRegisteredFoldersButton;
  // A visibility-only update must not rebuild rows, end input or close a modal.
  if ((focused === add && add.hidden || focused === roots && roots.hidden) && pdf?.mode === "files") {
    if (session?.inputMode === "filter") filter.focus({ preventScroll: true });
    else focusFiles();
  }
}
async function openPdf(file: File, identity: string) {
  historyNotice = "";
  try { await pdf!.openPdf(file, identity); }
  catch (reason) {
    // PDF/password cancellation belongs to this operation. Registry save
    // aborts must still reach showError; FolderRegistry handles picker cancellation.
    if ((reason as { name?: string })?.name !== "AbortError") throw reason;
  }
}
function announceStale() { stale = true; document.querySelector<HTMLElement>('[data-testid="registry-stale"]')!.hidden = false; render(); }
function render() {
  const mode = pdf?.mode ?? "files";
  if (mode !== "files" && help.dialog.open) help.close();
  root.dataset.mode = mode;
  root.dataset.view = session?.view ?? "empty";
  root.dataset.busy = String(!ready || checking || !!session?.busy || mode === "loading-pdf");
  document.getElementById("files")!.hidden = mode !== "files";
  document.getElementById("pdf-surface")!.hidden = mode === "files";
  document.getElementById("pdf-loading")!.hidden = mode !== "loading-pdf";
  action("retry").hidden = error.hidden;
  action("retry").disabled = checking || !!session?.busy;
  action("add").disabled = !ready || !folderApi || stale || !!session?.busy || checking;
  applyActionVisibility();
  action("roots").disabled = !ready || !folderApi || !!session?.busy || checking;
  action("back").disabled = mode !== "pdf";
  action("authorize").hidden = !folderApi || session?.view !== "permission";
  action("authorize").disabled = !ready || !folderApi || stale || !!session?.busy;
  for (const element of document.querySelectorAll<HTMLElement>(".list-labels, #browser-list, .browser-footer")) element.hidden = !folderApi;
  document.querySelector<HTMLElement>(".browser-search")!.hidden = !folderApi || session?.inputMode !== "filter";
  message.hidden = !folderApi && !historyNotice;
  document.getElementById("browser-fallback")!.hidden = folderApi && !(pdf && !ready && !error.hidden);
  action("pick-file").disabled = !pdf || pdf.mode === "loading-pdf";
  if (!session) return;
  document.querySelector<HTMLElement>('[data-testid="browser-location"]')!.textContent = session.location;
  filter.readOnly = session.inputMode !== "filter";
  filter.disabled = !ready || !folderApi || checking || session.busy || stale;
  list.setAttribute("aria-busy", String(checking || session.busy));
  if (!composing && filter.value !== session.filter) filter.value = session.filter;
  document.getElementById("filter-mode")!.textContent = session.inputMode === "filter" ? "FILTER" : "NAMES";
  message.textContent = historyNotice || (session.view === "empty" ? "Add a folder to browse its PDFs. You can register several folders."
    : session.view === "permission" ? "Read access is required. Press Enter to confirm, or Esc to choose another folder."
    : session.entries.length === 0 && session.filter ? "No matching folder or PDF names. Clear the filter to see all items."
    : session.view === "roots" ? "Select a folder and press Enter to make it the default starting folder."
    : session.entries.length === 0 ? "This folder has no folders or PDFs to display." : "");
  const rows = session.entries.map((entry, index) => {
    const row = document.createElement("div"); row.className = "browser-row vimdf-row"; row.id = `browser-row-${index}`;
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
        const remaining = session!.registeredFolders.filter(folder => folder.id !== entry.id);
        const nextPrimary = remaining.find(folder => folder.isPrimary) ?? remaining[0];
        document.getElementById("remove-root-outcome")!.textContent = !nextPrimary
          ? "No registered folders will remain. You can add a folder again."
          : entry.isPrimary ? `The default starting folder will be ${nextPrimary.name} · ${nextPrimary.id}.`
          : "The default starting folder stays the same.";
        removeDialog.showModal(); action("cancel-remove").focus();
      };
      row.append(remove);
    }
    row.onclick = () => {
      session!.select(index);
      list.querySelectorAll('[role="option"]').forEach((element, selected) => element.setAttribute("aria-selected", String(selected === session!.selectedIndex)));
      list.setAttribute("aria-activedescendant", `browser-row-${session!.selectedIndex}`);
      focusFiles();
      row.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    row.ondblclick = () => { session!.select(index); dispatch({ key: "Enter" }); };
    return row;
  });
  list.replaceChildren(...rows);
  if (session.selectedIndex >= 0) list.setAttribute("aria-activedescendant", `browser-row-${session.selectedIndex}`);
  else list.removeAttribute("aria-activedescendant");
  document.getElementById("browser-count")!.textContent = `${rows.length} items`;
  document.getElementById("browser-state")!.textContent = `${session.view.toUpperCase()} ${session.location} ${session.selectedIndex + 1}/${rows.length}${session.filter ? ` /${session.filter}` : ""}`;
  if (folderApi && session.inputMode === "filter" && document.activeElement !== filter && !document.querySelector("dialog[open]")) filter.focus({ preventScroll: true });
  else if (session.inputMode !== "filter" && document.activeElement === filter) focusFiles();
  if (folderApi && mode === "files" && !removeDialog.open) rows[session.selectedIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function observe(result: unknown) {
  render();
  if (result instanceof Promise) void result.catch(showError).finally(() => { render(); if (pdf?.mode === "files" && session?.inputMode !== "filter") focusFiles(); });
}
function operate(operation: () => unknown) {
  if (!folderApi || !ready || stale || checking || session?.busy) return;
  error.hidden = true;
  historyNotice = "";
  try { observe(operation()); } catch (reason) { showError(reason); render(); }
}
function dispatch(event: BrowserKey) {
  if (!folderApi || !session || !ready || stale || checking) return false;
  historyNotice = "";
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
filter.addEventListener("compositionend", () => { composing = false; historyNotice = ""; session?.setFilter(filter.value); render(); });
filter.addEventListener("input", () => { historyNotice = ""; session?.setFilter(filter.value); render(); });
filter.addEventListener("focus", () => { if (folderApi && session?.inputMode === "normal") { historyNotice = ""; session.key({ key: "/" }); render(); } });
document.addEventListener("keydown", event => {
  if (pdf?.mode !== "files") return;
  if (help.handle(event)) { event.stopPropagation(); return; }
  if (event.isComposing || composing || document.querySelector("dialog[open]")) return;
  const target = event.target as HTMLElement;
  if (target.closest("button,a,select,textarea,[contenteditable=true]") || (target instanceof HTMLInputElement && target !== filter)) return;
  if (event.key === "?" && target !== filter && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault(); if (!event.repeat) toggleHelp(); return;
  }
  if (event.key === "L" && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); history.forward(); return; }
  try { if (dispatch(event)) event.preventDefault(); } catch (reason) { event.preventDefault(); showError(reason); render(); }
});
removeDialog.addEventListener("close", () => { removingId = null; focusFiles(); });
action("cancel-remove").onclick = () => { removeDialog.close(); removingId = null; focusFiles(); };
action("confirm-remove").onclick = () => {
  const id = removingId; removeDialog.close(); removingId = null;
  if (id) operate(() => session!.removeRoot(id));
};
action("add").onclick = () => operate(() => {
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
action("roots").onclick = () => { if (folderApi && ready) { historyNotice = ""; session?.openRoots(); render(); focusFiles(); } };
action("authorize").onclick = () => operate(() => session!.key({ key: "Enter" }));
action("back").onclick = () => history.back();
action("cancel-pdf").onclick = () => { pdf?.cancel(); render(); };
action("reload-registry").onclick = () => {
  if (!session || session.busy || checking) return;
  ready = false; render();
  void session.start().then(() => { stale = false; error.hidden = true; document.querySelector<HTMLElement>('[data-testid="registry-stale"]')!.hidden = true; })
    .catch(showError).finally(() => { ready = true; render(); focusFiles(); });
};
const fileInput = document.getElementById("fallback-file") as HTMLInputElement;
action("pick-file").onclick = () => fileInput.click();
fileInput.onchange = () => {
  const file = fileInput.files?.[0]; fileInput.value = "";
  if (file && pdf) observe(openPdf(file, `https://local-pdf.vimdf.invalid/${crypto.randomUUID()}/${encodeURIComponent(file.name)}`));
};
window.addEventListener("popstate", event => {
  historyNotice = "";
  if (event.state?.view === "pdf") observe(pdf?.forward(event.state.token).then(retained => {
    if (!retained) historyNotice = "Select the PDF again to reopen this discarded history entry.";
  }));
  else observe(pdf?.back());
});
window.addEventListener("focus", () => {
  if (ready && !session?.busy && storage) void storage.checkRevision().then(changed => { if (changed) announceStale(); }).catch(showError);
});
window.addEventListener("pagehide", () => { stopSettings?.(); pdf?.dispose(); storage?.close(); ready = false; }, { once: true });

async function bootstrap() {
  if (chrome.extension.inIncognitoContext || window.parent !== window) throw new Error("Open the local PDF browser in a regular top-level tab.");
  const settings = await loadSettings();
  browserSettings = settings;
  applyActionVisibility();
  stopSettings = onSettingsChanged(settings => { browserSettings = settings; applyActionVisibility(); });
  const runtime = createViewerRuntime(settings, direction => direction === "back" ? history.back() : history.forward());
  pdf = createLocalPdfController({ createRuntime: () => runtime, history, onMode: () => { render(); if (pdf?.mode === "files") focusFiles(); } });
  history.replaceState({ view: "files" }, "");
  storage = await createFolderStorage({ indexedDB, BroadcastChannel,
    pick: options => (window as PickerWindow).showDirectoryPicker!(options), newId: () => crypto.randomUUID(),
    onChanged: announceStale, onBlocked: () => showError(new Error("Saved folders are blocked by another tab. Close it and reload.")),
    onVersionChange: () => { ready = false; showError(new Error("Folder storage changed. Reload this tab.")); render(); },
  });
  if (!folderApi) {
    // Initialize the store without restoring saved handles or reading folders.
    storage.close(); storage = null;
    ready = true; root.hidden = false; render(); focusFiles(); return;
  }
  session = new LocalBrowserSession({ registry: new FolderRegistry(storage), openPdf });
  await session.start();
  ready = true; root.hidden = false; render(); focusFiles();
}
render();
void bootstrap().catch(reason => {
  // A restored registry whose permission query/listing failed still offers
  // explicit authorization and another registered root. Failed DB/state
  // initialization remains locked until a successful reload.
  ready = !!session && (session.view === "permission" || session.view === "browse");
  root.hidden = false; showError(reason); render();
});

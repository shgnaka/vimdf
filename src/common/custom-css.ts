export const CUSTOM_CSS_KEY = "vimdf.customCss.v1";
let initialized = false;
/** Installed once per application page; Options intentionally never calls it. */
export function setupCustomCss(): void {
  if (initialized) return;
  initialized = true;
  const style = document.createElement("style"); style.dataset.vimdfCustomCss = ""; document.head.append(style);
  const apply = (value: unknown) => {
    const v = value as { version?: number; css?: string } | undefined;
    style.textContent = v?.version === 1 && typeof v.css === "string" ? v.css : "";
  };
  let revision = 0;
  const initial = revision;
  void chrome.storage.local.get(CUSTOM_CSS_KEY).then(d => { if (initial === revision) apply(d[CUSTOM_CSS_KEY]); }).catch(() => {});
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: chrome.storage.AreaName) => {
    if (area === "local" && CUSTOM_CSS_KEY in changes) { revision++; apply(changes[CUSTOM_CSS_KEY].newValue); }
  };
  chrome.storage.onChanged.addListener(listener);
  window.addEventListener("pagehide", () => chrome.storage.onChanged.removeListener(listener), { once: true });
}

export function setupCustomCssOptions(): void {
  const input = document.getElementById("customCss") as HTMLTextAreaElement;
  const status = document.getElementById("customCssStatus")!;
  void chrome.storage.local.get(CUSTOM_CSS_KEY).then(d => {
    const v = d[CUSTOM_CSS_KEY] as { version?: number; css?: string } | undefined;
    input.value = v?.version === 1 && typeof v.css === "string" ? v.css : "";
  }).catch(() => { status.textContent = "Unable to read Custom CSS. Built-in styles remain available."; });
  const save = async (css: string) => {
    try { await chrome.storage.local.set({ [CUSTOM_CSS_KEY]: { version: 1, css } }); status.textContent = "Saved"; }
    catch { status.textContent = "Could not save CSS; draft remains unsaved."; }
  };
  document.getElementById("saveCustomCss")!.addEventListener("click", () => { void save(input.value); });
  document.getElementById("resetCustomCss")!.addEventListener("click", () => {
    void save("").then(() => { if (status.textContent === "Saved") input.value = ""; });
  });
}

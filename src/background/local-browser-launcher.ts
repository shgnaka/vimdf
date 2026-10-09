import { acceptExternalOpen } from "../local-browser/model.ts";

export const launcherKey = "vimdf.localBrowser.launcher.v1";
export interface LauncherSettings { version: 1; enabled: boolean; allowedIds: string[] }
export function launcherSettings(value: unknown): LauncherSettings {
  const fallback: LauncherSettings = { version: 1, enabled: false, allowedIds: [] };
  if (!value || typeof value !== "object") return fallback;
  const settings = value as LauncherSettings;
  if (settings.version !== 1 || typeof settings.enabled !== "boolean" || !Array.isArray(settings.allowedIds)
      || settings.allowedIds.some(id => typeof id !== "string" || !/^[a-p]{32}$/.test(id))) return fallback;
  return { version: 1, enabled: settings.enabled, allowedIds: [...new Set(settings.allowedIds)] };
}
export async function openLocalBrowser(api: typeof chrome, target: Promise<chrome.windows.Window>): Promise<void> {
  if (api.extension.inIncognitoContext) throw new Error("Use a regular browser window");
  const captured = await target;
  if (captured.id === undefined || captured.incognito || captured.type !== "normal") throw new Error("No regular target window");
  const verified = await api.windows.get(captured.id);
  if (verified.incognito || verified.type !== "normal") throw new Error("Target window unavailable");
  await api.tabs.create({ url: api.runtime.getURL("src/local-browser/browser.html"), windowId: captured.id, active: true });
}
export function installLocalBrowserLauncher(api: typeof chrome): () => void {
  const external = (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: boolean) => void): true => {
    // Capture the window at receipt, before the settings read can yield.
    const target = sender.tab?.windowId !== undefined ? api.windows.get(sender.tab.windowId) : api.windows.getLastFocused();
    // Avoid an unhandled rejected window promise while settings are pending.
    const captured = target.then(window => ({ window }), error => ({ error }));
    void (async () => {
      try {
        if (api.extension.inIncognitoContext || sender.tab?.incognito) return false;
        const result = await api.storage.local.get(launcherKey);
        const settings = launcherSettings(result[launcherKey]);
        if (!settings.enabled || !acceptExternalOpen(message, { id: sender.id, incognito: sender.tab?.incognito }, settings.allowedIds)) return false;
        const outcome = await captured;
        if (!("window" in outcome)) return false;
        await openLocalBrowser(api, Promise.resolve(outcome.window));
        return true;
      } catch { return false; }
    })().then(reply);
    return true;
  };
  const action = (tab: chrome.tabs.Tab) => {
    if (tab.incognito || api.extension.inIncognitoContext) return;
    const target = tab.windowId !== undefined ? api.windows.get(tab.windowId) : api.windows.getLastFocused();
    void openLocalBrowser(api, target).catch(() => {});
  };
  api.runtime.onMessageExternal.addListener(external);
  api.action.onClicked.addListener(action);
  return () => { api.runtime.onMessageExternal.removeListener(external); api.action.onClicked.removeListener(action); };
}

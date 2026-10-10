import { launcherKey, launcherSettings, openLocalBrowser } from "../background/local-browser-launcher";
export async function setupLauncherOptions(): Promise<void> {
  const enabled = document.getElementById("launcherEnabled") as HTMLInputElement;
  const ids = document.getElementById("launcherAllowedIds") as HTMLTextAreaElement;
  const status = document.getElementById("launcherStatus")!;
  const commands = document.getElementById("launcherCommands")!;
  const ownId = document.getElementById("vimdfExtensionId") as HTMLInputElement;
  ownId.value = chrome.runtime.id;
  commands.textContent = `map <v-vimdf> sendToExtension id="${ownId.value}" raw data={"type":"vimdf.openLocalBrowser","version":1}\nvimdf: vimium://run/<v-vimdf> blank=vimium://run/<v-vimdf> VimDF files`;
  document.getElementById("copyLauncherCommands")!.onclick = () => {
    void navigator.clipboard.writeText(commands.textContent!).then(() => { status.textContent = "Commands copied."; }).catch(error => { status.textContent = String(error); });
  };
  document.getElementById("launchLocalBrowser")!.onclick = () => {
    void openLocalBrowser(chrome, chrome.windows.getLastFocused()).catch(error => { status.textContent = String(error); });
  };
  if (chrome.extension.inIncognitoContext) { status.textContent = "Change launch settings in a regular window."; return; }
  try {
    const result = await chrome.storage.local.get(launcherKey);
    const settings = launcherSettings(result[launcherKey]);
    enabled.checked = settings.enabled; ids.value = settings.allowedIds.join("\n");
    enabled.disabled = ids.disabled = false;
  } catch (error) { status.textContent = `Cannot load launch settings: ${String(error)}`; return; }
  let saving = false;
  const save = async () => {
    if (saving) return;
    const allowedIds = [...new Set(ids.value.split(/\s+/).filter(Boolean))];
    if (allowedIds.some(id => !/^[a-p]{32}$/.test(id))) { status.textContent = "Each extension ID must contain 32 letters from a to p."; return; }
    saving = true; enabled.disabled = ids.disabled = true;
    try {
      await chrome.storage.local.set({ [launcherKey]: { version: 1, enabled: enabled.checked, allowedIds } });
      status.textContent = "Launch settings saved on this device.";
    } catch (error) { status.textContent = `Could not save launch settings: ${String(error)}`; }
    finally { saving = false; enabled.disabled = ids.disabled = false; }
  };
  enabled.onchange = () => { void save(); }; ids.onchange = () => { void save(); };
}

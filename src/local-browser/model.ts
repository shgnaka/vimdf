export { LocalBrowser } from "./directory.ts";
export type { LocalDirectoryHandle, LocalFileHandle, LocalEntry, OpenPdf } from "./directory.ts";
export { FolderRegistry } from "./registry.ts";
export type { FolderState, FolderStorage, RegisteredFolder } from "./registry.ts";
export { LocalBrowserSession } from "./session.ts";
export type { BrowserKey, BrowserView, RegisteredEntry } from "./session.ts";

/** Validate the external command without opening a tab or touching any files. */
export function acceptExternalOpen(message: unknown, sender: unknown, allowedIds: readonly string[]): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)
    || !sender || typeof sender !== "object") return false;
  const payload = message as Record<string, unknown>;
  const source = sender as { id?: unknown; incognito?: unknown };
  const keys = Object.keys(payload);
  return keys.length === 2 && keys.includes("type") && keys.includes("version")
    && payload.type === "vimdf.openLocalBrowser" && payload.version === 1
    && typeof source.id === "string" && allowedIds.includes(source.id) && source.incognito !== true;
}

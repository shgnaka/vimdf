import type { BrowserView } from "./session.ts";
export const FOLDER_KEYS = { roots: "r", add: "a" } as const;
export function browserBindings(view: BrowserView, supported: boolean): [string, string][] {
  if (!supported) return [["Enter", "Open PDF file"]];
  const rows: [string, string][] = [[FOLDER_KEYS.add, "Add folder"]];
  if (view !== "empty") rows.push([FOLDER_KEYS.roots, "Registered folders"]);
  if (view === "browse" || view === "roots") rows.push(["j / k", "Select next / previous row"], ["↑ / ↓", "Select row"],
    ["gg / G", "First / last row"], ["Enter / l", view === "roots" ? "Set primary folder and open it" : "Open folder or PDF"],
    ["h", view === "roots" ? "Stay in registered folders" : "Go to parent folder"], ["/", "Filter names"], ["Esc", "Clear filter or cancel folder selection"]);
  if (view === "permission") rows.push(["Enter", "Allow read access"], ["Esc", "Choose another registered folder"]);
  if (view === "empty") rows.push(["Enter", "Add first folder"]);
  return [...rows, ["?", "Toggle help"], ["j / k / ↑ / ↓", "Scroll help"], ["Ctrl-d / Ctrl-u", "Half page of help"],
    ["gg / G", "Top / bottom of help"], ["/", "Filter keybindings in help"], ["Enter", "Finish help filter input"],
    ["Esc", "Clear help filter or close help"], ["Tab / Shift-Tab", "Move between controls"], ["Enter", "Activate focused button"],
    ["Tab / Enter / Esc", "Unregister a folder through its row button and confirmation"]];
}

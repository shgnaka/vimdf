import { Viewer, applyTheme, applyCustomStyles } from "./core";
import type { PdfSource } from "./core";
import type { PdfSnapshot } from "../local-browser/pdf-controller.ts";
import { MarksStore } from "./marks";
import { SearchController } from "./search";
import { VimController } from "./vim-controller";
import { onSettingsChanged, type Settings } from "../common/settings";

/** One DOM tree, one controller and one settings subscription per page. */
export function createViewerRuntime(settings: Settings, navigateHistory?: (direction: "back" | "forward") => void) {
  applyTheme(settings.theme); applyCustomStyles(settings);
  const viewer = new Viewer(settings);
  const marks = new MarksStore("");
  const search = new SearchController(viewer);
  const vim = new VimController(viewer, marks, search, navigateHistory);
  vim.attach(); vim.suspend(); viewer.suspend();
  let disposed = false;
  const unsubscribe = onSettingsChanged(next => {
    if (disposed) return;
    viewer.settings = next; vim.updateSettings(next);
    applyTheme(next.theme); applyCustomStyles(next);
  });
  const scheme = window.matchMedia("(prefers-color-scheme: light)");
  const theme = () => { if (viewer.settings.theme === "auto") applyTheme("auto"); };
  scheme.addEventListener("change", theme);
  return {
    viewer,
    snapshot: () => viewer.snapshot(),
    save: (snapshot: PdfSnapshot) => viewer.flush(snapshot),
    async load(source: PdfSource, options: { signal?: AbortSignal } = {}) {
      const commitMarks = await marks.prepare(source.identity);
      if (options.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      await viewer.load(source, options);
      commitMarks(); vim.resetTransient(true);
    },
    suspend() { vim.suspend(); viewer.suspend(); },
    resume() { viewer.resume(); vim.resume(); },
    resetTransient() { vim.resetTransient(); },
    dispose() {
      if (disposed) return;
      disposed = true; unsubscribe(); scheme.removeEventListener("change", theme);
      vim.dispose(); viewer.dispose();
    },
  };
}

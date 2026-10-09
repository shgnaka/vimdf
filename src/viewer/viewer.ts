import { createViewerRuntime } from "./runtime";
export { Viewer } from "./core";
export type { PdfSource } from "./core";
import type { PdfSource } from "./core";
import { loadSettings } from "../common/settings";
import { checkAndShowConflictWarning } from "./conflict-notification";
import { checkAndShowUpdateNotification } from "./update-notification";
import { abortAndFallbackToNativeHandler, getStreamInfo, isAllowedFileSchemeAccess } from "./mime-handler";
import { closeLocalFilePanel, displayPath, enableDropToOpen, showLocalFilePanel } from "./local-file";

// The server answered, but not with usable PDF bytes — an HTML interstitial
// (Cloudflare "are you a robot?", a login wall), a 404 page, an error page.
// These are exactly the responses the browser should render natively so the
// user can act on them; pdf.js names them distinctly from network aborts.
function isNotAPdfResponse(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return (
    name === "InvalidPDFException" ||
    name === "MissingPDFException" ||
    name === "UnexpectedResponseException"
  );
}

/** Last path segment of a URL, percent-decoded, for comparing against a
 *  picked File's `name`. */
function basename(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    return "";
  }
}

// Ask the service worker to stand down for `file`, then re-navigate so the
// browser renders whatever the server is actually serving (bot-check
// challenge, login page, …). Once that's dealt with, the next load of the
// URL is intercepted normally again. sessionStorage is per-tab and survives
// the navigation away and back, so it guards against bouncing in a loop
// when the URL keeps serving non-PDF content.
async function requestNativeBypass(file: string): Promise<boolean> {
  // Meaningless for local files: there is no server to render an alternative
  // response, and with file access denied the re-navigation is blocked
  // anyway, leaving a blank page. The service worker refuses these too.
  if (file.startsWith("file:")) return false;
  const guardKey = `vimdf_bypassed:${file}`;
  const last = Number(sessionStorage.getItem(guardKey) ?? 0);
  if (Date.now() - last < 30_000) return false;
  let ok = false;
  try {
    ok =
      (await chrome.runtime.sendMessage({
        type: "vimdf.bypass",
        url: file,
      })) === true;
  } catch {
    ok = false;
  }
  if (!ok) return false;
  sessionStorage.setItem(guardKey, String(Date.now()));
  location.replace(file);
  return true;
}

/**
 * Work out what this page was opened to render.
 *
 * Two mechanisms can land a user here, and they're checked in this order:
 *
 *   1. **The declarativeNetRequest redirect** — `viewer.html?file=<url>`.
 *      The original URL is pasted in verbatim, with no percent-encoding of
 *      its `?`, `&` or `=`, because DNR's `\0` substitution doesn't re-encode.
 *      URLSearchParams would split on the first `&` inside that URL and
 *      silently truncate the rest (Notion's signed attachment URLs carry
 *      `?table=block&id=…&spaceId=…&userId=…&cache=v2` and would lose all
 *      but `table`, returning HTTP 400), so the value is taken as the raw
 *      tail of the search string instead.
 *   2. **`chrome.mimeHandler`** (Chrome 151+) — no query string at all;
 *      Chrome hands us the already-fetched response. This is the path local
 *      PDFs take, since it needs no file-scheme grant.
 *
 * `chrome.mimeHandler` exists on 151+ regardless of how we were opened, so
 * the query string has to be checked first: a DNR-redirected page is not a
 * handler frame and has no stream to ask for.
 */
type Resolved =
  | { kind: "source"; source: PdfSource }
  /** Nothing to render, and nothing to offer — viewer.html opened bare. */
  | { kind: "none" }
  /** Deliberately given back to Chrome's viewer; this frame is going away. */
  | { kind: "handed-back" };

async function resolveSource(): Promise<Resolved> {
  const m = location.search.match(/^\?file=(.*)$/);
  if (m) return { kind: "source", source: { url: m[1], identity: m[1] } };

  const stream = await getStreamInfo();
  if (!stream) return { kind: "none" };

  // Registering as the PDF MIME handler means Chrome routes *every* PDF here,
  // including ones the DNR rules deliberately let through. A response the
  // server marked as a download is the case that matters: those are often
  // one-shot endpoints, and the user asked for a file on disk, not a viewer.
  // Hand it straight back — `excludedResponseHeaders` on the Content-Type
  // rule below makes the same call for the redirect path.
  const disposition = headerValue(stream.responseHeaders, "content-disposition");
  if (/^\s*attachment/i.test(disposition)) {
    abortAndFallbackToNativeHandler();
    return { kind: "handed-back" };
  }

  // The stream URL may be fetched exactly once, so read it to completion
  // here rather than handing it to pdf.js, which would range-request it.
  try {
    const data = await (await fetch(stream.streamUrl)).arrayBuffer();
    return { kind: "source", source: { data, identity: stream.originalUrl } };
  } catch (err) {
    // We've consumed our one shot at the bytes and have nothing to show.
    // Chrome's own viewer can still re-request the document, so give it back
    // rather than leaving the user on a blank page where the built-in viewer
    // used to work.
    console.error("VimDF: failed to read MIME handler stream:", err);
    abortAndFallbackToNativeHandler();
    return { kind: "handed-back" };
  }
}

/** Case-insensitive lookup over `StreamInfo.responseHeaders`. */
function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string {
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === name) return v;
  }
  return "";
}

async function main(): Promise<void> {
  const resolved = await resolveSource();
  // The frame is being torn down by Chrome; don't paint anything over it.
  if (resolved.kind === "handed-back") return;
  const source = resolved.kind === "source" ? resolved.source : null;

  const settings = await loadSettings();
  const runtime = createViewerRuntime(settings);
  runtime.resume();
  window.addEventListener("pagehide", () => runtime.dispose(), { once: true });

  // If we're embedded as a sub-frame, ask our content script in the parent
  // page to focus this iframe — cross-origin iframes can't grab focus on
  // themselves, so keys go to the host page's body until the user clicks
  // the PDF. Top-level PDF tabs (no parent) skip this.
  if (window.parent !== window) {
    window.parent.postMessage("vimdf:loaded", "*");
  }

  void checkAndShowConflictWarning();
  void checkAndShowUpdateNotification();

  // Reading a file the user hands us directly needs no permission of any
  // kind, so this doubles as the recovery path for every local-file failure
  // below and as a general "open a PDF" gesture.
  //
  // `expected` is the file:// URL we were *asked* for, when recovering one.
  // Matching it back up keeps marks, highlights and last-page attached to the
  // document; any other file is its own document, keyed by name and size
  // because a picked File carries no path.
  const openFile = async (picked: File, expected?: string): Promise<void> => {
    const identity =
      expected && basename(expected) === picked.name
        ? expected
        : // Shaped as a URL, not an opaque string, so the machinery that
          // derives the window title and the Ctrl-S filename from a pathname
          // keeps working. Size disambiguates same-named files.
          `vimdf-local:///${picked.size}/${encodeURIComponent(picked.name)}`;
    closeLocalFilePanel();
    try {
      const data = await picked.arrayBuffer();
      const previous = runtime.snapshot();
      if (previous) await runtime.save(previous);
      await runtime.load({ data, identity });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      document.getElementById("statusLeft")!.textContent =
        `Error reading ${picked.name}: ${String(err)}`;
    }
  };
  enableDropToOpen((picked) => void openFile(picked));

  if (!source) {
    // No `?file=` and no MIME-handler stream — viewer.html was opened on its
    // own. Offer the picker rather than a dead end.
    showLocalFilePanel({
      reason: "no-document",
      onPick: (picked) => void openFile(picked),
    });
    return;
  }

  const file = source.identity;
  const isLocal = file.startsWith("file:");

  try {
    await runtime.load(source);
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      document.getElementById("statusLeft")!.textContent = "PDF loading cancelled";
      return;
    }
    console.error("Failed to load PDF:", err);
    if (isLocal) {
      // Every local read failure — permission denied, moved, deleted —
      // reaches us as MissingPDFException, which `isNotAPdfResponse` would
      // otherwise read as "the server sent an interstitial" and bounce out
      // to Chrome's native viewer with no message at all. There is no server
      // behind a file:// URL; say what actually went wrong and offer the
      // picker, which works whatever the permission state.
      const granted = await isAllowedFileSchemeAccess();
      showLocalFilePanel({
        reason: granted ? "unreadable" : "no-access",
        fileUrl: file,
        onPick: (picked) => void openFile(picked, file),
      });
      document.getElementById("statusLeft")!.textContent = granted
        ? `Can't read ${displayPath(file)}`
        : "No access to local files";
      return;
    }
    if (isNotAPdfResponse(err)) {
      // Hand the URL back to the browser so the interstitial / error page
      // the server is actually serving can render (and be acted on).
      //
      // Top-level tabs only. An embedded viewer (LaTeX livereload iframe)
      // hits this path with every half-written PDF mid-compile, and a
      // bypassed iframe navigation never fires tabs.onUpdated — the allow
      // rule would strand the document in Chrome's native viewer for every
      // reload after. There the transient error message *is* the right
      // outcome: the next recompile reload lands back in VimDF.
      const topLevel = window.parent === window;
      if (topLevel && (await requestNativeBypass(file))) return;
      document.getElementById("statusLeft")!.textContent =
        `Error loading PDF: ${String(err)} — the server answered with ` +
        "something that isn't a PDF (login or bot check?). Reload to retry.";
      return;
    }
    document.getElementById("statusLeft")!.textContent =
      `Error loading PDF: ${String(err)}`;
  }
}

void main();

<p align="center">
  <img src="assets/branding/logo.png" alt="VimDF logo" width="160">
</p>

<h1 align="center">VimDF: Vim for PDFs</h1>

<p align="center">
  <strong>Vim keybindings for PDF viewing in Chrome</strong><br>
  Scroll, jump, search, select and highlight — all without leaving the home row.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/vimdf/ljjchallgifapclnhgoilmlijmncbahn">
    <img src="https://img.shields.io/chrome-web-store/users/ljjchallgifapclnhgoilmlijmncbahn?style=flat-square&logo=googlechrome&logoColor=white&label=users&color=4285F4">
  </a>
  <a href="https://developer.chrome.com/docs/extensions/mv3/intro/">
    <img src="https://img.shields.io/badge/manifest-v3-4285F4?style=flat-square&logo=googlechrome&logoColor=white">
  </a>
  <a href="https://www.typescriptlang.org/">
    <img src="https://img.shields.io/badge/typescript-5.5-3178c6?style=flat-square&logo=typescript&logoColor=white">
  </a>
  <a href="https://mozilla.github.io/pdf.js/">
    <img src="https://img.shields.io/badge/pdf.js-4.7-red?style=flat-square">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-555?style=flat-square">
  </a>
</p>

## 📖 About

VimDF replaces Chrome's built-in PDF viewer with a modal, keyboard-driven one. It renders PDFs with [PDF.js](https://mozilla.github.io/pdf.js/) and wraps them in a Vim-style input layer — so reading a paper, thesis, or spec feels like editing in Vim: motions, marks, jump list, visual selection, hints, and all.

## ✨ Features

### Install a development build

Open [Actions → Tests](https://github.com/shgnaka/vimdf/actions/workflows/test.yml), choose a successful run for the branch you want, and download **vimdf-unpacked-…** under **Artifacts** (GitHub sign-in required). Extract the ZIP into a permanent folder. In `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the extracted folder containing `manifest.json`. The artifact contains the complete compiled extension; you do not need Node.js or the source repository to install it. Keep the folder after installation.

Each push and pull request generates an artifact after tests and the build pass. Artifacts are retained for 30 days. To update, replace the contents of the same folder with a newer artifact and click **Reload** on the extension. If building locally, run `npm ci` and `npm run build`, then load `dist/` instead. GitHub's **Download ZIP** under **Code** contains source code, not this compiled extension.

### Password-protected PDFs

In extension settings, create or unlock a vault under **PDF passwords**, then register named passwords. VimDF tries the last successful password for the document first, then enabled passwords marked for use on other PDFs. If none succeeds, enter a password in the modal dialog; saving is optional and happens only after the PDF opens. Registrations can be edited, disabled, reordered, or deleted.

Saved passwords and their names/document associations are encrypted with AES-256-GCM in this browser profile, never synced, and only passed to the local PDF.js reader after unlocking. Keep a dedicated master password in your password manager. Each page unlocks separately, stays unlocked across its document changes, and locks after 15 minutes without keyboard, pointer or wheel activity. Incognito mode does not read or write the password vault. Disable automatic input in settings to enter passwords manually. Development checks: Node.js 24+, `npm ci`, `npm run test:password`, and `npm run build`.

Options provides encrypted backup while locked, validated whole-vault restore, master-password change, vault-only reset, and plaintext JSON export with fresh reauthentication for every output. Old plaintext registrations stay unavailable until explicit migration verifies encrypted readback and removes them. See the [vault specification](docs/pdf-password-protection.md) and [security acceptance tests](docs/pdf-password-testing.md). Plaintext export is readable and must be handled separately from encrypted backups.

- **Vim-style navigation** — `j`/`k`/`h`/`l`, `gg`/`G`/`{n}G`, `Ctrl-d`/`Ctrl-u`/`Ctrl-f`/`Ctrl-b`
- **Tab navigation** (Vimium-compatible) — `J`/`K` previous/next tab, `g0`/`g$` first/last, `t` new tab, `x` close. Fills the gap left by Vimium not being able to bind keys on Chrome's PDF viewer
- **Search** — `/` to query, `n`/`N` to cycle matches
- **Fuzzy finder** (`T`) — Telescope-style picker across outline, figure/table captions, marks, highlights, and full text. Live preview with page thumbnail and highlighted snippet

  <p align="center">
    <img src="assets/store-screenshots/02-fuzzy-finder.png" alt="VimDF fuzzy finder with page preview" width="720">
  </p>

- **Marks** — `m{a-z}` to set, `'{a-z}` to jump back
- **Link hints** — `f` shows two-letter hint labels on every link in view, `F` opens in a new tab. After following a citation / internal link, `Ctrl-O` jumps back and `Ctrl-I` / `Tab` jumps forward through the history

  <p align="center">
    <img src="assets/store-screenshots/03-link-hints.png" alt="VimDF link hints over a PDF page" width="720">
  </p>
- **Jump list** — `Ctrl-O` / `Ctrl-I` / `Tab` to traverse your jump history (like Vim's `''` stack)
- **Outline sidebar** — `o` toggles table of contents, auto-focuses the section you're currently reading; `j`/`k` moves selection, `Enter` jumps
- **Caret mode** — `i` enters a Vim-modal caret over the text layer:
  - `h`/`l`/`w`/`b`/`e` for char/word motion, `W`/`B`/`E` for WORD motion
  - `j`/`k` column-aware line motion, `Ctrl-h`/`Ctrl-l` for column jumps
  - `0`/`^`/`$` line ends, `zz`/`zt`/`zb` caret-recentering
  - `v` / `V` / `Ctrl-V` for char / line / block VISUAL modes
  - `y` yank to clipboard, `H` save selection as persistent highlight
  - both operators take a motion or a text object, with counts:
    `yiw`, `yaw`, `yw`, `y$`, `2y3w`, `yy`, `Y` (= `y$`), and `Hiw` / `HH`
    to highlight the same ranges; `viw` / `vaw` select one in VISUAL
- **Download / Print** — `Ctrl-S` opens a finder-styled save dialog (defaults to `~/Downloads/`, remembers your last subfolder, `Ctrl-↵` for a native "Save as…" picker). `Ctrl-P` prints with page sizes matched to the PDF

  <p align="center">
    <img src="assets/store-screenshots/04-save-dialog.png" alt="VimDF save dialog" width="720">
  </p>

- **Publisher shims** — auto-redirects Science / OpenReview / ACM / arXiv viewer pages to the raw PDF so you stay in VimDF
- **Remembers last page** per document (toggleable). Also keeps within-page scroll position across **livereload reloads** — when a watcher regenerates a PDF and the iframe URL gets a cache-bust `?t=…`, VimDF treats it as the same document and restores your previous page + scroll offset, so the view doesn't jump on every recompile
- **Theming** — Auto/Dark/Light; customizable hint & status-bar colors
- **Keymap aliases** — bind your own keys to half/full-page scroll commands
- **Scrollable & searchable help** — `?` opens the keybinding reference; `j`/`k` to scroll, `/` to filter live

Press `?` inside the viewer for the full keybinding reference.

## 🚀 Installation

### From the Chrome Web Store

Install from the [**Chrome Web Store**](https://chromewebstore.google.com/detail/vimdf/ljjchallgifapclnhgoilmlijmncbahn).

On **Chrome 151+** that is the whole setup — local PDFs included. On older
builds, see [Local PDFs](#local-pdfs).

### From source (developer mode)

```bash
git clone https://github.com/tatsukamijo/vimdf.git
cd vimdf
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `dist/` folder

> **Testing local PDFs?** Unpacked extensions are granted file access
> automatically, Web Store installs are not. A `file://` regression will pass
> in `dist/` and fail for every real user — so verify with **Details** →
> **Allow access to file URLs** turned *off*.

## 💡 Usage

Once installed, any PDF you open — over `http(s)` or `file://` — is automatically handled by VimDF. It catches PDFs whether they open as their own tab or are embedded in a page's `<iframe>` (e.g. a live-preview server), and whether or not the URL ends in `.pdf` (it also inspects the response `Content-Type`). Press `?` to see all keybindings.

Settings live in the extension's Options page (right-click the toolbar icon → Options). Theme, scroll steps, zoom step, page-scroll aliases, link-hint colors, status-bar colors, and per-document last-page persistence are all configurable and sync across Chrome profiles.

### Local PDFs

On **Chrome 151+**, VimDF registers itself as the browser's handler for
`application/pdf`, so PDFs on your disk open in VimDF with nothing to
configure. The Options page has an **Open PDFs in VimDF** switch if you ever
want them back in Chrome's viewer.

On **older builds** the only route to a `file://` URL is the
**Allow access to file URLs** checkbox on VimDF's `chrome://extensions` card.
Chrome leaves it off for every Web Store install and refuses to evaluate any
interception rule against a local file until it is on — silently, which is
why a local PDF used to just open in Chrome's viewer with no explanation.
VimDF now says so, and offers a way to the checkbox.

Either way, you can always **drop a PDF onto the viewer** or pick one from
the prompt. Reading a file you hand over directly needs no permission at all,
and the document keeps its marks, highlights and last page.

### Registered folders and Vimium C

Click the VimDF toolbar icon, or **Open local PDF browser** in Options, to
open the folder browser. **Add folder** registers one folder at a time.
Use `j` / `k` to select, `Enter` / `l` to open, `h` to move to the parent,
and `/` to filter the current list by name. At a registered root, `h` opens
the registered-folder list. Confirming another folder makes it the default
starting folder; `Esc` returns without changing it.

PDFs open in the same tab with the existing Viewer keys: `/` searches the
PDF text and `n` / `N` move between matches. `H` or **Files** returns to the
same folder, filter and selection. Browser history can resume the retained
PDF; reloading starts at the saved primary folder. There is no recursive
folder search or cross-document text index.

Folder handles and the primary selection are saved in IndexedDB on this
device. Another tab's changes are announced and require an explicit reload.
Removing a registration keeps your files and saved PDF data.

For Vimium C, enable **Allow external extension launches** in Options,
register its extension ID, and copy the generated key mapping and search
engine commands into Vimium C. External launches are disabled by default.
The connection settings stay on this device. See the
[setup and key specification](docs/vimium-local-browser.md) and
[test coverage and manual checks](docs/local-browser-testing.md).

## 🛠 Development

```bash
npm run dev        # Vite dev server with HMR
npm run build      # production bundle in dist/
npm run typecheck  # tsc --noEmit
```

The codebase is roughly:

```
src/
├── background/service-worker.ts   # DNR rule to intercept PDF navigations
├── common/settings.ts             # chrome.storage.sync schema + migrations
├── options/                       # options page (HTML/CSS/TS)
└── viewer/                        # the viewer itself
    ├── viewer.ts                  # normal URL / MIME bootstrap
    ├── core.ts                    # PDF.js integration, state persistence
    ├── runtime.ts                 # shared controllers and lifecycle
    ├── vim-controller.ts          # root keydown dispatcher
    ├── caret-mode.ts              # modal text-caret navigation & selection
    ├── finder.ts                  # Telescope-style fuzzy finder (T)
    ├── hints.ts                   # link-hint overlay
    ├── outline.ts                 # sidebar TOC
    ├── search.ts                  # / search controller (PDF.js find)
    ├── marks.ts                   # per-doc mark persistence
    ├── highlights.ts              # user-saved highlights layer
    ├── print.ts                   # rasterised print + PDF download
    ├── save-dialog.ts             # modal filename picker for Ctrl-S
    └── continuous-scroll.ts       # rAF-driven smooth scroll for held keys
```

## 🔧 Tech

- [PDF.js](https://github.com/mozilla/pdf.js) for rendering
- [@crxjs/vite-plugin](https://crxjs.dev/vite-plugin/) for MV3 bundling
- TypeScript, Vite, Chrome Extension Manifest V3

## 👤 Author

Tatsuya Kamijo — <tatsukamijo@icloud.com>

## 📝 License

[MIT](LICENSE)

import { LocalBrowser } from "./directory.ts";
import type { LocalEntry, OpenPdf } from "./directory.ts";
import type { FolderRegistry, RegisteredFolder } from "./registry.ts";
import { NameSelection } from "./selection.ts";

export interface BrowserKey {
  key: string;
  repeat?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
}

export interface RegisteredEntry {
  readonly id: string;
  readonly name: string;
  readonly isPrimary: boolean;
}

export type BrowserView = "empty" | "browse" | "roots" | "permission";

const commandKeys = new Set(["j", "k", "ArrowUp", "ArrowDown", "g", "G", "h", "l", "Enter", "a", "/", "Escape"]);

export class LocalBrowserSession {
  private readonly registry: FolderRegistry;
  private readonly openPdf: OpenPdf;
  private readonly rootSelection = new NameSelection<RegisteredEntry>();
  private browser: LocalBrowser | null = null;
  private currentRootId: string | null = null;
  private pendingId: string | null = null;
  private currentView: BrowserView = "empty";
  private mode: "normal" | "filter" = "normal";
  private running = false;
  private pendingG = false;
  private returnToBrowser = false;
  private permissionFromRoots = false;

  constructor(options: { registry: FolderRegistry; openPdf: OpenPdf }) {
    this.registry = options.registry;
    this.openPdf = options.openPdf;
  }

  get view(): BrowserView { return this.currentView; }
  get activeRootId(): string | null { return this.currentRootId; }
  get pendingRootId(): string | null { return this.pendingId; }
  get busy(): boolean { return this.running; }
  get inputMode(): "normal" | "filter" { return this.mode; }
  get location(): string { return this.view === "browse" ? this.browser!.location : "Registered folders"; }
  get entries(): readonly (LocalEntry | RegisteredEntry)[] {
    return this.view === "browse" ? this.browser!.entries : this.view === "roots" ? this.rootSelection.entries : [];
  }
  get selectedIndex(): number {
    return this.view === "browse" ? this.browser!.selectedIndex : this.view === "roots" ? this.rootSelection.selectedIndex : -1;
  }
  get filter(): string {
    return this.view === "browse" ? this.browser!.filter : this.view === "roots" ? this.rootSelection.filter : "";
  }

  start(): Promise<void> {
    return this.run(async () => {
      let root: RegisteredFolder | null;
      try { root = await this.registry.restore(); }
      catch (error) {
        // A permission-query failure is not an empty registry. Keep its saved
        // primary available for explicit authorization or another root choice.
        if (this.registry.primaryId !== null) {
          this.browser = null;
          this.currentRootId = null;
          this.pendingId = this.registry.primaryId;
          this.currentView = "permission";
          this.mode = "normal";
          this.pendingG = false;
          this.returnToBrowser = false;
          this.permissionFromRoots = false;
        }
        throw error;
      }
      this.browser = null;
      this.currentRootId = null;
      this.returnToBrowser = false;
      this.permissionFromRoots = false;
      this.mode = "normal";
      this.pendingG = false;
      this.pendingId = this.registry.primaryId;
      if (root) await this.openRoot(root);
      else this.currentView = this.pendingId === null ? "empty" : "permission";
    });
  }

  /** Retry the current listing without changing its root or saved primary. */
  refresh(): Promise<void> {
    return this.run(async () => {
      if (this.view === "browse") await this.browser!.refresh();
    });
  }

  setFilter(text: string): void {
    if (this.busy) return;
    this.pendingG = false;
    if (this.view === "browse") this.browser!.setFilter(text);
    else if (this.view === "roots") this.rootSelection.setFilter(text);
  }

  select(index: number): void {
    if (this.busy || !Number.isInteger(index) || index < 0 || index >= this.entries.length) return;
    if (this.view === "browse") this.browser!.select(index);
    else if (this.view === "roots") this.rootSelection.select(index);
    this.pendingG = false;
  }

  openRoots(): void {
    if (this.busy) return;
    this.returnToBrowser = this.view === "browse";
    this.showRoots(this.currentRootId ?? this.registry.primaryId);
  }

  removeRoot(id: string): Promise<void> {
    return this.run(async () => {
      await this.registry.remove(id);
      if (this.currentRootId === id) {
        this.browser = null;
        this.currentRootId = null;
        this.returnToBrowser = false;
      }
      this.pendingId = null;
      if (this.registry.roots.length === 0) {
        this.browser = null;
        this.currentRootId = null;
        this.currentView = "empty";
        this.returnToBrowser = false;
      } else this.showRoots(this.registry.primaryId);
    });
  }

  // false is returned synchronously for unhandled input. A Promise always
  // denotes a consumed command, letting DOM callers preventDefault immediately.
  key(event: BrowserKey): boolean | Promise<boolean> {
    const { key } = event;
    if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) {
      this.pendingG = false;
      return false;
    }
    if (this.busy) return commandKeys.has(key);
    if (this.mode === "filter") {
      this.pendingG = false;
      if (event.repeat && (key === "Enter" || key === "Escape")) return true;
      if (key === "Enter") { this.mode = "normal"; return true; }
      if (key === "Escape") { this.mode = "normal"; this.setFilter(""); return true; }
      return false;
    }
    if (event.repeat && ["g", "Enter", "l", "a", "Escape"].includes(key)) {
      return this.view === "roots" || (this.view === "browse" && key !== "a")
        || (this.view === "empty" && (key === "Enter" || key === "a"))
        || (this.view === "permission" && (key === "Enter" || key === "Escape"));
    }
    if (key !== "g") this.pendingG = false;
    if (this.view === "empty") {
      return key === "Enter" || key === "a" ? this.consume(() => this.addFolder()) : false;
    }
    if (this.view === "permission") {
      if (key === "Enter") return this.consume(() => this.authorize());
      if (key === "Escape") {
        const pending = this.pendingId;
        this.pendingId = null;
        if (this.permissionFromRoots) this.currentView = "roots";
        else this.showRoots(pending);
        return true;
      }
      return false;
    }
    if (key === "/") { this.mode = "filter"; return true; }
    if (key === "Escape") {
      if (this.filter) this.setFilter("");
      else if (this.view === "roots" && this.returnToBrowser) {
        this.currentView = "browse";
        this.returnToBrowser = false;
      }
      return true;
    }
    if (key === "g") {
      if (this.pendingG) { this.move("gg"); this.pendingG = false; }
      else this.pendingG = true;
      return true;
    }
    if (this.move(key)) return true;
    if (this.view === "roots") {
      if (key === "h") return true;
      if (key === "a") return this.consume(() => this.addFolder());
      if (key === "Enter" || key === "l") return this.consume(() => this.activate());
    } else {
      if (key === "h") {
        if (this.browser!.atRoot) {
          this.returnToBrowser = true;
          this.showRoots(this.registry.primaryId);
          return true;
        }
        return this.consume(() => this.browser!.parent());
      }
      if (key === "Enter" || key === "l") return this.consume(() => this.browser!.enter());
    }
    return false;
  }

  private move(key: string): boolean {
    return this.view === "roots" ? this.rootSelection.key(key) : this.browser!.key(key);
  }

  private showRoots(selectedId: string | null): void {
    this.rootSelection.replace(this.registry.roots.map(root => ({
      id: root.id, name: root.handle.name, isPrimary: root.id === this.registry.primaryId,
    })), "");
    this.rootSelection.select(this.rootSelection.entries.findIndex(root => root.id === selectedId));
    this.currentView = "roots";
    this.mode = "normal";
    this.pendingG = false;
  }

  private async openRoot(root: RegisteredFolder): Promise<void> {
    this.browser = new LocalBrowser(root.handle, { rootId: root.id, openPdf: this.openPdf });
    this.currentRootId = root.id;
    this.pendingId = null;
    this.currentView = "browse";
    this.mode = "normal";
    this.pendingG = false;
    this.returnToBrowser = false;
    this.permissionFromRoots = false;
    await this.browser.refresh();
  }

  private async addFolder(): Promise<void> {
    const root = await this.registry.add();
    if (!root) return;
    if (this.view === "empty") await this.openRoot(root);
    else this.showRoots(root.id);
  }

  private async activate(): Promise<void> {
    const selected = this.rootSelection.entries[this.rootSelection.selectedIndex];
    if (!selected) return;
    const root = await this.registry.activate(selected.id);
    if (root) await this.openRoot(root);
    else {
      this.pendingId = selected.id;
      this.permissionFromRoots = true;
      this.currentView = "permission";
      this.mode = "normal";
    }
  }

  private async authorize(): Promise<void> {
    const root = await this.registry.authorize(this.pendingId!);
    if (root) await this.openRoot(root);
  }

  private async consume(operation: () => Promise<void>): Promise<boolean> {
    await this.run(operation);
    return true;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.running) throw new Error("Local browser operation in progress");
    this.running = true;
    try { return await operation(); }
    finally { this.running = false; }
  }
}

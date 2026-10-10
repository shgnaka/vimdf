import { compareNames, NameSelection } from "./selection.ts";

export interface LocalFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
}

/** The read-only subset of File System Access used by this model. */
export interface LocalDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterable<LocalEntry>;
  queryPermission(options: { mode: "read" }): Promise<PermissionState>;
  requestPermission(options: { mode: "read" }): Promise<PermissionState>;
  isSameEntry(other: LocalDirectoryHandle): Promise<boolean>;
}

export type LocalEntry = LocalDirectoryHandle | LocalFileHandle;
export type OpenPdf = (file: File, identity: string) => void | Promise<void>;

export class LocalBrowser {
  private readonly selection = new NameSelection<LocalEntry>();
  private readonly rootId: string;
  private readonly openPdf: OpenPdf;
  private path: readonly LocalDirectoryHandle[];
  private revision = 0;

  constructor(root: LocalDirectoryHandle, options: { rootId: string; openPdf: OpenPdf }) {
    if (!options.rootId) throw new Error("A registered root ID is required");
    this.rootId = options.rootId;
    this.openPdf = options.openPdf;
    this.path = [root];
  }

  get entries(): readonly LocalEntry[] { return this.selection.entries; }
  get selectedIndex(): number { return this.selection.selectedIndex; }
  get filter(): string { return this.selection.filter; }
  get atRoot(): boolean { return this.path.length === 1; }
  get location(): string { return this.path.map(directory => directory.name).join(" / "); }

  select(index: number): void { this.selection.select(index); }

  key(key: string): boolean { return this.selection.key(key); }
  setFilter(text: string): void { this.selection.setFilter(text); }

  async refresh(): Promise<void> { await this.list(this.path, false); }

  async enter(): Promise<void> {
    const entry = this.entries[this.selectedIndex];
    if (!entry) return;
    if (entry.kind === "directory") {
      await this.list([...this.path, entry], true);
      return;
    }
    // Encode path components separately: %, ?, # and Unicode must not alias a
    // different document. This reserved URL is an identity, never a fetch URL.
    const components = [this.rootId, ...this.path.slice(1).map(dir => dir.name), entry.name];
    const identity = `https://local-pdf.vimdf.invalid/${components.map(encodeURIComponent).join("/")}`;
    const file = await entry.getFile();
    await this.openPdf(file, identity);
  }

  async parent(): Promise<void> {
    if (!this.atRoot) await this.list(this.path.slice(0, -1), true);
  }

  private async list(path: readonly LocalDirectoryHandle[], resetFilter: boolean): Promise<void> {
    const revision = ++this.revision;
    const entries: LocalEntry[] = [];
    for await (const entry of path[path.length - 1].values()) {
      if (entry.kind === "directory" || /\.pdf$/i.test(entry.name)) entries.push(entry);
    }
    entries.sort((a, b) => a.kind === b.kind
      ? compareNames(a.name, b.name) : a.kind === "directory" ? -1 : 1);
    // An older, slower enumeration cannot overwrite a later navigation/refresh.
    if (revision !== this.revision) return;
    this.path = path;
    this.selection.replace(entries, resetFilter ? "" : this.filter);
  }
}

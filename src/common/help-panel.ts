/** Reusable modal help. Its key buffer, scroll and filter never reach the page. */
export class HelpPanel {
  private caller: Element | null = null;
  private pendingG = false;
  private searching = false;
  private input: HTMLInputElement;
  private bar: HTMLElement;
  private scroll: HTMLElement;
  constructor(readonly dialog: HTMLDialogElement, private onBoundary: () => void = () => {}) {
    this.scroll = dialog.querySelector<HTMLElement>(".help-inner")!;
    this.scroll.tabIndex = 0; this.scroll.dataset.testid = "help-scroll";
    this.bar = dialog.querySelector<HTMLElement>(".help-search, #helpSearch")!;
    this.input = this.bar.querySelector("input")!;
    this.input.setAttribute("aria-label", "Filter keybindings");
    this.input.addEventListener("input", () => this.filter());
    dialog.addEventListener("cancel", event => { event.preventDefault(); this.close(); });
  }
  open(): void {
    if (this.dialog.open) return;
    this.caller = document.activeElement; this.onBoundary(); this.pendingG = false;
    this.dialog.hidden = false; this.dialog.showModal(); this.scroll.focus();
  }
  close(): void {
    const wasOpen = this.dialog.open;
    this.clearSearch(); this.pendingG = false; this.dialog.close(); this.dialog.hidden = true; this.onBoundary();
    if (wasOpen && this.caller instanceof HTMLElement && this.caller.isConnected) this.caller.focus({ preventScroll: true });
  }
  toggle(): void { if (this.dialog.open) this.close(); else this.open(); }
  handle(event: KeyboardEvent): boolean {
    if (!this.dialog.open) return false;
    if (event.isComposing) return true;
    const key = event.key;
    if (event.repeat && ["g", "?", "Escape", "Enter"].includes(key)) { event.preventDefault(); return true; }
    if (document.activeElement === this.input) {
      if (key === "Enter") { event.preventDefault(); this.scroll.focus(); }
      else if (key === "Escape") { event.preventDefault(); this.clearSearch(); this.scroll.focus(); }
      return true;
    }
    if (key === "Tab") return true;
    if (event.altKey || event.metaKey || (event.ctrlKey && !["d", "u", "f", "b"].includes(key.toLowerCase()))) return true;
    event.preventDefault();
    if (key === "Escape") { if (this.searching) { this.clearSearch(); this.scroll.focus(); } else this.close(); return true; }
    if (key === "?" && !event.ctrlKey) { this.close(); return true; }
    if (key === "/") { this.pendingG = false; this.searching = true; this.bar.hidden = false; this.input.focus(); return true; }
    if (key === "g") { if (this.pendingG) { this.scroll.scrollTop = 0; this.pendingG = false; } else this.pendingG = true; return true; }
    this.pendingG = false;
    if (key === "G") this.scroll.scrollTop = this.scroll.scrollHeight;
    else if (event.ctrlKey && ["d", "u", "f", "b"].includes(key.toLowerCase())) {
      const k = key.toLowerCase(); this.scroll.scrollBy({ top: this.scroll.clientHeight * (["d", "u"].includes(k) ? .5 : .95) * (["u", "b"].includes(k) ? -1 : 1) });
    } else if (["j", "k", "ArrowDown", "ArrowUp"].includes(key)) this.scroll.scrollBy({ top: ["k", "ArrowUp"].includes(key) ? -40 : 40 });
    return true;
  }
  private clearSearch(): void { this.searching = false; this.input.value = ""; this.bar.hidden = true; this.filter(); }
  private filter(): void {
    const query = this.input.value.trim().toLowerCase();
    const rows = Array.from(this.dialog.querySelectorAll<HTMLTableRowElement>("table tr"));
    rows.forEach(row => { row.hidden = !!query && !row.querySelector("th") && !row.textContent!.toLowerCase().includes(query); });
    rows.forEach((row, i) => {
      if (row.querySelector("th")) {
        const next = rows.slice(i + 1).findIndex(r => !!r.querySelector("th"));
        const group = rows.slice(i + 1, next < 0 ? undefined : i + 1 + next);
        row.hidden = !!query && !group.some(r => !r.hidden);
      }
    });
  }
}

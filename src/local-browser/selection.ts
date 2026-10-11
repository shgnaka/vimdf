/** Selection shared by directory listings and the virtual registered-folder list. */
export class NameSelection<T extends { name: string }> {
  private source: readonly T[] = [];
  private visible: readonly T[] = [];
  filter = "";
  selectedIndex = -1;

  get entries(): readonly T[] { return this.visible; }

  replace(entries: readonly T[], filter = this.filter): void {
    this.source = Object.freeze([...entries]);
    this.setFilter(filter);
  }

  setFilter(text: string): void {
    this.filter = text;
    const needle = text.toLowerCase();
    this.visible = Object.freeze(this.source.filter(entry => entry.name.toLowerCase().includes(needle)));
    this.select(0);
  }

  select(index: number): void {
    this.selectedIndex = this.visible.length === 0
      ? -1 : Math.max(0, Math.min(index, this.visible.length - 1));
  }

  key(key: string): boolean {
    switch (key) {
      case "j": case "ArrowDown": this.select(this.selectedIndex + 1); return true;
      case "k": case "ArrowUp": this.select(this.selectedIndex - 1); return true;
      case "gg": this.select(0); return true;
      case "G": this.select(this.visible.length - 1); return true;
      default: return false;
    }
  }
}

/** Compare Unicode code points without depending on the browser's locale. */
export function compareNames(a: string, b: string): number {
  const left = Array.from(a), right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

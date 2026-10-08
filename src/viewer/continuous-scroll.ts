/** One time-based animation for both keyboard taps and holds. */
const STEP_DURATION_MS = 160;
const MAX_FRAME_MS = 50;
export type Axis = "x" | "y";

export class ContinuousScroll {
  private rafId: number | null = null;
  private key: string | null = null;
  private held = false;
  private axis: Axis = "y";
  private direction: 1 | -1 = 1;
  private speed = 0;
  private remaining = 0;
  private lastTs = 0;

  constructor(private container: HTMLElement) {}

  press(key: string, axis: Axis, direction: 1 | -1, step: number, repeat = false): void {
    // Repeats never create a gesture, including after blur or reaching an edge.
    if (repeat) return;
    if (!Number.isFinite(step) || step <= 0) return;
    const same = this.isActive() && this.key === key && this.axis === axis && this.direction === direction;
    if (!same) this.stop();
    this.key = key;
    this.axis = axis;
    this.direction = direction;
    this.speed = step / STEP_DURATION_MS;
    this.remaining += step;
    this.held = true;
    if (this.rafId === null) {
      this.lastTs = performance.now();
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  release(key: string): void {
    if (key !== this.key) return;
    this.held = false;
    if (this.remaining <= 1e-7) this.stop();
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.key = null;
    this.held = false;
    this.remaining = 0;
  }

  isActive(): boolean { return this.rafId !== null; }

  private tick = (now: number): void => {
    this.rafId = null;
    const dt = Math.min(MAX_FRAME_MS, Math.max(0, now - this.lastTs));
    this.lastTs = now;
    const amount = this.held ? this.speed * dt : Math.min(this.remaining, this.speed * dt);
    if (amount > 0) {
      const before = this.axis === "y" ? this.container.scrollTop : this.container.scrollLeft;
      if (this.axis === "y") this.container.scrollTop = before + this.direction * amount;
      else this.container.scrollLeft = before + this.direction * amount;
      const after = this.axis === "y" ? this.container.scrollTop : this.container.scrollLeft;
      if (after === before) { this.stop(); return; }
      this.remaining = Math.max(0, this.remaining - Math.abs(after - before));
    }
    if (!this.held && this.remaining <= 1e-7) { this.stop(); return; }
    this.rafId = requestAnimationFrame(this.tick);
  };
}

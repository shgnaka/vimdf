import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuousScroll } from '../src/viewer/continuous-scroll.ts';

function fixture(t, hz = 60) {
  let now = 0, nextId = 0;
  const frames = new Map();
  t.mock.method(performance, 'now', () => now);
  const raf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const caf = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  globalThis.requestAnimationFrame = fn => { frames.set(++nextId, fn); return nextId; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  t.after(() => {
    for (const [name, descriptor] of [['requestAnimationFrame', raf], ['cancelAnimationFrame', caf]]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  let top = 500, left = 500;
  const container = {
    get scrollTop() { return top; }, set scrollTop(v) { top = Math.max(0, Math.min(10000, v)); },
    get scrollLeft() { return left; }, set scrollLeft(v) { left = Math.max(0, Math.min(10000, v)); },
    scrollBy() { assert.fail('keyboard animation must not use native scrollBy'); },
  };
  const scroller = new ContinuousScroll(container);
  const frame = dt => {
    now += dt;
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(fn => fn(now));
    assert.ok(frames.size <= 1, 'only one animation loop');
  };
  const advance = duration => {
    const end = now + duration;
    while (now < end - 1e-8) frame(Math.min(1000 / hz, end - now));
  };
  return { scroller, container, frames, frame, advance };
}
const near = (actual, expected, tolerance = 0.01) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ~= ${expected}`);

test('released vertical and horizontal taps finish exactly one configured step', t => {
  const f = fixture(t);
  f.scroller.press('j', 'y', 1, 100); f.advance(32); f.scroller.release('j'); f.advance(300);
  near(f.container.scrollTop, 600); assert.equal(f.frames.size, 0);
  f.scroller.press('h', 'x', -1, 80); f.advance(32); f.scroller.release('h'); f.advance(300);
  near(f.container.scrollLeft, 420); assert.equal(f.scroller.isActive(), false);
});
test('hold continues before the first OS repeat with no pause at the step boundary', t => {
  const f = fixture(t);
  f.scroller.press('j', 'y', 1, 100); f.advance(144);
  const before = f.container.scrollTop;
  f.advance(32); near(f.container.scrollTop - before, 20);
  f.advance(304); near(f.container.scrollTop, 800);
});
test('repeated keydowns neither add steps nor accelerate or restart motion', t => {
  const f = fixture(t); f.scroller.press('j', 'y', 1, 100);
  for (let i = 0; i < 10; i++) { f.advance(48); f.scroller.press('j', 'y', 1, 100, true); }
  near(f.container.scrollTop, 800);
  f.scroller.release('j'); const pos = f.container.scrollTop; f.advance(300);
  near(f.container.scrollTop, pos); assert.equal(f.frames.size, 0);
});
test('distinct rapid taps preserve each full step', t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) {
    f.scroller.press('j', 'y', 1, 100); f.advance(24); f.scroller.release('j'); f.advance(24);
  }
  f.advance(600); near(f.container.scrollTop, 800); assert.equal(f.frames.size, 0);
});
test('direction change replaces old motion; old key release cannot stop new key', t => {
  const f = fixture(t); f.scroller.press('j', 'y', 1, 100); f.advance(320);
  const pos = f.container.scrollTop;
  f.scroller.press('k', 'y', -1, 100); f.scroller.release('j'); f.advance(320);
  near(f.container.scrollTop, pos - 200);
});
test('axis change stops old axis and uses horizontal step speed', t => {
  const f = fixture(t); f.scroller.press('j', 'y', 1, 100); f.advance(320);
  const top = f.container.scrollTop;
  f.scroller.press('l', 'x', 1, 80); f.scroller.release('j'); f.advance(320);
  near(f.container.scrollTop, top); near(f.container.scrollLeft, 660);
});
test('force-stop cancels even unfinished tap and later gestures still work', t => {
  const f = fixture(t); f.scroller.press('j', 'y', 1, 100); f.advance(32);
  f.scroller.stop(); const pos = f.container.scrollTop; f.advance(300);
  near(f.container.scrollTop, pos); assert.equal(f.frames.size, 0);
  f.scroller.press('j', 'y', 1, 100); f.scroller.release('j'); f.advance(300);
  near(f.container.scrollTop, pos + 100);
});
test('document edge cancels loop and opposite direction remains usable', t => {
  const f = fixture(t); f.container.scrollTop = 9990;
  f.scroller.press('j', 'y', 1, 100); f.advance(320);
  near(f.container.scrollTop, 10000); assert.equal(f.frames.size, 0);
  f.scroller.press('k', 'y', -1, 100); f.scroller.release('k'); f.advance(300);
  near(f.container.scrollTop, 9900);
});
for (const hz of [30, 60, 120]) test(`hold distance is time-based at ${hz}Hz`, t => {
  const f = fixture(t, hz); f.scroller.press('j', 'y', 1, 100); f.advance(480);
  near(f.container.scrollTop, 800, 2);
});
test('stalled frame cannot jump more than 50ms of base movement', t => {
  const f = fixture(t); f.scroller.press('j', 'y', 1, 100); f.advance(32);
  const before = f.container.scrollTop; f.frame(1000);
  near(f.container.scrollTop - before, 31.25); f.advance(16);
  near(f.container.scrollTop - before, 41.25);
});

test('late repeats after force-stop or reaching an edge cannot restart scrolling', t => {
  const f = fixture(t);
  f.scroller.press('j', 'y', 1, 100); f.advance(32); f.scroller.stop();
  const before = f.container.scrollTop;
  f.scroller.press('j', 'y', 1, 100, true); f.advance(300);
  near(f.container.scrollTop, before); assert.equal(f.frames.size, 0);
  f.container.scrollTop = 10000;
  f.scroller.press('j', 'y', 1, 100); f.advance(32);
  f.scroller.press('j', 'y', 1, 100, true);
  assert.equal(f.frames.size, 0);
});
test('zero elapsed frames do not invent movement; invalid steps schedule nothing', t => {
  const f = fixture(t);
  for (const step of [0, -1, NaN, Infinity]) f.scroller.press('j', 'y', 1, step);
  assert.equal(f.frames.size, 0);
  f.scroller.press('j', 'y', 1, 100); f.frame(0); near(f.container.scrollTop, 500);
  f.scroller.release('j'); f.advance(300); near(f.container.scrollTop, 600);
});

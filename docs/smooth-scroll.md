# Smooth keyboard scrolling requirements

## Scope and acceptance criteria

Unify normal-mode j/k/h/l taps and holds in ContinuousScroll. Do not change wheel/touch scrolling, PDF rendering, outline/help scrolling, page jumps, or Ctrl-d/u/f/b in this change. This is a test-first specification; production implementation is intentionally absent.

1. Every initial keydown starts the same requestAnimationFrame animator. Never use browser-native smooth scrolling for these keys.
2. A tap released before its step completes still finishes exactly the configured step (default vertical 100px, horizontal 80px), except when clamped by a document edge. Target step duration is 160ms. Use a constant base speed step/160 px/ms so the tap-to-hold boundary has no velocity reset.
3. While the key remains held, continue at the same base speed beyond the first step, even before the OS emits its first repeated keydown. A hold therefore intentionally travels farther than one step during the repeat delay. This explicit tradeoff eliminates the pause; it is not a byte-for-byte reproduction of Vimium-C.
4. Repeated keydowns are keep-alive input, not additional distance or acceleration. No 600-to-3000px/s ramp. Speed is determined by that axis's configured step.
5. Releasing a hold after its first step cancels further movement immediately. Releasing a tap lets only its remaining step finish. A second distinct tap adds one configured step to the unfinished distance, without discarding movement or restarting an animation loop.
6. A fresh keydown in a different direction or axis replaces the current gesture immediately, without a delayed movement from the old gesture. Releasing an older key must not stop the newer gesture.
7. Force-stop on window blur, hidden document, leaving normal mode, or focusing an editable control; cancel unfinished tap distance too. The controller must wire these events and use release(key) for keyup.
8. At an edge, stop scheduling frames when no progress is possible. A fresh opposite-direction press must work normally.
9. Integrate elapsed time rather than frame count. At 30/60/120Hz, the same hold duration must yield the same distance within 2px. Clamp an individual frame's elapsed time to 50ms to prevent a large jump after a stalled frame; deliberately do not catch up lost time.

## Proposed internal contract

Keep the exported ContinuousScroll class in src/viewer/continuous-scroll.ts. Add press(key, axis, direction, step, repeat = false) and release(key). Retain stop() and isActive(). The controller sends every j/k/h/l keydown through press and keyup through release; it must not call viewer.scrollBy for these keys. Retire start() once the controller is migrated. A single frame loop owns all displacement.

## Verification

Run `node --experimental-transform-types --test tests/continuous-scroll.test.mjs` with Node 22.18+ (the flag transforms TypeScript parameter properties). Virtual time and a clamped scroll container make distance, cancellation and frame scheduling deterministic. Tests are expected to fail against the existing implementation because press/release do not exist yet. Before accepting the later implementation, also run existing password tests and typecheck, then manually check controller wiring in a browser: quick tap, hold before repeat, repeated tap, j-to-k, j-to-l, blur, hidden tab, search/input focus, document edges. The unit tests verify the scrolling engine; event wiring and perceived smoothness still require that browser check.

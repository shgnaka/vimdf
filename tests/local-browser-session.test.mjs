import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contract, file, directory, registryFixture, sessionFixture, press, methods, deferred,
} from './helpers/local-browser-fixtures.mjs';

test('startup opens the saved primary at its root', async () => {
  const f = await sessionFixture({ primaryId: 'r-b' });
  assert.equal(f.session.view, 'browse');
  assert.equal(f.session.activeRootId, 'r-b');
  assert.deepEqual(f.session.entries.map(entry => entry.name), ['novels', 'x.pdf']);
  assert.equal(f.session.selectedIndex, 0);
});

test('startup without registrations stays empty when the initial folder choice is cancelled', async () => {
  const f = registryFixture();
  const session = new (contract().LocalBrowserSession)({ registry: f.registry, openPdf: async () => assert.fail('no PDF') });
  await session.start();
  assert.equal(session.view, 'empty');
  assert.equal(session.selectedIndex, -1);
  await press(session, 'Enter');
  assert.equal(session.view, 'empty');
  assert.equal(f.registry.primaryId, null);
});

test('h navigates to a parent within the root and then to the registered-folder list', async () => {
  const f = await sessionFixture();
  await press(f.session, 'Enter');
  assert.deepEqual(f.session.entries.map(entry => entry.name), ['lesson.pdf']);
  await press(f.session, 'h');
  assert.equal(f.session.view, 'browse');
  assert.equal(f.session.entries[0].name, 'course');
  await press(f.session, 'h');
  assert.equal(f.session.view, 'roots');
  assert.deepEqual(f.session.entries.map(entry => entry.id), ['r-a', 'r-b']);
  assert.equal(f.session.entries[0].isPrimary, true);
  assert.equal(f.session.entries[1].isPrimary, false);
  await press(f.session, 'h');
  assert.equal(f.session.view, 'roots');
  assert.equal(f.registry.primaryId, 'r-a');
});

test('root selection clamps at endpoints and never changes primary until activation', async () => {
  const f = await sessionFixture(); await press(f.session, 'h');
  await press(f.session, 'k');
  assert.equal(f.session.selectedIndex, 0);
  await press(f.session, 'j'); await press(f.session, 'j');
  assert.equal(f.session.selectedIndex, 1);
  assert.equal(f.registry.primaryId, 'r-a');
  assert.equal(f.saved().primaryId, 'r-a');
});

test('gg is recognized as two key events and G selects the last registration', async () => {
  const f = await sessionFixture(); await press(f.session, 'h');
  await press(f.session, 'G'); await press(f.session, 'g');
  assert.equal(f.session.selectedIndex, 1);
  await press(f.session, 'g');
  assert.equal(f.session.selectedIndex, 0);
  await press(f.session, 'G');
  assert.equal(f.session.selectedIndex, 1);
});

test('an intervening command cancels pending g and a repeated keydown cannot complete gg', async () => {
  const f = await sessionFixture(); await press(f.session, 'h');
  await press(f.session, 'G'); await press(f.session, 'g');
  await press(f.session, 'g', { repeat: true });
  assert.equal(f.session.selectedIndex, 1);
  await press(f.session, 'j'); await press(f.session, 'g');
  assert.equal(f.session.selectedIndex, 1);
  await press(f.session, 'g');
  assert.equal(f.session.selectedIndex, 0);
});

test('Enter switches, saves and opens the selected registration', async () => {
  const f = await sessionFixture(); await press(f.session, 'h');
  await press(f.session, 'j'); await press(f.session, 'Enter');
  assert.equal(f.session.view, 'browse');
  assert.equal(f.session.activeRootId, 'r-b');
  assert.equal(f.registry.primaryId, 'r-b');
  assert.equal(f.saved().primaryId, 'r-b');
  assert.deepEqual(f.session.entries.map(entry => entry.name), ['novels', 'x.pdf']);
});

test('l activates a registration in the same way as Enter', async () => {
  const f = await sessionFixture(); await press(f.session, 'h');
  await press(f.session, 'j'); await press(f.session, 'l');
  assert.equal(f.session.activeRootId, 'r-b');
  assert.equal(f.saved().primaryId, 'r-b');
});

test('the chooser selects the current primary and arrow keys move without saving', async () => {
  const f = await sessionFixture({ primaryId: 'r-b' });
  await press(f.session, 'h');
  assert.equal(f.session.selectedIndex, 1);
  await press(f.session, 'ArrowUp');
  assert.equal(f.session.selectedIndex, 0);
  await press(f.session, 'ArrowDown');
  assert.equal(f.session.selectedIndex, 1);
  assert.equal(f.ioCalls.filter(call => call.method === 'save').length, 0);
});

test('switching from a filtered chooser resets the new directory filter and selection', async () => {
  const f = await sessionFixture(); await press(f.session, 'h');
  f.session.setFilter('Books');
  await press(f.session, 'Enter');
  assert.equal(f.session.filter, '');
  assert.equal(f.session.inputMode, 'normal');
  assert.equal(f.session.selectedIndex, 0);
  assert.deepEqual(f.session.entries.map(entry => entry.name), ['novels', 'x.pdf']);
});

test('repeated activation keydowns do not switch primary or launch permission requests', async () => {
  const b = directory('Books', [], { permission: 'prompt' });
  const f = await sessionFixture({ b }); await press(f.session, 'h');
  await press(f.session, 'j');
  await press(f.session, 'Enter', { repeat: true });
  await press(f.session, 'l', { repeat: true });
  assert.equal(f.session.view, 'roots');
  assert.equal(f.saved().primaryId, 'r-a');
  await press(f.session, 'Enter');
  await press(f.session, 'Enter', { repeat: true });
  assert.equal(f.session.view, 'permission');
  assert.equal(methods(b, 'requestPermission').length, 0);
});

test('startup after a switch uses the new primary root rather than the last subdirectory', async () => {
  const f = await sessionFixture(); await press(f.session, 'h');
  await press(f.session, 'j'); await press(f.session, 'Enter');
  await press(f.session, 'Enter');
  assert.deepEqual(f.session.entries.map(entry => entry.name), ['book.pdf']);
  // A new registry instance is required: this verifies persistence, not just shared memory.
  const access = registryFixture(f.saved());
  const restarted = new (contract().LocalBrowserSession)({ registry: access.registry, openPdf: async () => {} });
  await restarted.start();
  assert.equal(restarted.activeRootId, 'r-b');
  assert.deepEqual(restarted.entries.map(entry => entry.name), ['novels', 'x.pdf']);
});

test('Esc cancels the root chooser and restores the previous selection and filter', async () => {
  const f = await sessionFixture();
  f.session.setFilter('.pdf'); await press(f.session, 'j');
  assert.equal(f.session.selectedIndex, 1);
  await press(f.session, 'h'); await press(f.session, 'j');
  await press(f.session, 'Escape');
  assert.equal(f.session.view, 'browse');
  assert.equal(f.session.filter, '.pdf');
  assert.equal(f.session.selectedIndex, 1);
  assert.equal(f.session.activeRootId, 'r-a');
  assert.equal(f.saved().primaryId, 'r-a');
});

test('registered-folder filtering is a case-insensitive partial match', async () => {
  const f = await sessionFixture(); await press(f.session, 'h');
  f.session.setFilter('BOOK');
  assert.deepEqual(f.session.entries.map(entry => entry.id), ['r-b']);
  assert.equal(f.session.selectedIndex, 0);
  f.session.setFilter('missing');
  assert.equal(f.session.selectedIndex, -1);
  await press(f.session, 'Enter');
  assert.equal(f.session.view, 'roots');
  assert.equal(f.saved().primaryId, 'r-a');
});

test('filter input leaves navigation letters to the text input instead of executing commands', async () => {
  const f = await sessionFixture(); await press(f.session, 'h');
  await press(f.session, '/');
  assert.equal(f.session.inputMode, 'filter');
  for (const key of ['j', 'k', 'h', 'l', 'g', 'G']) {
    assert.equal(await press(f.session, key), false);
    assert.equal(f.session.view, 'roots');
    assert.equal(f.session.selectedIndex, 0);
  }
  // The DOM input event supplies the actual text, including IME composition.
  f.session.setFilter('Books');
  assert.deepEqual(f.session.entries.map(entry => entry.id), ['r-b']);
  assert.equal(f.saved().primaryId, 'r-a');
});

test('Enter in filter mode exits input without opening a PDF or changing primary', async () => {
  const f = await sessionFixture();
  await press(f.session, '/'); f.session.setFilter('a.pdf');
  await press(f.session, 'Enter');
  assert.equal(f.session.inputMode, 'normal');
  assert.equal(f.calls.length, 0);
  await press(f.session, 'Enter');
  assert.equal(f.calls.length, 1);
  await press(f.session, 'h'); await press(f.session, '/');
  f.session.setFilter('Books');
  await press(f.session, 'Enter');
  assert.equal(f.session.view, 'roots');
  assert.equal(f.saved().primaryId, 'r-a');
  await press(f.session, 'Enter');
  assert.equal(f.saved().primaryId, 'r-b');
});

test('Esc first clears filtering and then cancels the root chooser', async () => {
  const f = await sessionFixture(); await press(f.session, 'h');
  await press(f.session, '/'); f.session.setFilter('Books');
  await press(f.session, 'Escape');
  assert.equal(f.session.inputMode, 'normal');
  assert.equal(f.session.filter, '');
  assert.equal(f.session.entries.length, 2);
  assert.equal(f.session.view, 'roots');
  await press(f.session, 'Escape');
  assert.equal(f.session.view, 'browse');
  assert.equal(f.saved().primaryId, 'r-a');
});

test('modifier shortcuts and composing key events never invoke navigation or activation', async () => {
  const f = await sessionFixture(); await press(f.session, 'h');
  for (const options of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    assert.equal(await press(f.session, 'Enter', options), false);
    assert.equal(f.session.view, 'roots');
    assert.equal(f.saved().primaryId, 'r-a');
  }
  await press(f.session, '/');
  assert.equal(await press(f.session, 'Enter', { isComposing: true }), false);
  assert.equal(f.session.inputMode, 'filter');
});

test('an ungranted folder opens the permission view without changing primary or enumerating it', async () => {
  const b = directory('Books', [file('x.pdf')], { permission: 'prompt' });
  const f = await sessionFixture({ b }); await press(f.session, 'h');
  await press(f.session, 'j'); await press(f.session, 'Enter');
  assert.equal(f.session.view, 'permission');
  assert.equal(f.session.pendingRootId, 'r-b');
  assert.equal(f.saved().primaryId, 'r-a');
  assert.equal(methods(b, 'requestPermission').length, 0);
  assert.equal(methods(b, 'values').length, 0);
});

test('explicit permission confirmation opens and saves the new primary only after grant', async () => {
  const b = directory('Books', [file('x.pdf')], { permission: 'prompt', requestedPermission: 'granted' });
  const f = await sessionFixture({ b }); await press(f.session, 'h');
  await press(f.session, 'j'); await press(f.session, 'Enter');
  await press(f.session, 'Enter');
  assert.equal(f.session.view, 'browse');
  assert.equal(f.session.activeRootId, 'r-b');
  assert.equal(f.saved().primaryId, 'r-b');
  assert.deepEqual(methods(b, 'requestPermission')[0].options, { mode: 'read' });
});

test('denied permission stays pending and Esc returns to the chooser without changing primary', async () => {
  const b = directory('Books', [], { permission: 'denied' });
  const f = await sessionFixture({ b }); await press(f.session, 'h');
  await press(f.session, 'j'); await press(f.session, 'Enter');
  await press(f.session, 'Enter');
  assert.equal(f.session.view, 'permission');
  assert.equal(f.saved().primaryId, 'r-a');
  await press(f.session, 'Escape');
  assert.equal(f.session.view, 'roots');
  assert.equal(f.saved().primaryId, 'r-a');
  assert.equal(methods(b, 'values').length, 0);
});

test('startup with a revoked primary asks for explicit permission without selecting another root', async () => {
  const a = directory('University', [], { permission: 'prompt' });
  const f = await sessionFixture({ a });
  assert.equal(f.session.view, 'permission');
  assert.equal(f.session.pendingRootId, 'r-a');
  assert.equal(f.saved().primaryId, 'r-a');
  assert.equal(methods(a, 'requestPermission').length, 0);
  assert.equal(methods(a, 'values').length, 0);
  await press(f.session, 'Escape');
  assert.equal(f.session.view, 'roots');
});

test('a failed save keeps the chooser and primary unchanged so the switch can be retried', async () => {
  const f = await sessionFixture(); await press(f.session, 'h'); await press(f.session, 'j');
  f.failSave(new Error('database unavailable'));
  await assert.rejects(press(f.session, 'Enter'), /database unavailable/);
  assert.equal(f.session.view, 'roots');
  assert.equal(f.session.selectedIndex, 1);
  assert.equal(f.session.activeRootId, 'r-a');
  assert.equal(f.saved().primaryId, 'r-a');
  assert.equal(f.session.busy, false);
  f.failSave(null);
  await press(f.session, 'Enter');
  assert.equal(f.session.activeRootId, 'r-b');
});

test('primary switches never change the identity of a PDF opened again in its original root', async () => {
  const a = directory('University', [file('same.pdf')]);
  const b = directory('Books', [file('same.pdf')]);
  const f = await sessionFixture({ a, b });
  await press(f.session, 'Enter');
  await press(f.session, 'h'); await press(f.session, 'j'); await press(f.session, 'Enter');
  await press(f.session, 'Enter');
  await press(f.session, 'h'); await press(f.session, 'k'); await press(f.session, 'Enter');
  await press(f.session, 'Enter');
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0][1], f.calls[2][1]);
  assert.notEqual(f.calls[0][1], f.calls[1][1]);
});

test('a adds another registration but leaves primary unchanged until Enter activates it', async () => {
  const f = await sessionFixture(); await press(f.session, 'h');
  f.choose(directory('Work', [file('work.pdf')]));
  await press(f.session, 'a');
  assert.equal(f.session.view, 'roots');
  assert.equal(f.registry.roots.length, 3);
  assert.equal(f.session.entries[f.session.selectedIndex].name, 'Work');
  assert.equal(f.saved().primaryId, 'r-a');
  await press(f.session, 'Enter');
  assert.equal(f.session.activeRootId, 'root-1');
  assert.equal(f.saved().primaryId, 'root-1');
});

test('the initial folder choice becomes primary and opens immediately', async () => {
  const f = registryFixture();
  const session = new (contract().LocalBrowserSession)({ registry: f.registry, openPdf: async () => {} });
  await session.start();
  f.choose(directory('University', [file('lesson.pdf')]));
  await press(session, 'Enter');
  assert.equal(session.view, 'browse');
  assert.equal(session.activeRootId, 'root-1');
  assert.equal(f.saved().primaryId, 'root-1');
});

test('cancelling an additional folder choice preserves chooser selection and primary', async () => {
  const f = await sessionFixture(); await press(f.session, 'h');
  await press(f.session, 'j');
  await press(f.session, 'a');
  assert.equal(f.session.view, 'roots');
  assert.equal(f.session.selectedIndex, 1);
  assert.equal(f.session.entries.length, 2);
  assert.equal(f.saved().primaryId, 'r-a');
  assert.equal(f.session.busy, false);
});

test('busy activation consumes further navigation without issuing duplicate persistence operations', { timeout: 1000 }, async () => {
  const saveStarted = deferred(), releaseSave = deferred();
  const f = await sessionFixture({
    saveHook: async () => { saveStarted.resolve(); await releaseSave.promise; },
  });
  await press(f.session, 'h'); await press(f.session, 'j');
  const switching = press(f.session, 'Enter');
  await Promise.race([
    saveStarted.promise,
    switching.then(() => assert.fail('activation ended before persistence started')),
  ]);
  assert.equal(f.session.busy, true);
  try {
    assert.equal(await press(f.session, 'Enter'), true);
    assert.equal(await press(f.session, 'k'), true);
    assert.equal(f.ioCalls.filter(call => call.method === 'save').length, 1);
    assert.equal(f.saved().primaryId, 'r-a');
    assert.equal(f.registry.primaryId, 'r-a');
    assert.equal(f.calls.length, 0);
  } finally {
    releaseSave.resolve();
    await switching;
  }
  assert.equal(f.session.busy, false);
  assert.equal(f.saved().primaryId, 'r-b');
  assert.equal(f.ioCalls.filter(call => call.method === 'save').length, 1);
});

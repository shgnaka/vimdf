import test from 'node:test';
import assert from 'node:assert/strict';
import { implementation, pdfFixture, deferred, settled } from './helpers/local-integration.mjs';

const identity = 'https://local-pdf.vimdf.invalid/root-a/course/lesson.pdf';
const otherIdentity = 'https://local-pdf.vimdf.invalid/root-b/course/lesson.pdf';
async function fixture(t) {
  const create = await implementation('src/local-browser/pdf-controller.ts', 'createLocalPdfController');
  const f = pdfFixture(); const controller = create(f.options); t.after(() => controller.dispose());
  return { ...f, controller };
}
const pdf = () => new File(['%PDF-1.7\nfixture bytes'], 'lesson.pdf', { type: 'application/pdf' });

test('[PDF-01] File bytes and the exact model identity reach the shared runtime without fetching a URL', async t => {
  const f = await fixture(t); t.mock.method(globalThis, 'fetch', () => assert.fail('identity is not a fetch URL'));
  const file = pdf(); const bytes = await file.arrayBuffer(); await f.controller.openPdf(file, identity);
  const load = f.calls.find(c => c.method === 'load');
  assert.deepEqual(Object.keys(load.source).sort(), ['data', 'identity']);
  assert.ok(load.source.data instanceof ArrayBuffer); assert.deepEqual(load.source.data, bytes);
  assert.equal(load.source.identity, identity); assert.equal(f.controller.mode, 'pdf');
});

test('[PDF-02] same filename in different registered roots preserves distinct identities', async t => {
  const f = await fixture(t);
  for (const id of [identity, otherIdentity, identity]) await f.controller.openPdf(pdf(), id);
  assert.deepEqual(f.calls.filter(c => c.method === 'load').map(c => c.source.identity), [identity, otherIdentity, identity]);
});

test('[PDF-04] old page and scroll are captured before asynchronous save while switching documents', async t => {
  const f = await fixture(t); await f.controller.openPdf(pdf(), identity);
  f.show({ identity, page: 8, scroll: 321 }); const gate = deferred(); f.holdSave(() => gate.promise);
  const switching = f.controller.openPdf(pdf(), otherIdentity); await settled();
  try {
    assert.deepEqual(f.calls.filter(c => c.method === 'save').at(-1).snapshot, { identity, page: 8, scroll: 321 });
    assert.equal(f.calls.filter(c => c.method === 'load').length, 1, 'flush before exchanging the PDF');
    f.show({ identity: otherIdentity, page: 2, scroll: 0 });
  } finally { gate.resolve(); await switching; }
  assert.deepEqual(f.calls.filter(c => c.method === 'save').at(-1).snapshot, { identity, page: 8, scroll: 321 });
});

test('[UI-06] return to files suspends PDF keys and forward resumes only the retained document', async t => {
  const f = await fixture(t); await f.controller.openPdf(pdf(), identity);
  const token = f.controller.documentToken;
  await f.controller.back(); assert.equal(f.controller.mode, 'files');
  assert.equal(f.calls.at(-1).mode, 'files'); assert.ok(f.calls.some(c => c.method === 'suspend'));
  assert.equal(await f.controller.forward(token), true); assert.equal(f.controller.mode, 'pdf');
  assert.equal(f.calls.filter(c => c.method === 'load').length, 1, 'forward must reuse loaded bytes');
});

test('[UI-06] history stores only view and opaque token, not File, bytes, handles or identity', async t => {
  const f = await fixture(t); await f.controller.openPdf(pdf(), identity);
  assert.equal(f.history.length, 1); assert.deepEqual(Object.keys(f.history[0].value).sort(), ['token', 'view']);
  assert.equal(f.history[0].value.view, 'pdf'); assert.equal(f.history[0].value.token, f.controller.documentToken);
  assert.equal(JSON.stringify(f.history).includes(identity), false);
});

test('[PDF-01] a failed File read preserves files mode and does not create PDF history', async t => {
  const f = await fixture(t); const file = pdf();
  file.arrayBuffer = async () => { throw new DOMException('removed', 'NotFoundError'); };
  await assert.rejects(f.controller.openPdf(file, identity), { name: 'NotFoundError' });
  assert.equal(f.controller.mode, 'files'); assert.equal(f.history.length, 0);
  assert.equal(f.calls.filter(c => c.method === 'load').length, 0);
});

test('[PDF-03] password or load cancellation does not commit history or a successful PDF mode', async t => {
  const f = await fixture(t);
  f.holdLoad(() => { throw new DOMException('password cancelled', 'AbortError'); });
  await assert.rejects(f.controller.openPdf(pdf(), identity), { name: 'AbortError' });
  assert.equal(f.controller.mode, 'files'); assert.equal(f.history.length, 0);
});

test('[PDF-03] cancelling an outstanding File read ignores its late result', async t => {
  const f = await fixture(t); const gate = deferred(); const file = pdf(); file.arrayBuffer = () => gate.promise;
  const opening = assert.rejects(f.controller.openPdf(file, identity), { name: 'AbortError' });
  assert.equal(f.controller.mode, 'loading-pdf'); f.controller.cancel();
  gate.resolve(await pdf().arrayBuffer()); await opening;
  assert.equal(f.controller.mode, 'files'); assert.equal(f.history.length, 0);
  assert.equal(f.calls.filter(c => c.method === 'load').length, 0);
});

test('[PDF-03] cancelling an outstanding runtime load aborts its signal and ignores completion', async t => {
  const f = await fixture(t); const gate = deferred(); f.holdLoad(() => gate.promise);
  const opening = assert.rejects(f.controller.openPdf(pdf(), identity), { name: 'AbortError' }); await settled();
  const signal = f.calls.find(c => c.method === 'load').signal;
  assert.ok(signal instanceof AbortSignal); f.controller.cancel(); assert.equal(signal.aborted, true);
  gate.resolve(); await opening; assert.equal(f.controller.mode, 'files'); assert.equal(f.history.length, 0);
});

test('[PDF-04] failed replacement preserves the previous retained document and token', async t => {
  const f = await fixture(t); await f.controller.openPdf(pdf(), identity); const token = f.controller.documentToken;
  await f.controller.back(); f.holdLoad(() => { throw new Error('invalid PDF'); });
  await assert.rejects(f.controller.openPdf(pdf(), otherIdentity), /invalid PDF/);
  assert.equal(f.controller.documentToken, token); assert.equal(f.history.length, 1);
  assert.equal(await f.controller.forward(token), true); assert.equal(f.current().identity, identity);
});

test('[UI-06] forward for a replaced document requests re-selection and never fetches its identity', async t => {
  const f = await fixture(t); t.mock.method(globalThis, 'fetch', () => assert.fail('never fetch discarded history'));
  await f.controller.openPdf(pdf(), identity); const old = f.controller.documentToken;
  await f.controller.back(); await f.controller.openPdf(pdf(), otherIdentity); await f.controller.back();
  assert.notEqual(f.controller.documentToken, old); assert.equal(await f.controller.forward(old), false);
  assert.equal(f.controller.mode, 'files'); assert.equal(f.calls.filter(c => c.method === 'load').length, 2);
});

test('[PDF-05] repeated list/PDF navigation resets pending keys and dispose releases runtime once', async t => {
  const f = await fixture(t); await f.controller.openPdf(pdf(), identity); const token = f.controller.documentToken;
  for (let i = 0; i < 3; i++) { await f.controller.back(); await f.controller.forward(token); }
  assert.ok(f.calls.filter(c => c.method === 'resetTransient').length >= 3);
  f.controller.dispose(); f.controller.dispose();
  assert.equal(f.calls.filter(c => c.method === 'dispose').length, 1);
});

test('[PDF-04] overlapping opens are rejected rather than racing a second document into the runtime', async t => {
  const f = await fixture(t); const gate = deferred(); f.holdLoad(() => gate.promise);
  const first = f.controller.openPdf(pdf(), identity); await settled();
  try { await assert.rejects(f.controller.openPdf(pdf(), otherIdentity), /busy|progress|loading/i); }
  finally { gate.resolve(); await first; }
  assert.equal(f.calls.filter(c => c.method === 'load').length, 1); assert.equal(f.history.length, 1);
});

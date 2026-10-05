import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function setup(fetch) {
  const listeners = {};
  const timers = [];
  const content = { inert: false };
  let focusCount = 0;
  const body = { children: [content], append() {}, setAttribute() {}, removeAttribute() {} };
  const document = {
    body, activeElement: { isConnected: true, focus() { focusCount++; } },
    createElement() { return { setAttribute() {}, querySelector() { return {}; }, addEventListener() {}, showModal() {}, close() {}, remove() {} }; }
  };
  function HTMLFormElement() {}
  let submissions = 0;
  HTMLFormElement.prototype.submit = () => { submissions++; };
  const window = { fetch, addEventListener(type, callback) { (listeners[type] ||= []).push(callback); } };
  vm.runInNewContext(fs.readFileSync('src/public/operation-busy.js', 'utf8'), {
    window, document, HTMLFormElement, Request, Response, URL,
    location: { href: 'https://example.com/settings' }, setTimeout(callback) { timers.push(callback); }
  });
  return { window, content, listeners, HTMLFormElement, flush() { timers.splice(0).forEach(callback => callback()); }, get submissions() { return submissions; }, get focusCount() { return focusCount; } };
}

test('AJAX blocks repeated requests and input until body handling, and unlocks on failure', async () => {
  let resolve;
  let calls = 0;
  const app = setup(() => { calls++; return new Promise(done => { resolve = done; }); });
  const pending = app.window.fetch('/save', { method: 'POST' });
  assert.equal(app.content.inert, true);
  await assert.rejects(app.window.fetch('/save', { method: 'POST' }));
  assert.equal(calls, 1);
  let blocked = 0;
  app.listeners.keydown[0]({ preventDefault() { blocked++; }, stopImmediatePropagation() { blocked++; } });
  assert.equal(blocked, 2);
  resolve(new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }));
  assert.deepEqual(await (await pending).json(), { ok: true });
  app.flush();
  assert.equal(app.content.inert, false);
  assert.equal(app.focusCount, 1);
  const failure = setup(async () => { throw new Error('offline'); });
  await assert.rejects(failure.window.fetch('/save'), /offline/);
  failure.flush();
  assert.equal(failure.content.inert, false);
});

test('cancelled and dialog submissions stay usable; normal and direct submissions lock', () => {
  const app = setup(async () => new Response());
  const submit = app.listeners.submit.at(-1);
  submit({ defaultPrevented: true, target: { method: 'post' } });
  submit({ target: { method: 'dialog' } });
  assert.equal(app.content.inert, false);
  const form = new app.HTMLFormElement();
  Object.assign(form, { method: 'post', dataset: {} });
  form.submit(); form.submit();
  assert.equal(app.submissions, 1);
  assert.equal(app.content.inert, true);
  app.listeners.pageshow[0]();
  assert.equal(app.content.inert, false);
  submit({ target: form });
  assert.equal(app.content.inert, true);
});

test('managed multi-step tasks keep one lock and release after errors', async () => {
  let calls = 0;
  const app = setup(async () => { calls++; return new Response(); });
  await assert.rejects(app.window.AppBusy.run(async () => {
    await app.window.fetch('/copy', { method: 'POST' });
    await app.window.fetch('/copy', { method: 'POST' });
    assert.equal(app.content.inert, true);
    assert.equal(await app.window.AppBusy.run(() => { throw new Error('duplicate'); }), undefined);
    throw new Error('failed');
  }), /failed/);
  assert.equal(calls, 2);
  assert.equal(app.content.inert, false);
});

test('background notification polling does not lock the screen', async () => {
  const app = setup(async () => new Response());
  await app.window.fetch('/api/notifications/unread-count');
  assert.equal(app.content.inert, false);
});

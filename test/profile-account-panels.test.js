import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const code = await fs.readFile(new URL('../src/public/profile-account-panels.js', import.meta.url), 'utf8');
function setup(fetchImpl) {
  const successor = { hidden: true, querySelector() { return this.input; }, input: { required: false } };
  const select = { value: 'representative', form: { querySelector() { return successor; } } };
  const containers = Object.fromEntries(['disclosure', 'withdrawals'].map(name => [name, {
    dataset: {}, attributes: {}, innerHTML: '', textContent: '', children: [],
    setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; },
    querySelectorAll() { return name === 'withdrawals' ? [select] : []; },
    append(...children) { this.children.push(...children); }
  }]));
  const listeners = {};
  const document = {
    querySelector(selector) { return containers[/"(.*?)"/.exec(selector)[1]]; },
    addEventListener(type, callback) { listeners[type] = callback; },
    createElement() { return { setAttribute() {}, addEventListener(type, handler) { this[type] = handler; } }; }
  };
  const context = { window: {}, document, fetch: fetchImpl };
  vm.runInNewContext(code, context);
  return { load: context.window.loadProfileAccountPanel, containers, listeners, select, successor };
}
const html = { ok: true, headers: { get: () => 'text/html; charset=utf-8' }, async text() { return '<form>設定内容</form>'; } };

test('account tabs load once inside the panel and initialize household successor selection', async () => {
  const calls = [], f = setup(async (path, options) => { calls.push({ path, options }); return html; });
  await f.load('basic'); assert.equal(calls.length, 0);
  await Promise.all([f.load('withdrawals'), f.load('withdrawals')]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/profile/withdrawals?embedded=1');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(f.containers.withdrawals.innerHTML, '<form>設定内容</form>');
  assert.equal(f.successor.hidden, false); assert.equal(f.successor.input.required, true);
  f.select.value = 'household'; f.select.matches = () => true;
  f.listeners.change({ target: f.select });
  assert.equal(f.successor.hidden, true); assert.equal(f.successor.input.required, false);
  await f.load('withdrawals'); assert.equal(calls.length, 1);
  await f.load('disclosure'); assert.equal(calls[1].path, '/profile/disclosure?embedded=1');
});

test('failed account panel loading offers retry and never marks the panel loaded', async () => {
  let fail = true;
  const f = setup(async () => { if (fail) throw new Error('unavailable'); return html; });
  await f.load('disclosure');
  assert.equal(f.containers.disclosure.dataset.loaded, undefined);
  assert.equal(f.containers.disclosure.dataset.loading, undefined);
  assert.match(f.containers.disclosure.children[0].textContent, /読み込めません/);
  fail = false;
  await f.containers.disclosure.children[1].click();
  assert.equal(f.containers.disclosure.dataset.loaded, 'true');
});

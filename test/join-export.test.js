import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('export dialog separates direct PDF download from printing and cleans up', async () => {
  const script = await readFile('src/public/join-export.js', 'utf8');
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { disabled: false, textContent: '', listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  let removed = false, saved = 0, printed = 0, options;
  const clone = { classList: { add() {} }, querySelectorAll: () => [] };
  const source = { cloneNode: () => clone, querySelector: () => ({ textContent: 'テスト町内会' }) };
  const context = { document: { getElementById: get, querySelector: () => source, createElement: () => ({ append() {}, remove() { removed = true; } }), body: { append() {} }, fonts: { ready: Promise.resolve() } }, window: { print: () => printed++, html2pdf: () => ({ set(value) { options = value; return this; }, from(value) { assert.equal(value, clone); return this; }, save: async () => saved++ }) } };
  vm.runInNewContext(script, context);
  get('join-export-open').listeners.click();
  assert.equal(get('join-export-dialog').open, true);
  await get('join-download').listeners.click();
  assert.equal(saved, 1);
  assert.equal(printed, 0);
  assert.equal(options.filename, 'テスト町内会_加入のご案内.pdf');
  assert.equal(removed, true);
  assert.equal(get('join-download').disabled, false);
  get('join-print').listeners.click();
  assert.equal(printed, 1);
  assert.equal(get('join-export-dialog').open, false);
  context.window.html2pdf = undefined;
  await get('join-download').listeners.click();
  assert.match(get('join-export-status').textContent, /作成できません/);
  assert.equal(get('join-download').disabled, false);
});

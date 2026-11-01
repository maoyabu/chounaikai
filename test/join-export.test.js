import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('preview, PNG download and printing share one image; failures disable output and clean up', async () => {
  const script = await readFile('src/public/join-export.js', 'utf8');
  const elements = new Map();
  const created = [];
  const element = () => ({ style: {}, disabled: false, textContent: '', listeners: {},
    classList: { add() {}, remove() {} },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    showModal() { this.open = true; }, close() { this.open = false; },
    append() {}, remove() { this.removed = true; }, click() { this.clicked = true; },
    decode: async () => {}, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 1000, height: 2000 }) });
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const clone = element();
  const source = { ...element(), cloneNode: () => clone, querySelector: () => ({ textContent: 'テスト町内会' }) };
  let printed = 0, rendered = 0, options;
  const context = {
    document: { getElementById: get, querySelector: () => source,
      createElement: tag => { const el = element(); el.tag = tag; created.push(el); return el; },
      body: element(), fonts: { ready: Promise.resolve() } },
    URL: { createObjectURL: () => 'blob:preview', revokeObjectURL() {} },
    window: { innerWidth: 1200, innerHeight: 900, addEventListener() {}, print: () => printed++,
      html2canvas: async (target, opts) => { assert.equal(target, clone); rendered++; options = opts; return { toBlob: cb => cb({}) }; } }
  };
  vm.runInNewContext(script, context);
  await get('join-export-open').listeners.click();
  assert.equal(rendered, 1);
  assert.equal(options.width, 1000);
  assert.equal(options.height, 2000);
  assert.equal(get('join-export-preview').src, 'blob:preview');
  assert.equal(get('join-export-preview').hidden, false);
  assert.equal(created.find(el => el.className === 'join-image-container').removed, true);
  get('join-download').listeners.click();
  const link = created.find(el => el.tag === 'a');
  assert.equal(link.download, 'テスト町内会_加入のご案内.png');
  assert.equal(link.href, get('join-export-preview').src);
  assert.equal(link.clicked, true);
  get('join-print').listeners.click();
  assert.equal(printed, 1);
  assert.equal(created.find(el => el.className === 'join-print-image').src, link.href);
  assert.equal(get('join-export-dialog').open, false);
  context.window.html2canvas = async () => { throw new Error('render failed'); };
  await get('join-export-open').listeners.click();
  assert.match(get('join-export-status').textContent, /作成できません/);
  assert.equal(get('join-download').disabled, true);
  assert.equal(get('join-print').disabled, true);
  get('join-export-close').listeners.click();
  assert.equal(get('join-export-dialog').open, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync('src/public/danger-fab.js', 'utf8');
function setup(stored = null) {
  const handlers = {}, windowHandlers = {};
  const button = { style: {}, offsetWidth: 230, offsetHeight: 60, classList: { add() {}, remove() {} }, setPointerCapture() {}, getBoundingClientRect() { return { left: parseFloat(this.style.left ?? 200), top: parseFloat(this.style.top ?? 300) }; }, addEventListener(name, fn) { handlers[name] = fn; } };
  const window = { innerWidth: 500, innerHeight: 600, addEventListener(name, fn) { windowHandlers[name] = fn; } };
  const localStorage = { getItem() { return stored; }, setItem(key, value) { stored = value; } };
  vm.runInNewContext(source, { document: { getElementById: () => button }, window, localStorage });
  return { button, handlers, window, windowHandlers, stored: () => stored };
}
test('drag clamps to viewport, persists position, and suppresses opening after drag', () => {
  const s = setup();
  s.handlers.pointerdown({ isPrimary: true, button: 0, pointerId: 1, clientX: 210, clientY: 310 });
  s.handlers.pointermove({ pointerId: 1, clientX: 1000, clientY: -100 });
  s.handlers.pointerup({ pointerId: 1 });
  assert.equal(s.button.style.left, '262px');
  assert.equal(s.button.style.top, '8px');
  let prevented = false;
  s.handlers.click({ detail: 1, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  assert.ok(prevented);
  const restored = setup(s.stored());
  assert.equal(restored.button.style.left, '262px');
  restored.window.innerWidth = 320;
  restored.windowHandlers.resize();
  assert.equal(restored.button.style.left, '82px');
});
test('tap opens normally and keyboard movement is saved despite unavailable storage', () => {
  const s = setup('invalid JSON');
  s.handlers.pointerdown({ isPrimary: true, button: 0, pointerId: 1, clientX: 210, clientY: 310 });
  s.handlers.pointermove({ pointerId: 1, clientX: 212, clientY: 312 });
  s.handlers.pointerup({ pointerId: 1 });
  s.handlers.click({ detail: 1, preventDefault() { assert.fail('tap suppressed'); } });
  s.handlers.keydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(s.button.style.left, '190px');
  assert.ok(s.stored());
});

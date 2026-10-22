import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script = fs.readFileSync('src/public/directory-photo-gallery.js', 'utf8');
function fixture(count, reduced = false) {
  let tick, active = false, finish;
  const handlers = {};
  const children = Array.from({ length: count }, (_, index) => ({ id: index, hidden: index >= 3, querySelector: () => ({}), getBoundingClientRect: () => ({ top: index * 192 }) }));
  const track = { children, get firstElementChild() { return children[0]; }, append(card) { children.splice(children.indexOf(card), 1); children.push(card); }, animate(frames) { this.frames = frames; return { finished: new Promise(resolve => { finish = resolve; }), cancel() {} }; } };
  const gallery = { open: true, querySelector: () => track, contains: () => false, addEventListener(name, fn) { handlers[name] = fn; } };
  vm.runInNewContext(script, { document: { hidden: false, activeElement: null, querySelectorAll: () => [gallery], addEventListener() {} }, window: { matchMedia: () => ({ matches: reduced, addEventListener() {} }), addEventListener() {} }, setInterval(fn) { tick = fn; active = true; return 1; }, clearInterval() { active = false; }, setTimeout(fn) { fn(); } });
  return { track, handlers, get active() { return active; }, advance() { tick(); }, finish() { finish(); } };
}
test('vertical gallery moves upward then cycles the first photo to the end', async () => {
  const state = fixture(5);
  assert.equal(state.active, true);
  state.advance();
  assert.equal(state.track.children.filter(card => !card.hidden).length, 4);
  assert.equal(state.track.frames[1].transform, 'translateY(-192px)');
  state.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(state.track.children.slice(0, 3).map(card => card.id), [1, 2, 3]);
  assert.equal(state.track.children.filter(card => !card.hidden).length, 3);
});
test('short galleries and reduced motion remain static; hover pauses rotation', () => {
  for (const count of [1, 2, 3]) assert.equal(fixture(count).active, false);
  assert.equal(fixture(5, true).active, false);
  const state = fixture(5);
  state.handlers.mouseenter(); assert.equal(state.active, false);
  state.handlers.mouseleave(); assert.equal(state.active, true);
  state.handlers.focusin(); assert.equal(state.active, false);
});

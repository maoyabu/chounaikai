import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script = fs.readFileSync('src/public/directory-photo-gallery.js', 'utf8');
function fixture(count, reduced = false, saved = null, storageBlocked = false) {
  let tick, active = false, finish, delay;
  const storage = new Map([['directory-photo-interval', saved]]);
  const select = { value: '5', addEventListener(_event, fn) { this.change = fn; } };
  const handlers = {};
  const children = Array.from({ length: count }, (_, index) => ({ id: index, hidden: index >= 3, querySelector: () => ({}), getBoundingClientRect: () => ({ top: index * 192 }) }));
  const track = { children, get firstElementChild() { return children[0]; }, append(card) { children.splice(children.indexOf(card), 1); children.push(card); }, animate(frames) { this.frames = frames; return { finished: new Promise(resolve => { finish = resolve; }), cancel() {} }; } };
  const gallery = { querySelector: selector => selector === '.directory-photo-track' ? track : select, contains: () => false, addEventListener(name, fn) { handlers[name] = fn; } };
  vm.runInNewContext(script, { document: { hidden: false, activeElement: null, querySelectorAll: () => [gallery], addEventListener() {} }, window: { localStorage: { getItem(key) { if (storageBlocked) throw Error('blocked'); return storage.get(key); }, setItem(key, value) { if (storageBlocked) throw Error('blocked'); storage.set(key, value); } }, matchMedia: () => ({ matches: reduced, addEventListener() {} }), addEventListener() {} }, setInterval(fn, ms) { delay = ms; tick = fn; active = true; return 1; }, clearInterval() { active = false; }, setTimeout(fn) { fn(); } });
  return { track, handlers, select, storage, get delay() { return delay; }, get active() { return active; }, advance() { tick(); }, finish() { finish(); } };
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

test('interval defaults to five seconds, restores valid preferences and saves changes', () => {
  assert.equal(fixture(5).delay, 5000);
  const state = fixture(5, false, '10');
  assert.equal(state.select.value, '10');
  assert.equal(state.delay, 10000);
  state.select.value = '30'; state.select.change();
  assert.equal(state.delay, 30000);
  assert.equal(state.storage.get('directory-photo-interval'), '30');
  assert.equal(fixture(5, false, 'invalid').delay, 5000);
  assert.equal(fixture(5, false, '0').delay, 5000);
});
test('interval selection works without browser storage and for short galleries', () => {
  const state = fixture(5, false, null, true);
  state.select.value = '3'; assert.doesNotThrow(() => state.select.change());
  assert.equal(state.delay, 3000);
  const short = fixture(2, false, '15');
  assert.equal(short.select.value, '15');
  short.select.value = '10'; short.select.change();
  assert.equal(short.active, false);
  assert.equal(short.storage.get('directory-photo-interval'), '10');
});

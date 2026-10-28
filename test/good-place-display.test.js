import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
test('map and comments toggle independently and restore saved preferences', () => {
  const saved = new Map([['good-place-display:map', 'hidden']]);
  const targets = { map: {}, comments: {} };
  const toggles = ['map', 'comments'].map(name => ({ checked: true, dataset: { goodPlaceDisplay: name }, getAttribute: () => name, addEventListener(event, fn) { this.change = fn; } }));
  vm.runInNewContext(fs.readFileSync('src/public/good-place-display.js', 'utf8'), {
    document: { querySelectorAll: () => toggles, getElementById: id => targets[id] },
    window: { localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) } }
  });
  assert.equal(targets.map.hidden, true); assert.equal(targets.comments.hidden, false);
  toggles[0].checked = true; toggles[0].change();
  assert.equal(targets.map.hidden, false); assert.equal(saved.get('good-place-display:map'), 'visible');
  toggles[1].checked = false; toggles[1].change();
  assert.equal(targets.comments.hidden, true); assert.equal(targets.map.hidden, false);
});

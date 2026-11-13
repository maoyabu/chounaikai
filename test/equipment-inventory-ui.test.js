import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ejs from 'ejs';
const source = await readFile('src/public/equipment-inventory.js', 'utf8');
const element = () => ({ listeners: {}, dataset: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
function setup() {
  const form = element(), item = {}, checkbox = { checked: false }, status = {}, retry = element(), label = { dataset: { inventoryPlaceCount: '倉庫' } };
  const groups = Object.fromEntries(['checked', 'unchecked'].map(name => [name, {
    dataset: { inventoryGroup: name }, count: {},
    querySelectorAll() { return item.parentElement === this ? [item] : []; },
    querySelector() { return this.count; }, append(row) { row.parentElement = this; },
  }]));
  const place = { querySelectorAll: () => Object.values(groups), querySelector: selector => selector === '[name="place"]' ? { value: '倉庫' } : groups[selector.includes('"unchecked"') ? 'unchecked' : 'checked'] };
  item.parentElement = groups.unchecked;
  Object.assign(form, { elements: { checked: checkbox }, dataset: { savedChecked: 'false' }, action: '/inventory/item', reportValidity: () => true,
    closest: selector => selector.includes('data-') ? item : place,
    querySelector: selector => selector.includes('status') ? status : retry,
  });
  const requests = []; let fail = false;
  vm.runInNewContext(source, {
    document: { querySelectorAll: selector => selector.includes('data-inventory-form') ? [form] : selector.includes('place-count') ? [label] : [] },
    URLSearchParams, FormData: class { constructor() { this.checked = checkbox.checked; } *[Symbol.iterator]() { yield ['_csrf', 'token']; if (this.checked) yield ['checked', 'on']; } },
    fetch: async (url, options) => { requests.push(options); return { ok: !fail, json: async () => fail ? { error: '保存失敗' } : { ok: true, checked: options.body.has('checked') } }; },
  });
  return { form, checkbox, item, groups, status, retry, label, requests, fail() { fail = true; }, async settle() { await new Promise(resolve => setImmediate(resolve)); } };
}
test('checkbox autosaves with CSRF and moves in both directions, updating counts', async () => {
  const r = setup();
  r.checkbox.checked = true; r.form.listeners.change(); await r.settle();
  assert.equal(r.requests[0].body.get('_csrf'), 'token');
  assert.equal(r.item.parentElement, r.groups.checked);
  assert.equal(r.label.textContent, '未：0／済：1');
  r.checkbox.checked = false; r.form.listeners.change(); await r.settle();
  assert.equal(r.item.parentElement, r.groups.unchecked);
  assert.equal(r.label.textContent, '未：1／済：0');
});
test('failed save restores saved checkbox and offers retry without moving item', async () => {
  const r = setup(); r.fail();
  r.checkbox.checked = true; r.form.listeners.change(); await r.settle();
  assert.equal(r.checkbox.checked, false);
  assert.equal(r.item.parentElement, r.groups.unchecked);
  assert.equal(r.retry.hidden, false);
  assert.match(r.status.textContent, /未保存：保存失敗/);
});
test('rapid changes persist in order and only latest state moves the row', async () => {
  const r = setup();
  r.checkbox.checked = true; r.form.listeners.change();
  r.checkbox.checked = false; r.form.listeners.change(); await r.settle();
  assert.equal(r.requests.length, 2);
  assert.equal(r.requests[0].body.has('checked'), true);
  assert.equal(r.requests[1].body.has('checked'), false);
  assert.equal(r.item.parentElement, r.groups.unchecked);
});
test('inventory card renders three rows, required quantity and expiry status safely', async () => {
  for (const [expiryDate, expected] of [['2026-11-12', '期限切れ'], ['2026-11-13', '期限内'], ['', 'なし']]) {
    const html = await ejs.renderFile('src/views/partials/equipment-inventory-item.ejs', {
      item: { _id: 'i', name: '水', place: '倉庫', quantity: 5, minimumQuantity: 10, unit: '本', expiryDate, check: { comment: '<test>' } },
      base: '/equipment', period: '2026-11', today: '2026-11-13', csrfToken: 'token',
    });
    assert.match(html, new RegExp(expected));
    assert.match(html, /必要数量 <\/span>10本/);
    assert.match(html, /&lt;test&gt;/);
    assert.doesNotMatch(html, /記録を保存/);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ejs from 'ejs';
const source = await readFile('src/public/record-actions.js', 'utf8');
function setup({ deletable = true } = {}) {
  const element = () => ({ listeners: {}, children: {}, dataset: {}, classList: { add() {} }, open: false,
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    fire(type, event = {}) { this.listeners[type]?.forEach(fn => fn(event)); },
    querySelector(selector) { return this.children[selector] ||= element(); },
    querySelectorAll() { return []; }, setAttribute() {},
    showModal() { this.open = true; }, close() { this.open = false; },
  });
  const row = element(), menu = element(), confirmation = element(), form = element();
  let edits = 0, writes = 0, pending;
  row.querySelector = selector => selector === 'strong' ? { textContent: '行事テスト' } : null;
  row.querySelectorAll = () => deletable ? [form] : [];
  row.dispatchEvent = event => { if (event.type === 'record-edit') edits++; };
  form.getAttribute = () => '/events/one/delete'; form.closest = () => null;
  form.requestSubmit = () => { let prevented = false; form.fire('submit', { preventDefault() { prevented = true; } }); if (!prevented) writes++; };
  const target = { closest: () => null };
  vm.runInNewContext(source, {
    document: { querySelector: selector => selector.includes('record-actions') ? menu : confirmation,
      querySelectorAll: selector => selector.startsWith('.association-event-manage-item,') ? [row] : [] },
    CustomEvent: class { constructor(type) { this.type = type; } },
    setTimeout(fn) { pending = fn; return 1; }, clearTimeout() { pending = undefined; },
  });
  return { row, menu, confirmation, form, target, edits: () => edits, writes: () => writes,
    hold() { const fn = pending; pending = undefined; fn?.(); } };
}
test('short click does not edit; holding opens menu and Edit explicitly opens editor', () => {
  const r = setup();
  r.row.fire('click', { target: r.target }); assert.equal(r.edits(), 0);
  r.row.fire('pointerdown', { isPrimary: true, button: 0, clientX: 0, clientY: 0, target: r.target });
  r.hold(); assert.equal(r.menu.open, true); assert.equal(r.edits(), 0);
  r.menu.querySelector('[data-record-actions-edit]').fire('click');
  assert.equal(r.menu.open, false); assert.equal(r.edits(), 1);
});
test('scrolling, early release, and cancellation prevent the menu', () => {
  for (const type of ['pointermove', 'pointerup', 'pointercancel', 'pointerleave']) {
    const r = setup();
    r.row.fire('pointerdown', { isPrimary: true, button: 0, clientX: 0, clientY: 0, target: r.target });
    r.row.fire(type, { clientX: 30, clientY: 0 }); r.hold();
    assert.equal(r.menu.open, false, type);
  }
});
test('deletion posts only after confirmation; cancel does not post', () => {
  const r = setup();
  const open = () => r.row.fire('keydown', { target: r.row, key: 'Enter', preventDefault() {} });
  open(); r.menu.querySelector('[data-record-actions-delete]').fire('click');
  assert.equal(r.confirmation.open, true); assert.equal(r.writes(), 0);
  r.confirmation.querySelector('[data-record-delete-cancel]').fire('click');
  assert.equal(r.writes(), 0);
  open(); r.menu.querySelector('[data-record-actions-delete]').fire('click');
  r.confirmation.querySelector('[data-record-delete-confirm]').fire('click');
  assert.equal(r.writes(), 1);
});
test('keyboard and right click support editing-only rows without a delete action', () => {
  for (const type of ['keydown', 'contextmenu']) {
    const r = setup({ deletable: false });
    r.row.fire(type, { target: type === 'keydown' ? r.row : r.target, key: 'Enter', preventDefault() {} });
    assert.equal(r.menu.open, true);
    assert.equal(r.menu.querySelector('[data-record-actions-delete]').hidden, true);
  }
});

test('both event lists render edit/delete and report actions with valid client scripts', async () => {
  for (const view of ['association-events-manage', 'association-group-events-manage']) {
    const html = await ejs.renderFile(`src/views/${view}.ejs`, {
      title: '行事管理', currentUser: null, currentPath: '', assetVersion: 'test', csrfToken: 'csrf', notice: '',
      association: { _id: 'town', name: '町内会' }, group: { _id: 'group', association: 'town', name: 'グループ' }, categories: ['行事'],
      events: [{ _id: 'one', title: '防災訓練', category: '行事', startDate: '2026-11-14', completed: true, implementationReport: '実施済み' }],
    });
    assert.match(html, /record-actions\.js/);
    assert.match(html, /data-record-actions-delete/);
    assert.match(html, /data-event-open="edit-event-one"/);
    assert.match(html, /name="_csrf" value="csrf"/);
    assert.doesNotMatch(html, /addEventListener\('click',event=>\{const row=event.target.closest\('\.association-event-manage-item'/);
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  }
});
test('other row editors use explicit menu events and their client scripts parse', async () => {
  for (const view of ['association-members', 'association-officers', 'association-leaders', 'association-annual-settings']) {
    const source = await readFile(`src/views/${view}.ejs`, 'utf8');
    assert.match(source, /addEventListener\('record-edit'/);
    assert.doesNotMatch(source, /(?:row|article)\.addEventListener\('click'/);
    for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      new vm.Script(match[1].replace(/<%[\s\S]*?%>/g, 'null'));
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/public/finance-entry-list.js', import.meta.url), 'utf8');
function setup() {
  const timers = new Map();
  let next = 0;
  const element = (extra = {}) => ({
    listeners: {}, children: {}, open: false,
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    fire(type, event = {}) { this.listeners[type]?.forEach(fn => fn(event)); },
    querySelector(selector) { return this.children[selector] ||= element(); },
    showModal() { this.open = true; }, close() { this.open = false; this.fire('close'); },
    focus() {}, ...extra,
  });
  const row = element({ innerText: '2026年\n4/1\n会議費\n¥1,000', dataset: { editUrl: '/entry/1/edit', deleteUrl: '/entry/1/delete' } });
  const menu = element(), confirmation = element();
  vm.runInNewContext(source, {
    document: { querySelectorAll: () => [row], querySelector: selector => selector.includes('operation') ? menu : confirmation },
    setTimeout(fn) { timers.set(++next, fn); return next; }, clearTimeout(id) { timers.delete(id); },
  });
  return { row, menu, confirmation, hold() { [...timers.values()].forEach(fn => fn()); timers.clear(); } };
}
const down = { isPrimary: true, button: 0, clientX: 0, clientY: 0 };
test('long press opens actions and deletion needs a separate confirmation', () => {
  const { row, menu, confirmation, hold } = setup();
  row.fire('pointerdown', down);
  assert.equal(menu.open, false);
  hold();
  assert.equal(menu.open, true);
  assert.equal(menu.querySelector('[data-finance-operation-edit]').href, '/entry/1/edit');
  assert.equal(confirmation.open, false);
  menu.querySelector('[data-finance-operation-delete]').fire('click');
  assert.equal(menu.open, false);
  assert.equal(confirmation.open, true);
  assert.equal(confirmation.querySelector('[data-finance-delete-form]').action, '/entry/1/delete');
  assert.match(confirmation.querySelector('[data-finance-delete-description]').textContent, /¥1,000/);
  confirmation.querySelector('[data-finance-delete-cancel]').fire('click');
  assert.equal(confirmation.open, false);
});
test('scrolling, releasing, and pointer cancellation prevent long press', () => {
  for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'pointermove']) {
    const { row, menu, hold } = setup();
    row.fire('pointerdown', down);
    row.fire(type, { clientX: 0, clientY: 30 });
    hold();
    assert.equal(menu.open, false, type);
  }
});
test('keyboard and right click open the same action menu', () => {
  for (const type of ['keydown', 'contextmenu']) {
    const { row, menu } = setup();
    let prevented = false;
    row.fire(type, { key: 'Enter', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(menu.open, true);
  }
});

test('list renders collapsed filters, two-line date, and CSRF protected confirmation', async () => {
  const { default: ejs } = await import('ejs');
  const html = await ejs.renderFile('src/views/association-finance-entries.ejs', {
    title: '会計入力一覧', currentUser: null, currentPath: '', csrfToken: 'test-csrf', assetVersion: 'test',
    association: { _id: 'town', name: '町内会' }, filters: {}, exportQuery: '', filterItemsByCf: {}, filterPaymentTypes: [],
    entries: [{ _id: 'one', date: new Date(2026, 3, 1), cf: '支出', expense_item: '会議費', content: '<script>test</script>', amount: 1000 }],
  });
  assert.match(html, /<details class="finance-filter-accordion content-card">/);
  assert.match(html, /<time class="finance-entry-date"><span>2026年<\/span><span>4\/1<\/span><\/time>/);
  assert.match(html, /name="_csrf" value="test-csrf"/);
  assert.match(html, /&lt;script&gt;test&lt;\/script&gt;/);
  assert.doesNotMatch(html, /class="finance-entry-actions"/);
});

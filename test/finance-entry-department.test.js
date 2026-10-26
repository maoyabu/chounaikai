import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { associationFinanceRouter } from '../src/routes/associationFinance.js';
import { Finance } from '../src/models/finance.js';
import { FinanceBudget } from '../src/models/financeBudget.js';

const id = '123456789012345678901234';
const budgets = [
  { year: '2026', cf: '支出', expense_department: '総務部', expense_item: '備品費', details: [{ name: '文具' }] },
  { year: '2026', cf: '支出', expense_department: '防災部', expense_item: '備品費', details: [{ name: '防災用品' }] },
  { year: '2026', cf: '支出', expense_department: '総務部', expense_item: '通信費' },
  { year: '2025', cf: '支出', expense_department: '総務部', expense_item: '旧項目' },
  { year: '2026', cf: '収入', income_category: '会費収入', income_item: '会費' },
  { year: '2026', cf: '収入', income_category: 'その他', income_item: '寄付金' }
];
const invoke = async (body, editing = false, json = false) => {
  const path = editing ? '/:associationId/finance/entries/:entryId/update' : '/:associationId/finance/entries';
  const handler = associationFinanceRouter.stack.find(layer => layer.route?.path === path && layer.route.methods.post).route.stack.at(-1).handle;
  const req = { get: () => json ? 'application/json' : '', body: { date: '2026-04-01', cf: '支出', payment_type: '現金', amount: '100', ...body }, params: { entryId: id }, user: { _id: id }, session: {}, financeContext: { association: { _id: id }, groupId: id } };
  const res = { status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; }, redirect(url) { this.location = url; } };
  let error;
  await handler(req, res, failure => { error = failure; });
  return { res, error };
};
for (const editing of [false, true]) {
  test(`${editing ? 'update' : 'create'} validates department, item and fiscal year and stores department`, async t => {
    const writes = [];
    t.mock.method(FinanceBudget, 'find', filter => ({ lean: async () => budgets.filter(row => row.cf === filter.cf && row.year === filter.year) }));
    t.mock.method(Finance, 'create', async row => writes.push(row));
    t.mock.method(Finance, 'updateOne', async (_filter, update) => writes.push(update.$set));
    for (const body of [
      { item: '備品費' },
      { expense_department: '防災部', item: '通信費' },
      { expense_department: '総務部', item: '旧項目' },
      { date: '2026-03-31', expense_department: '総務部', item: '備品費' }
    ]) {
      const result = await invoke(body, editing);
      assert.equal(result.error?.status, 400);
      assert.equal(result.res.location, undefined);
    }
    assert.equal(writes.length, 0);
    const result = await invoke({ expense_department: '防災部', item: '備品費' }, editing);
    assert.equal(result.error, undefined);
    assert.equal(writes[0].expense_department, '防災部');
    assert.equal(writes[0].expense_item, '備品費');
    const income = await invoke({ cf: '収入', income_category: '会費収入', item: '会費' }, editing);
    assert.equal(income.error, undefined);
    assert.equal(writes[1].expense_department, '');
    assert.equal(writes[1].income_category, '会費収入');
    for (const body of [{ cf: '収入', item: '会費' }, { cf: '収入', income_category: 'その他', item: '会費' }]) {
      assert.equal((await invoke(body, editing)).error?.status, 400);
    }
    assert.equal(writes.length, 2);
  });
}

test('entry form selects department before items, resets tags and filters by fiscal year', async () => {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.style = {}; this.listeners = {}; this._value = ''; this.classList = { toggle() {} }; this.label = { style: {} }; }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    get selectedOptions() { return this.children.filter(child => child.value === this.value); }
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value || ''; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    querySelectorAll() { return this.children; }
    closest() { return this.label; }
    change(value) { this.value = value; this.listeners.change?.(); }
  }
  const fields = Object.fromEntries(['date', 'cf', 'item', 'expense_department', 'payment_type', 'amount'].map(name => [name, new Element()]));
  fields.cf.value = '支出'; fields.item.dataset.selected = '';
  const ids = Object.fromEntries(['finance-entry-group-label', 'finance-entry-department-field', 'finance-entry-item-label', 'finance-entry-tags-field', 'finance-entry-tag-input', 'finance-entry-tag-options', 'finance-entry-tags', 'finance-entry-fiscal-year'].map(name => [name, new Element()]));
  const form = new Element(); form.querySelector = selector => fields[selector.match(/name="([^"]+)"/)[1]];
  const document = { querySelector: () => form, getElementById: id => ids[id], createElement: () => new Element() };
  form.dataset.year = '2026'; form.dataset.fiscalStartMonth = '4';
  const data = budgets.map(row => ({ year: row.year, cf: row.cf, name: row.expense_item || row.income_item, department: (row.cf === '収入' ? row.income_category : row.expense_department) || '未設定', details: row.details || [] }));
  const root = { querySelector: selector => selector === '[data-finance-budgets]' ? { textContent: JSON.stringify(data) } : selector === '.finance-entry-form' ? form : ids[selector.slice(1)] };
  const script = (await readFile(new URL('../src/public/finance-entry.js', import.meta.url), 'utf8')).split("document.querySelectorAll('[data-finance-entry-content]')")[0];
  vm.runInNewContext(script + '\ninitializeFinanceEntry(root);', { document, root });
  assert.equal(fields.item.disabled, true);
  assert.deepEqual(fields.expense_department.children.map(option => option.value), ['', '総務部', '防災部']);
  fields.expense_department.change('総務部');
  assert.equal(fields.item.disabled, false);
  assert.deepEqual(fields.item.children.map(option => option.value), ['', '備品費', '通信費']);
  fields.item.change('通信費');
  ids['finance-entry-tag-input'].value = '以前のタグ';
  fields.expense_department.change('防災部');
  assert.equal(fields.item.value, '');
  assert.equal(ids['finance-entry-tag-input'].value, '');
  assert.deepEqual(fields.item.children.map(option => option.value), ['', '備品費']);
  fields.item.change('備品費');
  assert.equal(ids['finance-entry-tag-options'].children[0].value, '防災用品');
  fields.date.change('2026-03-31');
  assert.deepEqual(fields.item.children.map(option => option.value), ['']);
  fields.expense_department.change('総務部');
  assert.deepEqual(fields.item.children.map(option => option.value), ['', '旧項目']);
  fields.cf.change('収入');
  assert.equal(fields.expense_department.disabled, false);
  assert.equal(fields.expense_department.name, 'income_category');
  assert.equal(ids['finance-entry-group-label'].textContent, '項目分類');
  assert.equal(ids['finance-entry-department-field'].hidden, false);
  fields.date.change('2026-04-01');
  assert.equal(fields.item.disabled, true);
  fields.expense_department.change('会費収入');
  assert.deepEqual(fields.item.children.map(option => option.value), ['', '会費']);
  fields.item.change('会費');
  fields.expense_department.change('その他');
  assert.equal(fields.item.value, '');
  assert.deepEqual(fields.item.children.map(option => option.value), ['', '寄付金']);
});

test('modal saves return JSON, keep continue mode, and report invalid selections without redirecting', async t => {
  t.mock.method(FinanceBudget, 'find', filter => ({ lean: async () => budgets.filter(row => row.cf === filter.cf && row.year === filter.year) }));
  let creates = 0;
  t.mock.method(Finance, 'create', async () => { creates++; });
  t.mock.method(Finance, 'updateOne', async () => ({}));
  for (const editing of [false, true]) {
    const result = await invoke({ expense_department: '総務部', item: '通信費', continue: '1' }, editing, true);
    assert.equal(result.error, undefined);
    assert.equal(result.res.data.ok, true);
    assert.equal(result.res.location, undefined);
    if (!editing) assert.equal(result.res.data.continue, true);
    const invalid = await invoke({ expense_department: '防災部', item: '通信費' }, editing, true);
    assert.equal(invalid.res.statusCode, 400);
    assert.ok(invalid.res.data.message.includes('支出予算項目'));
    assert.equal(invalid.res.location, undefined);
  }
  assert.equal(creates, 1);
});

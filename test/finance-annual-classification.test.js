import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnnualRows, classificationFilter } from '../src/lib/financeAnnual.js';
import ejs from 'ejs';

const budgets = [
  { cf: '収入', income_category: '会費', income_item: '一般', budget: 100 },
  { cf: '収入', income_category: '寄付', income_item: '一般', budget: 200 },
  { cf: '支出', expense_department: '総務部', expense_item: '備品', budget: 300 },
  { cf: '支出', expense_department: '防災部', expense_item: '備品', budget: 400 },
  { cf: '支出', expense_department: '総務部', expense_item: '通信', budget: 50 }
];
const entries = [
  { cf: '収入', income_category: '会費', income_item: '一般', amount: 10 },
  { cf: '収入', income_category: '寄付', income_item: '一般', amount: 20 },
  { cf: '収入', income_item: '一般', amount: 5 },
  { cf: '支出', expense_department_name: '総務部', expense_item: '備品', amount: 30 },
  { cf: '支出', expense_department: '防災部', expense_item: '備品', amount: 40 },
  { cf: '支出', expense_item: '通信', amount: 15 }
].map(entry => ({ ...entry, date: new Date(2026, 3, 1) }));

test('annual rows separate identical names by income category and department without double counting legacy entries', () => {
  const { incomeRows, expenseRows, totalRow } = buildAnnualRows(entries, budgets, [4, 5]);
  assert.deepEqual(incomeRows.map(row => [row.name, row.months[0]]), [['収入', 35], ['会費・一般', 10], ['寄付・一般', 20], ['未設定・一般', 5]]);
  assert.deepEqual(expenseRows.map(row => [row.name, row.months[0]]), [['支出', 85], ['総務部・備品', 30], ['防災部・備品', 40], ['総務部・通信', 15]]);
  assert.deepEqual(totalRow.months, [-50, 0]);
  assert.equal(incomeRows[1].includeLegacy, false);
  assert.equal(expenseRows[3].includeLegacy, true);
  assert.equal(expenseRows[0].budget, 750);
});

test('annual view shows classification and item and keeps each drill-down filter separate', async () => {
  const rows = buildAnnualRows(entries, budgets, [4]);
  const html = await ejs.renderFile('src/views/association-finance-annual.ejs', {
    title: '年度集計', currentUser: null, currentPath: '', csrfToken: 'test', assetVersion: 'test',
    association: { _id: 'town', name: '町内会' }, publicMode: false, year: 2026, fiscalYears: [2026], months: [4], ...rows
  });
  assert.match(html, /会費・一般/);
  assert.match(html, /防災部・備品/);
  assert.ok(html.includes(`item=${encodeURIComponent('一般')}&income_category=${encodeURIComponent('会費')}&includeLegacy=0`));
  assert.ok(html.includes(`item=${encodeURIComponent('備品')}&expense_department=${encodeURIComponent('防災部')}&includeLegacy=0`));
  assert.deepEqual(classificationFilter({ cf: '収入', income_category: '会費' }), { $or: [{ income_category: '会費' }] });
  assert.equal(classificationFilter({ cf: '支出', expense_department: '総務部', includeLegacy: '1' }).$or.length, 3);
});

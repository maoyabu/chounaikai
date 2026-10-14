import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import ExcelJS from 'exceljs';
import { Finance } from '../src/models/finance.js';
import { FinanceBudget } from '../src/models/financeBudget.js';
import { associationFinanceRouter } from '../src/routes/associationFinance.js';

const association = { _id: 'town', name: '町内会', financeFiscalStartMonth: 4 };
test('annual differences use actual minus budget for income and budget minus actual for expenses in both views', async () => {
  for (const publicMode of [true, false]) for (const actual of [80, 120]) {
    const row = name => ({ name, budget: 100, months: [actual] });
    const html = await ejs.renderFile('src/views/association-finance-annual.ejs', {
      title: '年度集計', currentUser: null, currentPath: '', csrfToken: 'test', assetVersion: 'test',
      association, publicMode, year: 2026, fiscalYears: [2026], months: [4],
      incomeRows: [row('収入'), row('会費')], expenseRows: [row('支出'), row('備品')],
      totalRow: { name: '収支', budget: 0, months: [0] }
    });
    const income = [...html.matchAll(/<tr class="finance-annual-row finance-annual-income[\s\S]*?<\/tr>/g)];
    const expenses = [...html.matchAll(/<tr class="finance-annual-row finance-annual-expense[\s\S]*?<\/tr>/g)];
    for (const match of income) assert.ok(match[0].endsWith(`<strong>${actual - 100}</strong></td></tr>`));
    for (const match of expenses) assert.ok(match[0].endsWith(`<strong>${100 - actual}</strong></td></tr>`));
    assert.match(html, /収入＝累計 − 予算 ／ 支出＝予算 − 累計/);
    assert.ok(html.indexOf('累計差の算出方法') < html.indexOf('<table'));
  }
});

test('Excel export calculates the same differences for category totals and individual items', async t => {
  const entries = [
    { cf: '収入', income_item: '会費', amount: 120, date: new Date(2026, 3, 1) },
    { cf: '支出', expense_item: '備品', amount: 80, date: new Date(2026, 3, 1) }
  ];
  t.mock.method(Finance, 'find', () => ({ lean: async () => entries }));
  t.mock.method(FinanceBudget, 'find', () => ({ sort() { return this; }, lean: async () => [
    { cf: '収入', income_item: '会費', budget: 100 }, { cf: '支出', expense_item: '備品', budget: 100 }
  ] }));
  const route = associationFinanceRouter.stack.find(layer => layer.route?.path === '/:associationId/finance/annual/export').route;
  let buffer;
  await route.stack.at(-1).handle({ query: { year: 2026 }, financeContext: { association, groupId: 'group', year: 2026 } },
    { setHeader() {}, send(value) { buffer = value; } }, error => { throw error; });
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('年度集計');
  for (const rowNumber of [2, 3, 6, 7]) assert.equal(sheet.getRow(rowNumber).getCell(16).value, 20);
  assert.match(sheet.getCell('P1').note, /収入＝累計 − 予算/);
});

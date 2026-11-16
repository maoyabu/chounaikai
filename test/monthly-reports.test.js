import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { renderView } from '../test-support/renderView.js';
import { buildMonthlyReport, reportPeriod, currentReportMonth, loadMonthlyReport, saveMonthlyInformation, eventSchedule, reportMonthLabel } from '../src/services/monthlyReportService.js';
import { monthlyReportWorkbook } from '../src/services/monthlyReportExcel.js';
import { monthlyReportsRouter } from '../src/routes/monthlyReports.js';
import { eventDepartmentValue } from '../src/services/associationEventService.js';
import { MonthlyReport } from '../src/models/monthlyReport.js';
import { Finance } from '../src/models/finance.js';
import { AssociationEvent } from '../src/models/associationEvent.js';
import { AnnualDepartmentPlan } from '../src/models/annualDepartmentPlan.js';
import { Department } from '../src/models/organization.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { RoleDefinition, RoleAssignment } from '../src/models/role.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';

const aid = 'aaaaaaaaaaaaaaaaaaaaaaaa', uid = 'bbbbbbbbbbbbbbbbbbbbbbbb', did = 'cccccccccccccccccccccccc';
const association = { _id: aid, name: 'みどり町内会', group: 'group', financeFiscalStartMonth: 4, optionalFeatures: { finance: true } };
const event = (id, startDate, extra = {}) => ({ _id: id, association: aid, title: id, category: '防災部', startDate, endDate: startDate, startTime: '09:00', endTime: '10:00', visible: true, ...extra });
const query = value => ({ sort() { return this; }, select() { return this; }, lean: async () => value });
const next = error => { throw error; };
const route = (method, path) => monthlyReportsRouter.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;

test('month selection is strict, rolls across years, and defaults using Japan time', () => {
  assert.deepEqual(reportPeriod('2026-01'), { month: '2026-01', previousMonth: '2025-12', nextMonth: '2026-02', futureEndMonth: '2027-02' });
  assert.equal(reportPeriod('2026-12').nextMonth, '2027-01');
  assert.equal(currentReportMonth(new Date('2026-11-30T16:00:00Z')), '2026-12');
  for (const month of ['', '2026-00', '2026-13', '1999-12', '2201-01', ['2026-11'], '2026-11-01']) assert.throws(() => reportPeriod(month), { status: 400 });
});

test('finance uses fiscal-year-to-selected-month totals, inclusive Japan boundaries and no future entries', () => {
  const report = buildMonthlyReport({ association, month: '2027-01', entries: [
    { date: '2026-03-31T14:59:59Z', cf: '収入', amount: 900 },
    { date: '2026-03-31T15:00:00Z', cf: '収入', amount: 1000 },
    { date: '2027-01-31T14:59:59Z', cf: '支出', amount: 300 },
    { date: '2027-01-31T15:00:00Z', cf: '支出', amount: 999 }
  ] });
  assert.deepEqual(report.finance, { enabled: true, fiscalYear: 2026, fiscalStartMonth: '2026-04', income: 1000, expense: 300, carryover: 700 });
  const calendar = buildMonthlyReport({ association: { ...association, financeFiscalStartMonth: 1 }, month: '2027-01' });
  assert.equal(calendar.finance.fiscalStartMonth, '2027-01');
  assert.equal(buildMonthlyReport({ association: { ...association, optionalFeatures: {} }, month: '2026-11' }).finance.enabled, false);
});

test('existing events are split into previous month, department current results and all future single events', () => {
  const report = buildMonthlyReport({ association, month: '2026-11', departments: [{ _id: did, name: '防災部' }, { _id: 'other', name: '文化部' }], plans: [{ department: did, report: '年度の成果' }], events: [
    event('前月', '2026-10-12', { completed: true, implementationReport: '30名参加' }),
    event('月またぎ', '2026-10-31', { endDate: '2026-11-02' }),
    event('明示的担当部', '2026-11-15', { department: 'other' }),
    event('未設定', '2026-11-15', { category: 'その他' }),
    event('不明な部', '2026-11-15', { department: 'deleted' }),
    event('翌月', '2026-12-01'), event('遠い将来', '2030-01-01'),
    event('非公開', '2026-11-15', { visible: false }),
    event('グループ', '2026-11-15', { group: 'group' }),
    event('他町内会', '2026-11-15', { association: 'foreign' })
  ] });
  assert.deepEqual(report.previousEvents.map(item => item._id), ['前月', '月またぎ']);
  assert.deepEqual(report.departmentReports[0].currentEvents.map(item => item._id), ['月またぎ']);
  assert.equal(report.departmentReports[0].annualReport, '年度の成果');
  assert.deepEqual(report.departmentReports[0].futureEvents.map(item => item._id), ['翌月', '遠い将来']);
  assert.equal(report.departmentReports[1].currentEvents[0]._id, '明示的担当部');
  assert.equal(report.departmentReports[2].name, '担当部未設定');
  assert.equal(report.departmentReports[2].currentEvents.length, 2);
});

test('recurring events use actual occurrence dates, respect end dates, and bound indefinite future series', () => {
  const report = buildMonthlyReport({ association, month: '2026-11', departments: [{ _id: did, name: '防災部' }], events: [
    event('定例', '2026-10-01', { recurrence: { frequency: 'monthly', monthDays: [15] }, implementationReport: '共通報告' }),
    event('終了済', '2026-10-01', { recurrence: { frequency: 'monthly', monthDays: [20], until: '2026-11-20' } })
  ] });
  const department = report.departmentReports[0];
  assert.deepEqual(department.currentEvents.map(item => item.startDate), ['2026-11-15', '2026-11-20']);
  assert.equal(department.futureEvents.length, 12);
  assert.equal(department.futureEvents.at(-1).startDate, '2027-11-15');
});

test('report loader scopes every data source to the association, fiscal period, and linked finance group', async t => {
  t.mock.method(MonthlyReport, 'findOne', filter => { assert.deepEqual(filter, { association: aid, month: '2027-01' }); return query({ information: '共有済み' }); });
  t.mock.method(Department, 'find', filter => { assert.deepEqual(filter, { association: aid }); return query([]); });
  t.mock.method(AssociationEvent, 'find', filter => { assert.deepEqual(filter, { association: aid, group: null, visible: true }); return query([]); });
  t.mock.method(AnnualDepartmentPlan, 'find', filter => { assert.deepEqual(filter, { association: aid, fiscalYear: 2026 }); return query([]); });
  t.mock.method(Finance, 'find', filter => {
    assert.equal(filter.group, 'group');
    assert.equal(filter.date.$gte.toISOString(), '2026-03-31T15:00:00.000Z');
    assert.equal(filter.date.$lt.toISOString(), '2027-01-31T15:00:00.000Z');
    return query([]);
  });
  assert.equal((await loadMonthlyReport({ association, month: '2027-01' })).information, '共有済み');
});

test('shared information is saved once per tenant/month, supports clearing, and validates before writing', async t => {
  let saved;
  t.mock.method(MonthlyReport, 'findOneAndUpdate', async (filter, update, options) => { saved = { filter, update, options }; });
  await saveMonthlyInformation({ association: aid, month: '2026-11', information: '  会議の共有\n二行目  ', user: uid });
  assert.deepEqual(saved.filter, { association: aid, month: '2026-11' });
  assert.deepEqual(saved.update.$set, { information: '会議の共有\n二行目', updatedBy: uid });
  assert.equal(saved.options.upsert, true);
  await saveMonthlyInformation({ association: aid, month: '2026-12', information: '', user: uid });
  assert.equal(saved.update.$set.information, '');
  for (const information of [undefined, {}, 'あ'.repeat(20001)]) await assert.rejects(saveMonthlyInformation({ association: aid, month: '2026-11', information, user: uid }), { status: 400 });
  assert.equal(MonthlyReport.findOneAndUpdate.mock.callCount(), 2);
  assert.ok(MonthlyReport.schema.indexes().some(([keys, options]) => keys.association && keys.month && options.unique));
});

function mockAccess(t, { member = true, officer = true, manager = false } = {}) {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query(association));
  t.mock.method(AssociationMembership, 'findOne', filter => { assert.equal(filter.user, uid); return query(member ? { user: uid } : null); });
  t.mock.method(RoleDefinition, 'find', () => query([{ _id: 'role' }]));
  t.mock.method(RoleAssignment, 'exists', async () => manager);
  t.mock.method(AnnualOfficer, 'exists', async () => officer);
}

test('all monthly-report paths require active membership and officer/manager access; writes require CSRF', async t => {
  assert.equal(monthlyReportsRouter.stack[0].handle, requireLogin);
  assert.equal(route('post', '/:associationId/monthly-reports').stack[0].handle, verifyCsrfToken);
  mockAccess(t, { officer: false });
  const req = { params: { associationId: aid }, user: { _id: uid }, query: { month: '2026-11' }, body: { month: '2026-11', information: '' } };
  for (const [method, path] of [['get','/:associationId/monthly-reports'],['get','/:associationId/monthly-reports.xlsx'],['post','/:associationId/monthly-reports']]) {
    await assert.rejects(route(method, path).stack.at(-1).handle(req, {}, next), { status: 403 });
  }
  AssociationMembership.findOne.mock.mockImplementation(() => query(null));
  await assert.rejects(route('get', '/:associationId/monthly-reports').stack[0].handle(req, {}, next), { status: 403 });
});

test('officers and managers can save information and preserve the selected month on redirect', async t => {
  mockAccess(t, { officer: false, manager: true });
  let filter, redirected;
  t.mock.method(MonthlyReport, 'findOneAndUpdate', async value => { filter = value; });
  const req = { params: { associationId: aid }, user: { _id: uid }, body: { month: '2026-12', information: '年末行事の案内' }, session: {} };
  await route('post', '/:associationId/monthly-reports').stack.at(-1).handle(req, { redirect: value => { redirected = value; } }, next);
  assert.deepEqual(filter, { association: aid, month: '2026-12' });
  assert.equal(redirected, `/associations/${aid}/monthly-reports?month=2026-12&output=1`);
});

test('officer download returns a valid Excel attachment and disabled finance never reads ledger data', async t => {
  mockAccess(t);
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ ...association, optionalFeatures: {} }));
  t.mock.method(MonthlyReport, 'findOne', () => query({ information: '共有文' }));
  t.mock.method(Department, 'find', () => query([]));
  t.mock.method(AssociationEvent, 'find', () => query([]));
  t.mock.method(AnnualDepartmentPlan, 'find', () => query([]));
  t.mock.method(Finance, 'find', () => { throw new Error('finance should not be queried'); });
  const headers = {};
  let buffer;
  const req = { params: { associationId: aid }, user: { _id: uid }, query: { month: '2026-11' } };
  await route('get', '/:associationId/monthly-reports.xlsx').stack[0].handle(req, { set: (name, value) => { headers[name] = value; }, send: value => { buffer = value; } }, next);
  assert.equal(headers['Cache-Control'], 'private, no-store');
  assert.match(headers['Content-Type'], /spreadsheetml/);
  assert.ok(decodeURIComponent(headers['Content-Disposition']).includes('2026-11_月次報告.xlsx'));
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(buffer);
  assert.equal(restored.getWorksheet('月次報告').getCell('A3').value, '共有文');
  await assert.rejects(route('get', '/:associationId/monthly-reports.xlsx').stack[0].handle({ ...req, query: { month: 'invalid' } }, {}, next), { status: 400 });
});

test('event department assignment rejects foreign departments and preserves omitted assignments from older clients', async t => {
  assert.equal(await eventDepartmentValue({}, aid, { department: did }), did);
  assert.equal(await eventDepartmentValue({ department: '' }, aid), null);
  t.mock.method(Department, 'exists', async filter => { assert.deepEqual(filter, { _id: did, association: aid }); return false; });
  await assert.rejects(eventDepartmentValue({ department: did }, aid), { status: 400 });
  await assert.rejects(eventDepartmentValue({ department: 'invalid' }, aid), { status: 400 });
  Department.exists.mock.mockImplementation(async () => true);
  assert.equal(await eventDepartmentValue({ department: did }, aid), did);
});

test('Excel export contains the same saved information, numeric finance totals and event reports without executing input formulas', async () => {
  const report = buildMonthlyReport({ association, month: '2026-11', information: '=HYPERLINK("https://example.test")', departments: [{ _id: did, name: '防災部' }], events: [event('避難訓練', '2026-10-10', { completed: true, implementationReport: '避難経路を確認' }), event('防災講習', '2026-11-10'), event('防災点検', '2026-12-10')], entries: [{ cf: '収入', amount: 1000, date: '2026-04-01' }, { cf: '支出', amount: 250, date: '2026-11-10' }] });
  const buffer = await monthlyReportWorkbook(association, report).xlsx.writeBuffer();
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(buffer);
  assert.deepEqual(restored.worksheets.map(sheet => sheet.name), ['月次報告','前月の町内会行事','部ごとの行事']);
  const summary = restored.getWorksheet('月次報告');
  assert.equal(summary.getCell('A3').value, report.information);
  assert.equal(summary.getCell('A3').type, ExcelJS.ValueType.String);
  const income = summary.getRows(1, summary.rowCount).find(row => row.getCell(1).value === '累計収入');
  assert.equal(income.getCell(2).value, 1000);
  const carry = summary.getRows(1, summary.rowCount).find(row => row.getCell(1).value === '次月繰越し金');
  assert.equal(carry.getCell(2).value, 750);
  assert.match(JSON.stringify(restored.getWorksheet('前月の町内会行事').getSheetValues()), /避難経路を確認/);
  assert.match(JSON.stringify(restored.getWorksheet('部ごとの行事').getSheetValues()), /防災点検/);
});

test('monthly report page escapes shared text, displays month scopes and output links, and hides output until requested', async () => {
  const report = buildMonthlyReport({ association, month: '2026-11', information: '<script>alert(1)</script>\n連絡事項', events: [event('前月行事', '2026-10-01')] });
  const locals = { title: '月次報告', association, report, showOutput: true, reportMonthLabel, eventSchedule, csrfToken: 'token', currentPath: '' };
  const html = await renderView('src/views/monthly-report.ejs', locals);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /前月（2026年10月）/);
  assert.match(html, /monthly-reports.xlsx\?month=2026-11/);
  assert.match(html, /name="_csrf" value="token"/);
  const initial = await renderView('src/views/monthly-report.ejs', { ...locals, showOutput: false });
  assert.doesNotMatch(initial, /Excel形式でダウンロード/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileFinanceRouter, mobileFinanceValues, mobileFinanceQuery, mobileFinanceClassification } from '../src/routes/mobileFinance.js';
import { Finance } from '../src/models/finance.js';
import { FinanceBudget } from '../src/models/financeBudget.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleDefinition } from '../src/models/role.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';

const aid = 'aaaaaaaaaaaaaaaaaaaaaaaa', uid = 'bbbbbbbbbbbbbbbbbbbbbbbb', gid = 'cccccccccccccccccccccccc', eid = 'dddddddddddddddddddddddd';
const scope = { group: gid, user: uid };
const q = value => ({ select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => value });
const next = error => { if (error) throw error; };
const handler = (path, method = 'get') => mobileFinanceRouter.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const association = { _id: aid, group: gid, financeFiscalStartMonth: 4, optionalFeatures: { finance: true } };
const request = (body = {}) => ({ params: { associationId: aid, entryId: eid }, query: {}, body, user: { _id: uid, displayname: '入力者' }, financeContext: { association, groupId: gid } });
const response = () => ({ locals: { csrfToken: 'token' }, set() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.value = value; } });
const budget = { _id: eid, year: '2026', cf: '支出', expense_department: '防災部', expense_item: '備品費', details: [{ name: '防災', content: '備品' }] };
const input = { date: '2026-04-01', cf: '支出', expense_department: '防災部', item: '備品費', content: '備品購入', amount: '１，２００', payment_type: '現金', tagText: '防災：備品' };

test('finance requires officer authority, active membership and enabled feature; all writes verify CSRF', async t => {
  assert.equal(mobileFinanceRouter.stack[0].handle, requireLogin);
  for (const layer of mobileFinanceRouter.stack.filter(layer => layer.route?.methods.post)) assert.equal(layer.route.stack[0].handle, verifyCsrfToken);
  t.mock.method(NeighborhoodAssociation, 'findOne', () => q(association));
  t.mock.method(AssociationMembership, 'findOne', () => q({ status: 'active' }));
  t.mock.method(RoleDefinition, 'find', () => q([]));
  t.mock.method(AnnualOfficer, 'exists', async () => null);
  const check = mobileFinanceRouter.stack[1].handle;
  await assert.rejects(check(request(), response(), next), { status: 403 });
  AnnualOfficer.exists.mock.mockImplementation(async () => ({ _id: eid }));
  let continued = false;
  await check(request(), response(), error => { if (error) throw error; continued = true; });
  assert.ok(continued);
  NeighborhoodAssociation.findOne.mock.mockImplementation(() => q({ ...association, optionalFeatures: { finance: false } }));
  await assert.rejects(check(request(), response(), next), { status: 404 });
  AssociationMembership.findOne.mock.mockImplementation(() => q(null));
  await assert.rejects(check(request(), response(), next), { status: 403 });
});

test('filters preserve author scope, combine item and keyword, escape regex and include end date', () => {
  const result = mobileFinanceQuery(scope, { cf: '支出', item: '備品費', payment_type: '現金', keyword: '[備品].*', from: '2026-04-01', to: '2026-04-30', user: 'other' });
  assert.equal(result.user, uid); assert.equal(result.group, gid);
  assert.equal(result.cf, '支出'); assert.equal(result.payment_type, '現金');
  assert.deepEqual(result.$and[0].$or[0], { expense_item: '備品費' });
  assert.ok(result.$or[0].content.test('[備品].*'));
  assert.ok(!result.$or[0].content.test('備品購入'));
  assert.equal(result.date.$lt.toISOString(), '2026-05-01T00:00:00.000Z');
  for (const filters of [{ from: '2026-02-30' }, { from: '2026-05-01', to: '2026-04-01' }, { cf: 'invalid' }]) assert.throws(() => mobileFinanceQuery(scope, filters), { status: 400 });
});

test('list and filter suggestions contain only current users entries, with pagination', async t => {
  t.mock.method(FinanceBudget, 'find', () => q([]));
  t.mock.method(Finance, 'find', filter => { assert.deepEqual(filter, scope); return q([{ _id: eid, date: '2026-04-01', cf: '支出', amount: 1200, expense_item: '備品費' }]); });
  t.mock.method(Finance, 'countDocuments', async filter => { assert.deepEqual(filter, scope); return 51; });
  t.mock.method(Finance, 'distinct', async (_field, filter) => { assert.equal(filter.group, gid); assert.equal(filter.user, uid); return ['備品費']; });
  const res = response();
  await handler('/entries')(request(), res, next);
  assert.equal(res.value.entries.length, 1); assert.equal(res.value.hasMore, true);
  assert.equal(res.value.entries[0].date, '2026-04-01'); assert.equal(res.value.csrfToken, 'token');
});

test('legacy classification matches editor by fiscal year and item without guessing ambiguous departments', () => {
  const entry = { date: '2026-03-31', cf: '支出', expense_item: '女性部' };
  const budgets = [{ year: '2025', cf: '支出', expense_item: '女性部', expense_department: '女性部' },
    { year: '2026', cf: '支出', expense_item: '女性部', expense_department: '別年度の部' }];
  assert.equal(mobileFinanceClassification(entry, budgets), '女性部');
  assert.equal(mobileFinanceClassification({ ...entry, expense_department: '登録済みの部' }, budgets), '登録済みの部');
  assert.equal(mobileFinanceClassification(entry, [...budgets, { ...budgets[0], expense_department: '他の部' }]), '未設定');
  assert.equal(mobileFinanceClassification(entry, []), '未設定');
  assert.equal(mobileFinanceClassification({ date: '2026-04-01', cf: '収入', income_item: '会費' }, [{ year: '2026', cf: '収入', income_item: '会費', income_category: '会費収入' }]), '会費収入');
});

test('form and writes reject other authors entries and deletion always scopes by author and group', async t => {
  const expected = { ...scope, _id: eid };
  t.mock.method(Finance, 'findOne', filter => { assert.deepEqual(filter, expected); return q(null); });
  t.mock.method(Finance, 'exists', async filter => { assert.deepEqual(filter, expected); return false; });
  t.mock.method(Finance, 'deleteOne', async filter => { assert.deepEqual(filter, expected); return { deletedCount: 0 }; });
  await assert.rejects(handler('/form')({ ...request(), query: { entryId: eid } }, response(), next), { status: 404 });
  await assert.rejects(handler('/entries/:entryId/update', 'post')(request(input), response(), next), { status: 404 });
  await assert.rejects(handler('/entries/:entryId/delete', 'post')(request(), response(), next), { status: 404 });
});

test('form follows active payment ordering and exposes fiscal budget tag choices', async t => {
  t.mock.method(FinanceBudget, 'find', filter => { assert.deepEqual(filter, { group: gid }); return q([budget]); });
  const req = request();
  req.financeContext.association = { ...association, financePaymentMethods: [{ name: '停止', active: false }, { name: '振込', order: 2 }, { name: '現金', order: 1 }] };
  const res = response(); await handler('/form')(req, res, next);
  assert.deepEqual(res.value.paymentTypes, ['現金', '振込']);
  assert.equal(res.value.fiscalStartMonth, 4);
  assert.deepEqual(res.value.budgets[0].tags, ['防災：備品']);
});

test('create uses Web classification validation and ignores forged owner and inputter', async t => {
  t.mock.method(FinanceBudget, 'find', filter => q(filter.year === budget.year && filter.cf === budget.cf ? [budget] : []));
  let saved;
  t.mock.method(Finance, 'create', async value => { saved = value; return { ...value, _id: eid }; });
  const res = response();
  await handler('/entries', 'post')(request({ ...input, user: 'other', group: 'other', inputterName: 'other' }), res, next);
  assert.equal(res.statusCode, 201); assert.equal(saved.user, uid); assert.equal(saved.group, gid);
  assert.equal(saved.amount, 1200); assert.equal(saved.inputterName, '入力者'); assert.equal(saved.usedBy, '入力者');
  assert.equal(saved.expense_department, '防災部'); assert.deepEqual(saved.tags, [{ name: '防災：備品' }]);
  for (const patch of [{ date: '2026-03-31' }, { expense_department: '総務部' }, { item: '他の項目' }, { date: 'bad' }, { amount: '-1' }, { amount: '' }, { content: '' }, { payment_type: '' }]) {
    await assert.rejects(mobileFinanceValues(request({ ...input, ...patch })), { status: 400 });
  }
});

test('editing to income clears expense fields, tags and payment without changing author', async t => {
  t.mock.method(Finance, 'exists', async () => true);
  t.mock.method(FinanceBudget, 'find', () => q([{ cf: '収入', income_category: '会費', income_item: '会費収入' }]));
  t.mock.method(Finance, 'findOneAndUpdate', async (filter, update) => {
    assert.deepEqual(filter, { ...scope, _id: eid });
    assert.equal(update.$set.user, undefined); assert.equal(update.$set.group, undefined);
    assert.equal(update.$set.expense_item, ''); assert.equal(update.$set.payment_type, '');
    assert.deepEqual(update.$set.tags, []);
    return { ...update.$set, _id: eid };
  });
  const res = response();
  await handler('/entries/:entryId/update', 'post')(request({ ...input, cf: '収入', income_category: '会費', item: '会費収入' }), res, next);
  assert.equal(res.value.entry.cf, '収入');
});

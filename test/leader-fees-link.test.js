import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ejs from 'ejs';
import fs from 'node:fs';
import { householdsRouter } from '../src/routes/households.js';
import { Household, HouseholdMember, DistrictGroup } from '../src/models/organization.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationFeePayment } from '../src/models/associationFeePayment.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
const id = () => new mongoose.Types.ObjectId();
const query = value => ({ populate() { return this; }, select() { return this; }, sort() { return this; }, lean() { return Promise.resolve(value); }, distinct() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });

for (const linked of [false, true]) test(linked ? '台帳に紐付け済みの会員は候補から除外する' : 'プロフィール世帯のある担当班の会員を候補に表示する', async t => {
  t.mock.method(AssociationFeePayment, 'find', () => { throw new Error('世帯管理では納付情報を取得しない'); });
  const user = id(), oldHousehold = id(), freeHousehold = id(), district = id();
  t.mock.method(AnnualLeaderAssignment, 'find', () => query([district]));
  t.mock.method(NeighborhoodAssociation, 'findById', () => query({}));
  t.mock.method(DistrictGroup, 'find', () => query([]));
  t.mock.method(AssociationMembership, 'find', () => query([{ user: { _id: user }, household: { _id: oldHousehold } }]));
  t.mock.method(HouseholdMember, 'find', () => query([]));
  t.mock.method(Household, 'find', filter => {
    if (filter.districtLabel) return query([{ _id: freeHousehold, districtLabel: '01' }]);
    assert.ok(filter.$or.some(condition => condition.districtLabel));
    assert.ok(filter.$or.some(condition => condition.feeRepresentative));
    return query(linked ? [{ _id: oldHousehold, feeRepresentative: user }] : []);
  });
  const handler = householdsRouter.stack.find(layer => layer.route?.path === '/:associationId/leader/fees' && layer.route.methods.get).route.stack.at(-1).handle;
  let result;
  await handler({ params: { associationId: String(id()) }, user: { _id: id() }, query: { year: 'invalid' } }, { render(view, data) { result = data; } }, error => { throw error; });
  assert.equal(result.members.length, linked ? 0 : 1);
  if (!linked) assert.equal(String(result.members[0].user._id), String(user));
  assert.equal(result.linkableHouseholds.length, 1);
  assert.equal(result.title, '班の世帯管理');
  assert.equal(result.fiscalYear, undefined);
  const template = fs.readFileSync('src/views/leader-fees.ejs', 'utf8').replace(/<%- include\('partials\/(?:head|header|foot)'\) %>/g, '');
  const html = ejs.render(template, { ...result, association: { _id: 'association' }, csrfToken: 'token' });
  assert.ok(!html.includes('fiscalYear'));
  assert.ok(!html.includes('name="year"'));
  assert.ok(!html.includes('name="paid"'));
  assert.ok(!html.includes('/toggle'));
  assert.ok(html.includes('現在の世帯情報'));
  assert.ok(!householdsRouter.stack.some(layer => layer.route?.path === '/:associationId/leader/fees/:householdId/toggle'));
});

test('台帳に紐付いた会員の再送信では更新せず案内する', async t => {
  const user = id(), household = { _id: id() };
  t.mock.method(AnnualLeaderAssignment, 'find', () => query([id()]));
  const save = t.mock.fn();
  t.mock.method(AssociationMembership, 'findOne', () => query({ user, household: id(), save }));
  t.mock.method(Household, 'findOne', () => query(household));
  t.mock.method(Household, 'exists', filter => {
    assert.ok(filter.$and[0].$or.some(condition => condition.districtLabel));
    return Promise.resolve({ _id: id() });
  });
  const req = { params: { associationId: String(id()) }, user: { _id: id() }, body: { userId: String(user), householdId: String(household._id), fiscalYear: 2026 }, session: {} };
  const handler = householdsRouter.stack.find(layer => layer.route?.path === '/:associationId/leader/fees/link').route.stack.at(-1).handle;
  let redirect;
  await handler(req, { redirect(url) { redirect = url; } }, error => { throw error; });
  assert.equal(save.mock.callCount(), 0);
  assert.match(req.session.notice, /既に紐付け済み/);
  assert.match(redirect, /leader\/fees$/);
});

for (const hasProfile of [false, true]) test(`未紐付け会員を保存できる（プロフィール世帯${hasProfile ? 'あり' : 'なし'}）`, async t => {
  const user = id(), district = id();
  const membership = { user, ...(hasProfile ? { household: id() } : {}), save: t.mock.fn() };
  const household = { _id: id(), save: t.mock.fn() };
  t.mock.method(AnnualLeaderAssignment, 'find', () => query([district]));
  t.mock.method(AssociationMembership, 'findOne', filter => {
    assert.deepEqual(filter.districtGroup.$in, [district]);
    assert.equal(filter.status, 'active');
    return query(membership);
  });
  t.mock.method(Household, 'findOne', () => query(household));
  t.mock.method(Household, 'exists', filter => {
    assert.ok(filter.$and[0].$or.some(condition => condition.districtLabel));
    return Promise.resolve(null);
  });
  const request = { params: { associationId: String(id()) }, user: { _id: id() }, body: { userId: String(user), householdId: String(household._id) }, session: {} };
  const handler = householdsRouter.stack.find(layer => layer.route?.path === '/:associationId/leader/fees/link').route.stack.at(-1).handle;
  await handler(request, { redirect() {} }, error => { throw error; });
  assert.equal(membership.save.mock.callCount(), 1);
  assert.equal(household.save.mock.callCount(), 1);
  assert.equal(household.feeRepresentative, user);
});

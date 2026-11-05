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
    if (filter.districtGroup) return query([{ _id: freeHousehold, districtLabel: '01' }]);
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

test('班長自身のプロフィール世帯を一覧と紐付け済み対象に含める', async t => {
  const user = id(), household = id(), district = id();
  t.mock.method(AnnualLeaderAssignment, 'find', () => query([district]));
  t.mock.method(NeighborhoodAssociation, 'findById', () => query({}));
  t.mock.method(DistrictGroup, 'find', () => query([]));
  t.mock.method(AssociationMembership, 'find', () => query([{ user: { _id: user }, household: { _id: household } }]));
  t.mock.method(Household, 'find', filter => {
    if (!filter.districtGroup) return query([]);
    assert.ok(filter.$or.some(condition => String(condition.representative) === String(user)));
    return query([{ _id: household, representative: { _id: user, displayname: '班長' } }]);
  });
  const handler = householdsRouter.stack.find(layer => layer.route?.path === '/:associationId/leader/fees').route.stack.at(-1).handle;
  let result;
  await handler({ params: { associationId: String(id()) }, user: { _id: user } }, { render(view, data) { result = data; } }, error => { throw error; });
  assert.equal(result.households.length, 1);
  assert.deepEqual(result.leaderHouseholdIds, [String(household)]);
  assert.equal(result.members.length, 0);
  assert.equal(result.linkableHouseholds.length, 0);
});

for (const allowed of [true, false]) test(`会員紐付け解除（${allowed ? '担当班' : '担当外を拒否'}）`, async t => {
  const original = id(), user = id();
  const household = { _id: id(), feeRepresentative: user, save: t.mock.fn() };
  const membership = { household: household._id, ledgerPreviousHousehold: original, save: t.mock.fn() };
  t.mock.method(AnnualLeaderAssignment, 'find', () => query([id()]));
  t.mock.method(Household, 'findOne', filter => {
    assert.ok(filter.districtGroup.$in.length);
    assert.equal(filter.active, true);
    return query(allowed ? household : null);
  });
  t.mock.method(AssociationMembership, 'findOne', () => query(membership));
  const handler = householdsRouter.stack.find(layer => layer.route?.path === '/:associationId/leader/fees/:householdId/unlink').route.stack.at(-1).handle;
  let error;
  await handler({ params: { associationId: String(id()), householdId: String(household._id) }, user: { _id: id() }, session: {} }, { redirect() {} }, value => { error = value; });
  if (!allowed) { assert.equal(error.status, 403); assert.equal(household.save.mock.callCount(), 0); return; }
  assert.equal(error, undefined);
  assert.equal(membership.household, original);
  assert.equal(membership.ledgerPreviousHousehold, undefined);
  assert.equal(household.feeRepresentative, undefined);
  assert.equal(membership.save.mock.callCount(), 1);
});

test('年度設定で会員を紐付けた班長に世帯がなければ台帳へ登録する', async t => {
  const { managementRouter } = await import('../src/routes/management.js');
  const user = id(), district = id(), householdId = id();
  const leader = { representative: user, districtGroup: district, name: '班長', fiscalYear: 2026, save: t.mock.fn() };
  const membership = { user, save: t.mock.fn() };
  t.mock.method(AnnualLeaderAssignment, 'findOne', () => query(leader));
  t.mock.method(AssociationMembership, 'findOne', () => query(membership));
  t.mock.method(Household, 'findOne', () => query(null));
  t.mock.method(Household, 'create', values => {
    assert.equal(values.feeRepresentative, user);
    assert.equal(values.districtGroup, district);
    assert.equal(values.districtLabel, '班長世帯');
    return Promise.resolve({ _id: householdId });
  });
  const handler = managementRouter.stack.find(layer => layer.route?.path === '/:associationId/manage/leaders/:leaderId/link').route.stack.at(-1).handle;
  await handler({ params: { associationId: String(id()), leaderId: String(id()) }, body: { userId: String(user) }, session: {} }, { redirect() {} }, error => { throw error; });
  assert.equal(membership.household, householdId);
  assert.equal(leader.household, householdId);
  assert.equal(membership.save.mock.callCount(), 1);
});

for (const populated of [true, false]) test(`会員側だけに保存された世帯紐付けも両方の選択肢から除外する（${populated ? '展開済み' : 'IDのみ'}）`, async t => {
  const linkedUser = id(), freeUser = id(), householdId = id(), freeHouseholdId = id(), profileId = id();
  const memberships = [
    { user: { _id: linkedUser, displayname: '登録済み会員' }, household: populated ? { _id: householdId } : householdId },
    { user: { _id: freeUser, displayname: '未紐付け会員' }, household: { _id: profileId } }
  ];
  t.mock.method(AnnualLeaderAssignment, 'find', () => query([id()]));
  t.mock.method(NeighborhoodAssociation, 'findById', () => query({ _id: id() }));
  t.mock.method(DistrictGroup, 'find', () => query([]));
  t.mock.method(AssociationMembership, 'find', () => query(memberships));
  t.mock.method(Household, 'find', filter => query(filter.districtGroup
    ? [{ _id: householdId, displayName: '登録済み世帯', districtLabel: '01' }, { _id: freeHouseholdId, displayName: '未紐付け世帯', districtLabel: '02' }]
    : [{ _id: householdId }, { _id: freeHouseholdId }]));
  const handler = householdsRouter.stack.find(layer => layer.route?.path === '/:associationId/leader/fees').route.stack.at(-1).handle;
  let result;
  await handler({ params: { associationId: String(id()) }, user: { _id: id() } }, { render(view, data) { result = data; } }, error => { throw error; });
  assert.deepEqual(result.members.map(item => item.user._id), [freeUser]);
  assert.deepEqual(result.linkableHouseholds.map(item => item._id), [freeHouseholdId]);
  assert.equal(result.households[0].representative._id, linkedUser);
  const template = fs.readFileSync('src/views/leader-fees.ejs', 'utf8').replace(/<%- include\('partials\/(?:head|header|foot)'\) %>/g, '');
  const html = ejs.render(template, { ...result, csrfToken: 'token' });
  const memberOptions = html.match(/<select name="userId" required>([\s\S]*?)<\/select>/)[1];
  assert.ok(!memberOptions.includes(String(linkedUser)));
  assert.ok(memberOptions.includes(String(freeUser)));
  const householdOptions = html.match(/<select name="householdId" required>([\s\S]*?)<\/select>/)[1];
  assert.ok(!householdOptions.includes(String(householdId)));
});

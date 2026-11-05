import { AnnualOfficer } from '../src/models/annualOfficer.js';
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
mongoose.connection.db = { admin: () => ({ command: async () => ({}) }) };
test.beforeEach(t => { t.mock.method(AnnualOfficer, 'find', () => query([])); });
// Linking writes and district conflict flows are covered in location-link.test.js.
const id = () => new mongoose.Types.ObjectId();
const query = value => ({ session() { return this; }, populate() { return this; }, select() { return this; }, sort() { return this; }, lean() { return Promise.resolve(value); }, distinct() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });

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
    if (!filter.$or) return query([]);
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

test('班長自身のプロフィール世帯を表示し、台帳への紐付け候補は残す', async t => {
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
  assert.equal(result.members.length, 1);
  assert.equal(result.linkableHouseholds.length, 0);
});

for (const allowed of [true, false]) test(`会員紐付け解除（${allowed ? '担当班' : '担当外を拒否'}）`, async t => {
  const original = id(), user = id(), previousDistrict = id();
  const household = { _id: id(), feeRepresentative: user, save: t.mock.fn() };
  const membership = { household: household._id, ledgerPreviousHousehold: original, ledgerPreviousDistrictGroup: previousDistrict, save: t.mock.fn() };
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
  assert.equal(membership.districtGroup, previousDistrict);
  assert.equal(membership.ledgerPreviousDistrictGroup, undefined);
  assert.equal(membership.ledgerPreviousHousehold, undefined);
  assert.equal(household.feeRepresentative, undefined);
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

test('担当班と会員の所属班が異なる班長自身も紐付け候補になる', async t => {
  const user = id(), assignedDistrict = id(), residenceDistrict = id(), freeHousehold = id();
  t.mock.method(AnnualLeaderAssignment, 'find', () => query([assignedDistrict]));
  t.mock.method(NeighborhoodAssociation, 'findById', () => query({}));
  t.mock.method(DistrictGroup, 'find', () => query([]));
  t.mock.method(Household, 'find', filter => query(filter.districtGroup ? [{ _id: freeHousehold, districtLabel: '08' }] : [{ _id: freeHousehold }]));
  t.mock.method(AssociationMembership, 'find', filter => {
    assert.equal(filter.status, 'active');
    assert.equal(String(filter.association).length, 24);
    assert.equal(filter.$or, undefined);
    return query([{ user: { _id: user }, districtGroup: residenceDistrict, household: { _id: id() } }]);
  });
  const handler = householdsRouter.stack.find(layer => layer.route?.path === '/:associationId/leader/fees').route.stack.at(-1).handle;
  let result;
  await handler({ params: { associationId: String(id()) }, user: { _id: user } }, { render(view, data) { result = data; } }, error => { throw error; });
  assert.equal(result.members[0].user._id, user);
  assert.equal(result.linkableHouseholds[0]._id, freeHousehold);
});

test('家族世帯を台帳に紐付けた後は世帯を二重計上せず、家族会員も候補から除外する', async t => {
  const user = id(), spouse = id(), profile = id(), ledger = id(), free = id();
  const rows = [{ _id: profile, representative: { _id: user } }, { _id: ledger, districtLabel: '08', feeRepresentative: { _id: user }, profileHousehold: profile }, { _id: free, districtLabel: '09' }];
  t.mock.method(AnnualLeaderAssignment, 'find', () => query([id()]));
  t.mock.method(NeighborhoodAssociation, 'findById', () => query({}));
  t.mock.method(DistrictGroup, 'find', () => query([]));
  t.mock.method(Household, 'find', filter => query(filter.districtGroup ? rows : rows.slice(1)));
  t.mock.method(AssociationMembership, 'find', () => query([user, spouse].map(_id => ({ user: { _id }, household: { _id: profile, representative: user } }))));
  const handler = householdsRouter.stack.find(layer => layer.route?.path === '/:associationId/leader/fees').route.stack.at(-1).handle;
  let data;
  await handler({ params: { associationId: String(id()) }, user: { _id: user } }, { render(view, values) { data = values; } }, error => { throw error; });
  assert.deepEqual(data.households.map(item => item._id), [ledger, free]);
  assert.deepEqual(data.linkableHouseholds.map(item => item._id), [free]);
  assert.equal(data.members.length, 0);
  assert.deepEqual(data.leaderHouseholdIds, [String(ledger)]);
});

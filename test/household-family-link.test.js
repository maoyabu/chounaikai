import { AnnualOfficer } from '../src/models/annualOfficer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import fs from 'node:fs';
import ejs from 'ejs';
import { linkHouseholdLedger } from '../src/services/householdLedgerLinkService.js';
import { householdsRouter } from '../src/routes/households.js';
import { Household, HouseholdMember, DistrictGroup } from '../src/models/organization.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { JoinApplication, WithdrawalApplication } from '../src/models/workflow.js';

mongoose.connection.db = { admin: () => ({ command: async () => ({}) }) };
const id = () => new mongoose.Types.ObjectId();
const query = value => ({ session() { return this; }, populate() { return this; }, select() { return this; }, sort() { return this; }, lean() { return Promise.resolve(value); }, distinct() { return Promise.resolve(value); } });

test('台帳との紐付けで家族の所属世帯IDを上書きせず、世帯全員の班を揃える', async t => {
  const association = id(), profile = id(), district = id(), oldDistrict = id(), head = id();
  const family = Array.from({ length: 4 }, () => ({ _id: id(), household: profile }));
  const residentIds = [id(), id()];
  const membership = { _id: id(), user: head, household: profile, districtGroup: oldDistrict, save: t.mock.fn() };
  const ledger = { _id: id(), districtGroup: district, save: t.mock.fn() };
  t.mock.method(Household, 'findOne', filter => { assert.equal(filter.association, association); return query({ _id: profile, representative: head, districtGroup: oldDistrict }); });
  t.mock.method(Household, 'updateOne', (filter, change) => { assert.equal(filter._id, profile); assert.equal(change.$set.districtGroup, district); return Promise.resolve({ matchedCount: 1 }); });
  t.mock.method(AssociationMembership, 'find', filter => { assert.equal(filter.household, profile); return query(residentIds.map(_id => ({ _id, household: profile, districtGroup: oldDistrict }))); });
  t.mock.method(AssociationMembership, 'updateMany', (filter, change) => {
    assert.deepEqual(filter._id.$in, residentIds);
    assert.equal(filter.association, association);
    assert.equal(filter.household, profile);
    assert.deepEqual(change, { $set: { districtGroup: district } });
    return Promise.resolve({ matchedCount: 2 });
  });
  t.mock.method(HouseholdMember, 'updateMany', () => { throw new Error('家族を別の世帯へ移動してはいけない'); });
  await linkHouseholdLedger({ associationId: association, membership, household: ledger });
  assert.equal(membership.household, profile);
  assert.equal(ledger.profileHousehold, profile);
  assert.equal(ledger.feeRepresentative, head);
  assert.equal(family.filter(member => member.household === membership.household).length, 4);
});

test('紐付け保存に失敗した場合は所属世帯と家族会員の班を元に戻す', async t => {
  const association = id(), profile = id(), district = id(), oldDistrict = id();
  const membership = { _id: id(), user: id(), household: profile, districtGroup: oldDistrict, save: t.mock.fn() };
  const ledger = { _id: id(), districtGroup: district, save: async () => { throw new Error('save failed'); } };
  const resident = { _id: id(), household: profile, districtGroup: oldDistrict };
  t.mock.method(Household, 'findOne', () => query({ _id: profile, districtGroup: oldDistrict }));
  const profileChanges = t.mock.method(Household, 'updateOne', () => Promise.resolve({ matchedCount: 1 }));
  t.mock.method(AssociationMembership, 'find', () => query([resident]));
  t.mock.method(AssociationMembership, 'updateMany', () => Promise.resolve({ matchedCount: 1 }));
  const restored = t.mock.method(AssociationMembership, 'updateOne', () => Promise.resolve({ matchedCount: 1 }));
  await assert.rejects(linkHouseholdLedger({ associationId: association, membership, household: ledger }), /save failed/);
  assert.equal(membership.household, profile);
  assert.equal(membership.districtGroup, oldDistrict);
  assert.equal(profileChanges.mock.calls.at(-1).arguments[1].$set.districtGroup, oldDistrict);
  assert.equal(restored.mock.calls[0].arguments[1].$set.districtGroup, oldDistrict);
});

for (const familySize of [4, 0]) test(`班のメンバーは家族情報${familySize}件を参照し、人数と家族一覧を表示する`, async t => {
  t.mock.method(AnnualOfficer, 'find', () => query([]));
  const association = id(), profile = id(), district = id(), head = id();
  const memberships = [{ household: profile, user: { _id: head, displayname: '世帯主' } }];
  const family = Array.from({ length: familySize }, (_, n) => ({ _id: id(), household: profile, user: n === 0 ? head : undefined, isRepresentative: n === 0, name: `家族${n + 1}`, nameKana: 'かぞく', gender: 'unspecified' }));
  t.mock.method(AnnualLeaderAssignment, 'find', () => query([district]));
  t.mock.method(NeighborhoodAssociation, 'findById', () => query({ _id: association, name: '町内会' }));
  t.mock.method(DistrictGroup, 'find', () => query([{ _id: district, name: '８班' }]));
  t.mock.method(JoinApplication, 'find', () => query([]));
  t.mock.method(WithdrawalApplication, 'find', () => query([]));
  t.mock.method(AssociationMembership, 'find', () => query(memberships));
  t.mock.method(Household, 'find', filter => {
    if (!filter._id) return query([]);
    assert.deepEqual(filter._id.$in, [profile]);
    return query([{ _id: profile, displayName: '世帯', representative: { _id: head }, districtGroup: { name: '８班' } }]);
  });
  t.mock.method(HouseholdMember, 'find', filter => {
    assert.equal(filter.association, String(association));
    assert.deepEqual(filter.household.$in, [profile]);
    assert.equal(filter.endsAt, null);
    return query(family);
  });
  const handler = householdsRouter.stack.find(layer => layer.route?.path === '/:associationId/leader').route.stack.at(-1).handle;
  let data;
  await handler({ params: { associationId: String(association) }, user: { _id: head } }, { render(view, values) { data = values; } }, error => { throw error; });
  assert.equal(data.membersByHousehold[String(profile)].length, familySize || 1);
  const template = fs.readFileSync('src/views/leader-dashboard.ejs', 'utf8').replace(/<%- include\('partials\/(?:head|header|foot)'\) %>/g, '');
  const html = ejs.render(template, { ...data, notice: null, csrfToken: 'test' }, { filename: `${process.cwd()}/src/views/leader-dashboard.ejs` });
  assert.ok(html.includes(`${familySize || 1}人世帯`));
  if (familySize) for (const member of family) assert.ok(html.includes(member.name));
});

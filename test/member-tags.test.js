import test from 'node:test';
import assert from 'node:assert/strict';
import { Household } from '../src/models/organization.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { loadMemberTags } from '../src/services/memberTagService.js';
const query = rows => ({ select() { return this; }, populate() { return this; }, lean: async () => rows });

test('役職の紐付けと台帳の紐付けを別々に判定し、家族世帯にも台帳の紐付けを適用する', async t => {
  t.mock.method(Household, 'find', () => query([{ _id: 'ledger', feeRepresentative: 'resident', profileHousehold: 'family' }]));
  t.mock.method(AnnualOfficer, 'find', filter => {
    assert.equal(filter.cancelledAt, null);
    return query([{ user: 'officer', role: { name: '会長' } }, { user: 'resident' }]);
  });
  t.mock.method(AnnualLeaderAssignment, 'find', () => query([{ representative: 'officer' }]));
  const tags = await loadMemberTags('association');
  assert.equal(tags.isLinked('officer', 'other'), false);
  assert.equal(tags.isLinked('resident'), true);
  assert.equal(tags.isLinked('spouse', 'family'), true);
  assert.equal(tags.isLinked(undefined, undefined), false);
  assert.deepEqual(tags.roles([{ _id: 'officer' }]), ['会長', '班長']);
  assert.deepEqual(tags.roles(['resident']), ['一般役員']);
  assert.deepEqual(tags.roles(['stranger']), []);
});

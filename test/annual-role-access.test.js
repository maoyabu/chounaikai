import test from 'node:test';
import assert from 'node:assert/strict';
import { annualRoleYears, uniqueAnnualMenuRoles } from '../src/lib/annualRoleAccess.js';
import { loadQuestionBoxAccess } from '../src/services/questionBoxService.js';
import { loadLeaderDistrictIds } from '../src/services/householdParticipationService.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { RoleDefinition } from '../src/models/role.js';

const dates = [
  ['2026-03-31T23:59:59+09:00', [2025]],
  ['2026-04-01T00:00:00+09:00', [2026, 2025]],
  ['2026-04-30T23:59:59+09:00', [2026, 2025]],
  ['2026-05-01T00:00:00+09:00', [2026]],
  ['2027-01-01T00:00:00+09:00', [2026]]
];
test('handover starts and ends at Japan midnight, and excludes future assignments', () => {
  for (const [date, years] of dates) assert.deepEqual(annualRoleYears(new Date(date)), years);
});
test('continuing menu roles appear once with current-year details', () => {
  const current = { association: 'a', fiscalYear: 2026, role: '新役職' };
  const previous = { association: 'a', fiscalYear: 2025, role: '旧役職' };
  assert.deepEqual(uniqueAnnualMenuRoles([current, previous], row => row.association), [current]);
});
test('officer access and leader district scope both expire after April', async t => {
  const id = '507f1f77bcf86cd799439011';
  const query = value => ({ lean: async () => value, select() { return this; } });
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: id }));
  t.mock.method(AssociationMembership, 'findOne', () => query({ status: 'active' }));
  t.mock.method(RoleDefinition, 'find', () => query([]));
  t.mock.method(AnnualOfficer, 'exists', async filter => filter.fiscalYear.$in.includes(2025) ? { _id: id } : null);
  t.mock.method(AnnualLeaderAssignment, 'find', filter => ({ distinct: async () => filter.fiscalYear.$in.includes(2025) ? ['previous-district'] : [] }));
  for (const [date, years] of dates.slice(1, 4)) {
    const now = new Date(date);
    const access = await loadQuestionBoxAccess({ associationId: id, userId: id, now });
    assert.equal(access.canAnswer, years.includes(2025));
    assert.deepEqual(await loadLeaderDistrictIds(id, id, now), years.includes(2025) ? ['previous-district'] : []);
  }
});

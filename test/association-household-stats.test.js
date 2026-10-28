import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAssociationHouseholds } from '../src/services/associationPublicPageService.js';

test('district totals include child groups and count the full household roster without double counting association totals', () => {
  const stats = summarizeAssociationHouseholds([
    { _id: 'east', name: '東地区' },
    { _id: 'west', name: '西地区' },
    { _id: 'one', name: '1班', parentDistrict: 'east' },
    { _id: 'two', name: '東地区2班', parentDistrict: 'east' },
    { _id: 'empty', name: '1班', parentDistrict: 'west' }
  ], [
    { _id: 'h1', districtGroup: 'one' },
    { _id: 'h2', districtGroup: 'one' },
    { _id: 'h3', districtGroup: 'two' },
    { _id: 'legacy', districtGroup: 'east' },
    { _id: 'unlinked', districtGroup: 'west' }
  ], [
    { _id: 'h1', count: 4 }, { _id: 'h2', count: 2 }, { _id: 'h3', count: 3 }, { _id: 'legacy', count: 1 }
  ]);
  assert.equal(stats.householdCount, 5);
  assert.equal(stats.residentCount, 10);
  assert.deepEqual(stats.districtStats, [
    { name: '東地区', householdCount: 4, residentCount: 10 },
    { name: '東地区 1班', householdCount: 2, residentCount: 6 },
    { name: '東地区2班', householdCount: 1, residentCount: 3 },
    { name: '西地区', householdCount: 1, residentCount: 0 },
    { name: '西地区 1班', householdCount: 0, residentCount: 0 }
  ]);
});

test('legacy districts without child groups keep their existing roster counts', () => {
  assert.deepEqual(summarizeAssociationHouseholds([{ _id: 'old', name: '旧1班' }], [{ _id: 'home', districtGroup: 'old' }], [{ _id: 'home', count: 3 }]), {
    districtStats: [{ name: '旧1班', householdCount: 1, residentCount: 3 }], householdCount: 1, residentCount: 3
  });
});

test('unassigned households remain in association totals and empty locations show zero', () => {
  assert.deepEqual(summarizeAssociationHouseholds([{ _id: 'empty', name: '1班' }], [{ _id: 'home', districtGroup: 'removed' }], [{ _id: 'home', count: 2 }]), {
    districtStats: [{ name: '1班', householdCount: 0, residentCount: 0 }], householdCount: 1, residentCount: 2
  });
  assert.deepEqual(summarizeAssociationHouseholds([], [], []), { districtStats: [], householdCount: 0, residentCount: 0 });
});

test('PR page loads child groups and uses active non-deleted households and current roster members for both totals', async t => {
  const { loadAssociationPageData } = await import('../src/services/associationPublicPageService.js');
  const { DistrictGroup, Household, HouseholdMember } = await import('../src/models/organization.js');
  const { AnnualOfficer } = await import('../src/models/annualOfficer.js');
  const { AnnualDepartmentPlan } = await import('../src/models/annualDepartmentPlan.js');
  const { AssociationEvent } = await import('../src/models/associationEvent.js');
  const { AssociationGroup } = await import('../src/models/associationGroup.js');
  const { GoodPlace } = await import('../src/models/goodPlace.js');
  const { DisclosureConsent } = await import('../src/models/disclosureConsent.js');
  const { AssociationMembership } = await import('../src/models/associationMembership.js');
  const association = { _id: '507f1f77bcf86cd799439011' };
  const query = rows => {
    const result = { sort: () => result, select: () => result, populate: () => result, lean: async () => rows };
    return result;
  };
  for (const model of [AnnualOfficer, AnnualDepartmentPlan, AssociationEvent, AssociationGroup, GoodPlace, DisclosureConsent, AssociationMembership]) t.mock.method(model, 'find', () => query([]));
  t.mock.method(DistrictGroup, 'find', filter => {
    assert.deepEqual(filter, { association: association._id, active: true });
    return query([{ _id: 'district', name: '東地区' }, { _id: 'group', name: '1班', parentDistrict: 'district' }]);
  });
  t.mock.method(Household, 'find', filter => {
    assert.deepEqual(filter, { association: association._id, active: true, deletedAt: { $exists: false } });
    return query([{ _id: 'home', districtGroup: 'group' }]);
  });
  t.mock.method(HouseholdMember, 'aggregate', pipeline => {
    assert.deepEqual(pipeline[0].$match, { association: association._id, household: { $in: ['home'] }, endsAt: null });
    // Household roster includes family members without a login account.
    assert.equal('user' in pipeline[0].$match, false);
    return Promise.resolve([{ _id: 'home', count: 4 }]);
  });
  const page = await loadAssociationPageData(association);
  assert.equal(page.householdCount, 1);
  assert.equal(page.residentCount, 4);
  assert.deepEqual(page.districtStats, [
    { name: '東地区', householdCount: 1, residentCount: 4 },
    { name: '東地区 1班', householdCount: 1, residentCount: 4 }
  ]);
});

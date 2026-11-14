import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mobileCommunityInfoRouter } from '../src/routes/mobileCommunityInfo.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { AnnualDepartmentPlan } from '../src/models/annualDepartmentPlan.js';
import { DistrictGroup, Household, HouseholdMember } from '../src/models/organization.js';
import { DisclosureConsent } from '../src/models/disclosureConsent.js';
import { RoleAssignment } from '../src/models/role.js';
import { currentFiscalYear } from '../src/services/officerDisclosureService.js';
const aid = 'aaaaaaaaaaaaaaaaaaaaaaaa', uid = 'bbbbbbbbbbbbbbbbbbbbbbbb', oid = 'cccccccccccccccccccccccc';
const q = value => ({ select() { return this; }, populate() { return this; }, sort() { return this; }, lean: async () => value });
async function start(t) {
  const app = express();
  app.use((req, _res, next) => { req.user = { _id: uid }; req.isAuthenticated = () => req.get('x-auth') !== 'no'; next(); });
  app.use('/api/associations', mobileCommunityInfoRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return headers => fetch(`http://127.0.0.1:${server.address().port}/api/associations/${aid}/community-info`, { headers });
}
function fixture(t, consent = false) {
  const policy = { photo: 'residents', name: 'residents', address: 'private', phone: 'private', email: 'private' };
  t.mock.method(NeighborhoodAssociation, 'findOne', filter => { assert.equal(filter.status, 'active'); assert.equal(filter._id, aid); return q({ _id: aid, name: '町内会', officerDisclosurePolicy: policy }); });
  t.mock.method(AssociationMembership, 'exists', async filter => { assert.equal(filter.user, uid); assert.equal(filter.status, 'active'); return true; });
  t.mock.method(AssociationMembership, 'find', () => q([{ user: oid }]));
  t.mock.method(RoleAssignment, 'find', () => q([]));
  t.mock.method(AnnualOfficer, 'exists', async () => false);
  t.mock.method(AnnualOfficer, 'find', filter => {
    assert.equal(filter.association, aid); assert.equal(filter.fiscalYear, currentFiscalYear()); assert.equal(filter.cancelledAt, null);
    return q([{ _id: 'officer', fiscalYear: currentFiscalYear(), name: '役員氏名', address: '秘密住所', phone: '秘密電話', mobilePhone: '秘密携帯',
      user: { _id: oid, displayname: '役員氏名', email: 'secret@example.test', avatar: '/photo.png', hash: 'secret-hash' },
      role: { name: '部長' }, department: { _id: 'dep', name: '防災部' }, districtGroup: { name: 'A班' } }]);
  });
  t.mock.method(DisclosureConsent, 'find', () => q(consent ? [{ user: oid, confirmedAt: new Date(), fiscalYear: currentFiscalYear(), scopes: policy }] : []));
  t.mock.method(AnnualDepartmentPlan, 'find', filter => { assert.equal(filter.fiscalYear, currentFiscalYear()); return q([{ _id: 'plan', department: { _id: 'dep', name: '防災部' }, goal: '防災訓練', report: '非表示の実施報告' }]); });
  t.mock.method(DistrictGroup, 'find', () => q([{ _id: 'district', name: 'A地区' }, { _id: 'child', parentDistrict: 'district', name: '1班' }]));
  t.mock.method(Household, 'find', filter => { assert.equal(filter.active, true); return q([{ _id: 'h', districtGroup: 'child' }]); });
  t.mock.method(HouseholdMember, 'aggregate', async pipeline => { assert.equal(pipeline[0].$match.endsAt, null); return [{ _id: 'h', count: 3 }]; });
}
test('community browsing requires login and membership before returning data', async t => {
  const request = await start(t); fixture(t);
  assert.equal((await request({ 'x-auth': 'no' })).status, 401);
  AssociationMembership.exists.mock.mockImplementation(async () => false);
  assert.equal((await request()).status, 404);
});
test('unconsented officers are redacted in both directory and department goals', async t => {
  const request = await start(t); fixture(t);
  const response = await request(); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
  const result = await response.json();
  assert.equal(result.fiscalYear, currentFiscalYear());
  assert.equal(result.plans[0].goal, '防災訓練'); assert.equal(result.plans[0].officers[0].displayLabel, '部長担当');
  assert.equal(result.officers[0].name, ''); assert.equal(result.officers[0].avatar, ''); assert.equal(result.officers[0].district, '');
  assert.doesNotMatch(JSON.stringify(result), /秘密|secret|役員氏名|非表示の実施報告/);
});
test('current resident consent reveals only approved fields and household totals include accountless family', async t => {
  const request = await start(t); fixture(t, true);
  const result = await (await request()).json();
  assert.equal(result.officers[0].name, '役員氏名'); assert.equal(result.officers[0].avatar, '/photo.png');
  assert.equal(result.officers[0].email, ''); assert.equal(result.officers[0].address, ''); assert.equal(result.officers[0].phone, '');
  assert.equal(result.householdCount, 1); assert.equal(result.residentCount, 3);
  assert.deepEqual(result.districtStats.map(({ name, householdCount, residentCount }) => ({ name, householdCount, residentCount })), [
    { name: 'A地区', householdCount: 1, residentCount: 3 }, { name: 'A地区 1班', householdCount: 1, residentCount: 3 }
  ]);
  assert.equal(new Set(result.districtStats.map(row => row.id)).size, 2);
});

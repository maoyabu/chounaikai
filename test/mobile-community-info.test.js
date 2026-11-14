import ejs from 'ejs';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { webRouter } from '../src/routes/web.js';
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
  t.mock.method(AnnualLeaderAssignment, 'exists', async filter => { assert.equal(filter.association, aid); assert.equal(filter.representative, uid); assert.equal(filter.cancelledAt, null); return false; });
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
  assert.equal(result.canViewOfficerDirectory, false); assert.deepEqual(result.officers, []);
  assert.doesNotMatch(JSON.stringify(result), /秘密|secret|役員氏名|非表示の実施報告/);
});
test('current resident consent reveals only approved fields and household totals include accountless family', async t => {
  const request = await start(t); fixture(t, true);
  const result = await (await request()).json();
  assert.equal(result.canViewOfficerDirectory, false); assert.deepEqual(result.officers, []);
  assert.equal(result.plans[0].officers[0].displayLabel, '役員氏名');
  assert.equal(result.householdCount, 1); assert.equal(result.residentCount, 3);
  assert.deepEqual(result.districtStats.map(({ name, householdCount, residentCount }) => ({ name, householdCount, residentCount })), [
    { name: 'A地区', householdCount: 1, residentCount: 3 }, { name: 'A地区 1班', householdCount: 1, residentCount: 3 }
  ]);
  assert.equal(new Set(result.districtStats.map(row => row.id)).size, 2);
});

test('current officers, managers and leaders may view the directory; former leaders cannot', async t => {
  const request = await start(t); fixture(t, true);
  AnnualOfficer.exists.mock.mockImplementation(async () => true);
  let result = await (await request()).json();
  assert.equal(result.canViewOfficerDirectory, true); assert.equal(result.officers.length, 1);
  AnnualOfficer.exists.mock.mockImplementation(async () => false);
  RoleAssignment.find.mock.mockImplementation(() => q([{ role: { name: '管理者' } }]));
  result = await (await request()).json(); assert.equal(result.canViewOfficerDirectory, true);
  RoleAssignment.find.mock.mockImplementation(() => q([]));
  AnnualLeaderAssignment.exists.mock.mockImplementation(async filter => {
    assert.equal(filter.association, aid); assert.equal(filter.representative, uid);
    assert.equal(filter.cancelledAt, null); assert.ok(filter.fiscalYear.$in.includes(currentFiscalYear())); return true;
  });
  result = await (await request()).json(); assert.equal(result.canViewOfficerDirectory, true); assert.equal(result.officers.length, 1);
  assert.equal(result.officers[0].address, ''); assert.equal(result.officers[0].email, '');
  AnnualLeaderAssignment.exists.mock.mockImplementation(async () => false);
  result = await (await request()).json(); assert.equal(result.canViewOfficerDirectory, false); assert.deepEqual(result.officers, []);
});
test('Web direct officer URL denies ordinary residents and allows current leaders', async t => {
  fixture(t, true);
  t.mock.method(AssociationMembership, 'findOne', () => q({ user: uid }));
  const handler = webRouter.stack.find(layer => layer.route?.path === '/associations/:associationId/officers').route.stack.at(-1).handle;
  const req = { params: { associationId: aid }, query: {}, user: { _id: uid } };
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, set() { return this; }, render(view, data) { this.view = view; this.data = data; return this; } });
  const denied = response(); await handler(req, denied, error => { throw error; });
  assert.equal(denied.statusCode, 403); assert.equal(AnnualOfficer.find.mock.callCount(), 0);
  AnnualLeaderAssignment.exists.mock.mockImplementation(async () => true);
  const allowed = response(); await handler(req, allowed, error => { throw error; });
  assert.equal(allowed.statusCode, 200); assert.equal(allowed.view, 'association-public-officers'); assert.equal(allowed.data.officers.length, 1);
});

test('Web association summary hides the directory and its link unless explicitly authorized', async () => {
  const locals = { association: { _id: aid, name: '町内会', optionalFeatures: {} }, isResidentPage: true,
    currentUser: { _id: uid }, fiscalYear: currentFiscalYear(), householdCount: 0, residentCount: 0,
    departmentPlans: [], officers: [], districtStats: [] };
  const hidden = await ejs.renderFile('src/views/partials/association-page-content.ejs', { ...locals, canViewOfficerDirectory: false });
  assert.doesNotMatch(hidden, /年度の町内会役員|役員の一覧を見る/);
  const visible = await ejs.renderFile('src/views/partials/association-page-content.ejs', { ...locals, canViewOfficerDirectory: true });
  assert.match(visible, /年度の町内会役員/); assert.match(visible, /役員の一覧を見る/);
});

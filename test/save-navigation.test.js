import test from 'node:test';
import assert from 'node:assert/strict';
import { managementRouter } from '../src/routes/management.js';
import { associationFinanceRouter } from '../src/routes/associationFinance.js';
import { documentsRouter } from '../src/routes/documents.js';
import { associationEventsRouter } from '../src/routes/associationEvents.js';
import { associationGroupsRouter } from '../src/routes/associationGroups.js';
import { webRouter } from '../src/routes/web.js';
import { disclosureRouter } from '../src/routes/disclosure.js';
import { siteSecurityRouter } from '../src/routes/siteSecurity.js';
import { NotificationSettings } from '../src/models/notificationSettings.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { Department, Household, HouseholdMember } from '../src/models/organization.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleDefinition } from '../src/models/role.js';
import { DriveConnection } from '../src/models/driveConnection.js';
import { AssociationGroup, AssociationGroupMembership } from '../src/models/associationGroup.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { FinanceBudget } from '../src/models/financeBudget.js';
import { AuditLog } from '../src/models/auditLog.js';
import { User } from '../src/models/user.js';
import { PasswordReset } from '../src/models/passwordReset.js';
import { DisclosureConsent } from '../src/models/disclosureConsent.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { defaultPolicy } from '../src/services/disclosurePolicy.js';
const id = '123456789012345678901234', userId = '223456789012345678901234';
const invoke = async (router, path, { body = {}, params = {}, extra = {} } = {}) => {
  const handler = router.stack.find(layer => layer.route?.path === path && layer.route.methods.post)?.route.stack.at(-1).handle;
  assert.ok(handler, path);
  const req = { body, params: { associationId: id, ...params }, session: {}, user: { _id: userId, toObject: () => ({}) }, get: () => undefined, ...extra };
  const res = { statusCode: 200, redirect(url) { this.location = url; }, json(value) { this.data = value; }, status(code) { this.statusCode = code; return this; }, render(view, locals) { this.view = view; this.locals = locals; } };
  let error; await handler(req, res, failure => { error = failure; });
  return { req, res, error };
};
const chain = value => ({ lean: async () => value, select: () => chain(value), sort: () => chain(value), then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) });
const stubAudit = t => t.mock.method(AuditLog, 'create', async () => ({}));

test('notification settings save channels and return to management with a completion notice', async t => {
  let saved;
  t.mock.method(NotificationSettings, 'findOneAndUpdate', async (...args) => { saved = args; });
  const { res, req, error } = await invoke(managementRouter, '/:associationId/manage/notifications', { body: { join_push: 'on', join_email: 'on' } });
  assert.equal(error, undefined); assert.equal(saved[0].association, id);
  assert.deepEqual(saved[1].$set.channels.join, { push: true, email: true });
  assert.equal(res.location, `/associations/${id}/manage`); assert.ok(req.session.notice);
});
test('failed notification save never reports completion or navigates back', async t => {
  t.mock.method(NotificationSettings, 'findOneAndUpdate', async () => { throw new Error('save failed'); });
  const { res, req, error } = await invoke(managementRouter, '/:associationId/manage/notifications');
  assert.equal(error.message, 'save failed'); assert.equal(res.location, undefined); assert.equal(req.session.notice, undefined);
});
test('basic information and organization updates return to management only after saving', async t => {
  const record = { _id: id, name: '旧名称', save: async () => {} };
  t.mock.method(NeighborhoodAssociation, 'findById', async () => record); stubAudit(t);
  const result = await invoke(managementRouter, '/:associationId/manage/name', { body: { name: '新名称' } });
  assert.equal(result.error, undefined); assert.equal(record.name, '新名称'); assert.equal(result.res.location, `/associations/${id}/manage`);
  t.mock.method(Department, 'findOne', async () => record);
  const department = await invoke(managementRouter, '/:associationId/manage/departments/:itemId/update', { params: { itemId: id }, body: { name: '総務部' } });
  assert.equal(department.error, undefined); assert.equal(department.res.location, `/associations/${id}/manage`);
});
for (const [kind, routerPath, Model, recordKey] of [
  ['officers', '/:associationId/manage/annual/officers/:officerId/update', AnnualOfficer, 'officerId'],
  ['leaders', '/:associationId/manage/annual/leaders/:leaderId/update', AnnualLeaderAssignment, 'leaderId']
]) {
  test(`${kind} dialog returns to its source list; arbitrary return URLs cannot redirect externally`, async t => {
    t.mock.method(Model, 'findOne', async () => ({ _id: id, fiscalYear: 2026, save: async () => {} }));
    t.mock.method(Department, 'findOne', async () => ({ _id: id })); stubAudit(t);
    for (const returnTo of [kind, 'annual', 'https://external.invalid/']) {
      const result = await invoke(managementRouter, routerPath, { params: { [recordKey]: id }, body: { returnTo, departmentId: id } });
      assert.equal(result.error, undefined);
      assert.equal(result.res.location, `/associations/${id}/manage${returnTo === kind || returnTo === 'annual' ? `/${returnTo}?year=2026` : ''}`);
    }
  });
}
test('finance settings save and return to the finance top', async t => {
  let writes = 0; t.mock.method(NeighborhoodAssociation, 'updateOne', async () => { writes++; });
  const result = await invoke(associationFinanceRouter, '/:associationId/finance/settings', { extra: { financeContext: { association: { _id: id } } }, body: { paymentName: ['現金'], paymentActive: ['0'] } });
  assert.equal(result.error, undefined); assert.equal(writes, 1); assert.equal(result.res.location, `/associations/${id}/finance`); assert.ok(result.req.session.notice);
});
test('budget save and AJAX copy return to finance top with the chosen year', async t => {
  t.mock.method(FinanceBudget, 'deleteMany', async () => {});
  t.mock.method(FinanceBudget, 'insertMany', async () => {});
  const extra = { financeContext: { association: { _id: id }, groupId: id, year: 2026 } };
  const budget = await invoke(associationFinanceRouter, '/:associationId/finance/settings/budgets', { extra, body: { year: '2027', itemName: ['会費'], itemCf: ['収入'], itemBudget: ['1000'] } });
  assert.equal(budget.error, undefined); assert.equal(budget.res.location, `/associations/${id}/finance?year=2027`);
  t.mock.method(FinanceBudget, 'find', () => chain([{ year: '2026', cf: '収入' }]));
  t.mock.method(FinanceBudget, 'exists', async () => false);
  const copy = await invoke(associationFinanceRouter, '/:associationId/finance/settings/budgets/copy', { extra, body: { sourceYear: '2026', targetYear: '2027' } });
  assert.equal(copy.error, undefined); assert.equal(copy.res.data.redirect, `/associations/${id}/finance?year=2027`);
});
test('profile update finishes on home; invalid input retains the edit form', async t => {
  t.mock.method(User, 'exists', async () => false); t.mock.method(User, 'updateOne', async () => {});
  t.mock.method(HouseholdMember, 'find', () => ({ distinct: async () => [] }));
  t.mock.method(HouseholdMember, 'updateMany', async () => {}); t.mock.method(Household, 'updateMany', async () => {});
  const result = await invoke(webRouter, '/profile', { body: { displayname: '本人', email: 'user@example.invalid' } });
  assert.equal(result.error, undefined); assert.equal(result.res.location, '/dashboard'); assert.ok(result.req.session.notice);
  const invalid = await invoke(webRouter, '/profile', { body: { email: 'invalid' } });
  assert.equal(invalid.res.location, undefined); assert.equal(invalid.res.view, 'profile'); assert.equal(invalid.res.statusCode, 400);
});
test('password success returns home; incorrect password keeps correction on profile', async t => {
  const user = { hash: 'old', salt: 'old', authenticate: async password => ({ user: password === 'old-password' ? {} : null }), setPassword(password, callback) { this.hash = 'new'; this.salt = 'new'; callback(); } };
  t.mock.method(User, 'findById', () => chain(user)); t.mock.method(User, 'updateOne', async () => ({ matchedCount: 1 })); t.mock.method(PasswordReset, 'deleteOne', async () => {});
  const result = await invoke(webRouter, '/profile/password', { body: { currentPassword: 'old-password', password: 'new-password', passwordConfirmation: 'new-password' } });
  assert.equal(result.error, undefined); assert.equal(result.res.location, '/dashboard');
  const invalid = await invoke(webRouter, '/profile/password', { body: { currentPassword: 'incorrect', password: 'new-password', passwordConfirmation: 'new-password' } });
  assert.equal(invalid.res.location, '/profile?tab=account#password-change'); assert.ok(invalid.req.session.errorMessage);
});
test('personal disclosure returns to profile and policy returns to basic settings', async t => {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => chain({ _id: id, officerDisclosurePolicy: defaultPolicy, officerDisclosureHistory: [] }));
  t.mock.method(AnnualOfficer, 'exists', async () => true); t.mock.method(AssociationMembership, 'exists', async () => true);
  t.mock.method(DisclosureConsent, 'findOneAndUpdate', async () => {}); t.mock.method(NeighborhoodAssociation, 'updateOne', async () => ({ matchedCount: 1 }));
  const own = await invoke(disclosureRouter, '/profile/disclosure/:associationId', { body: { ...defaultPolicy, policyRevision: '0', confirmDisclosure: 'yes' } });
  assert.equal(own.error, undefined); assert.equal(own.res.location, '/profile');
  const policy = await invoke(disclosureRouter, '/associations/:associationId/manage/disclosure', { body: { ...defaultPolicy, policyRevision: '0' } });
  assert.equal(policy.error, undefined); assert.equal(policy.res.location, `/associations/${id}/manage/basic`);
});
test('site security policy returns to administration after successful authenticated save', async () => {
  let saved = false;
  const extra = { app: { locals: { siteSecurityService: { get: async () => ({ revision: '1', mfaEnabled: false }), change: async () => { saved = true; } }, mfaService: { checkPassword: async () => {}, getEnrollmentState: async () => ({ credential: null }) } } } };
  const result = await invoke(siteSecurityRouter, '/admin/security/mfa', { extra, body: { enabled: 'true', revision: '1' } });
  assert.equal(result.error, undefined); assert.equal(saved, true); assert.equal(result.res.location, '/admin');
});

const stubOfficerAccess = t => {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => chain({ _id: id }));
  t.mock.method(AssociationMembership, 'findOne', () => chain({ user: userId }));
  t.mock.method(RoleDefinition, 'find', () => chain([]));
  t.mock.method(AnnualOfficer, 'exists', async () => true);
};
test('Drive settings save and disconnect finish on management without rendering settings again', async t => {
  stubOfficerAccess(t);
  const connection = { clientId: 'example.apps.googleusercontent.com', rootFolderId: 'folder-id', clientSecret: 'already-stored' };
  t.mock.method(DriveConnection, 'findOne', () => chain(connection));
  t.mock.method(DriveConnection, 'findOneAndUpdate', async () => {});
  t.mock.method(DriveConnection, 'updateOne', async () => {});
  const save = await invoke(documentsRouter, '/:associationId/documents/settings', { body: { clientId: connection.clientId, rootFolderId: connection.rootFolderId } });
  assert.equal(save.error, undefined); assert.equal(save.res.location, `/associations/${id}/manage`); assert.equal(save.res.view, undefined);
  const disconnect = await invoke(documentsRouter, '/:associationId/documents/disconnect');
  assert.equal(disconnect.error, undefined); assert.equal(disconnect.res.location, `/associations/${id}/manage`);
});
test('public page edit and group PR edit finish on their management page', async t => {
  const association = { _id: id, publicPhotos: [], save: async () => {} };
  t.mock.method(NeighborhoodAssociation, 'findOne', async () => association);
  const result = await invoke(associationEventsRouter, '/:associationId/public/edit', { body: { introduction: '紹介文' } });
  assert.equal(result.error, undefined); assert.equal(result.res.location, `/associations/${id}/manage`);
  t.mock.method(AssociationGroup, 'findOne', async () => ({ _id: id, association: id, publicPhotos: [], save: async () => {} }));
  t.mock.method(AssociationGroupMembership, 'findOne', async () => ({ role: 'manager' }));
  const group = await invoke(associationGroupsRouter, '/:associationId/groups/:groupId/manage/pr', { params: { groupId: id }, body: { name: 'グループ', publicDescription: '紹介文' } });
  assert.equal(group.error, undefined); assert.equal(group.res.location, `/associations/${id}/groups/${id}/manage`);
});

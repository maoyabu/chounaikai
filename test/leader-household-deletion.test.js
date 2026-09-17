import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { Household, HouseholdMember, DistrictGroup } from '../src/models/organization.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleAssignment } from '../src/models/role.js';
import { Invitation, JoinApplication } from '../src/models/workflow.js';
import { User } from '../src/models/user.js';
import { Group } from '../src/models/group.js';
import { Notification } from '../src/models/notification.js';
import { AuditLog } from '../src/models/auditLog.js';
import { householdsRouter } from '../src/routes/households.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';
import { loadLeaderHouseholdDeletion, deleteLeaderHousehold } from '../src/services/leaderHouseholdDeletionService.js';

const id = () => new mongoose.Types.ObjectId();
const ids = { association: id(), household: id(), district: id(), leader: id(), representative: id(), resident: id(), outsider: id(), group: id(), otherGroup: id() };
const now = new Date('2026-09-14T00:00:00.000Z');
const actor = { _id: ids.leader, displayname: '班長 太郎' };
const association = { _id: ids.association, name: 'テスト町内会', status: 'active', group: ids.group };
const household = { _id: ids.household, association: ids.association, active: true, updatedAt: now, displayName: '山田世帯', districtGroup: { _id: ids.district, name: '1班' }, representative: { _id: ids.representative, displayname: '山田 太郎' }, address: { postalCode: '100-0001', street: '東京都千代田区' } };
const members = [
  { _id: id(), name: '山田 太郎', household: ids.household, user: ids.representative, isRepresentative: true },
  { _id: id(), name: '山田 花子', household: ids.household, user: ids.resident },
  { _id: id(), name: '山田 子ども', household: ids.household }
];
const memberships = [ids.representative, ids.resident].map(user => ({ _id: id(), user, household: ids.household, districtGroup: ids.district, association: ids.association, status: 'active', updatedAt: now }));
const query = (value) => ({
  session() { return this; }, populate() { return this; }, select() { return this; }, sort() { return this; },
  distinct(field) { return Promise.resolve(value.map(item => item[field])); },
  lean() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
});
// Fully stub database access; tests never connect to or delete development data.
mongoose.connection.db = { admin: () => ({ command: async () => ({}) }) };
const stub = (t, Model, method, fn) => t.mock.method(Model, method, fn);
const fixture = (t) => {
  stub(t, NeighborhoodAssociation, 'findOne', () => query(association));
  stub(t, AssociationMembership, 'findOne', () => query({ user: ids.leader, association: ids.association, status: 'active' }));
  stub(t, DistrictGroup, 'find', () => query([{ _id: ids.district, name: '1班', active: true }]));
  stub(t, Household, 'findOne', () => query(household));
  stub(t, HouseholdMember, 'find', () => query(members));
  stub(t, AssociationMembership, 'find', () => query(memberships));
  stub(t, AnnualLeaderAssignment, 'find', filter => query(typeof filter.fiscalYear === 'number' ? [{ _id: id(), districtGroup: ids.district }] : [{ _id: ids.resident, household: ids.household, fiscalYear: 2026 }]));
  stub(t, AnnualOfficer, 'find', () => query([{ _id: ids.representative, user: ids.representative, fiscalYear: 2026 }]));
  stub(t, RoleAssignment, 'find', () => query([{ _id: ids.representative, user: ids.representative, startsAt: new Date('2026-04-01') }]));
  stub(t, Invitation, 'find', () => query([{ _id: ids.resident, household: ids.household, status: 'pending' }]));
  stub(t, JoinApplication, 'find', () => query([{ _id: ids.representative, household: ids.household, status: 'awaiting_household' }]));
  stub(t, Group, 'findById', () => query({ _id: ids.group, members: [ids.leader, ids.representative, ids.resident, ids.outsider] }));
  stub(t, User, 'find', () => query([{ _id: ids.representative, groups: [ids.group, ids.otherGroup], defaultGroup: ids.group }, { _id: ids.resident, groups: [ids.group, ids.otherGroup], defaultGroup: ids.otherGroup }]));
  stub(t, Household, 'updateOne', async () => ({ modifiedCount: 1 }));
  for (const Model of [AssociationMembership, RoleAssignment, AnnualOfficer, AnnualLeaderAssignment, Invitation, JoinApplication]) {
    stub(t, Model, 'updateMany', async () => ({ modifiedCount: 1 }));
    stub(t, Model, 'updateOne', async () => ({ modifiedCount: 1 }));
  }
  stub(t, Group, 'updateOne', async () => ({ modifiedCount: 1 }));
  stub(t, User, 'updateMany', async () => ({ modifiedCount: 1 }));
  stub(t, Notification, 'create', async documents => documents.map(document => ({ _id: id(), ...document })));
  stub(t, Notification, 'deleteMany', async () => ({}));
  stub(t, AuditLog, 'create', async documents => documents.map(document => ({ _id: id(), ...document })));
  stub(t, AuditLog, 'deleteOne', async () => ({}));
};
const load = () => loadLeaderHouseholdDeletion({ associationId: ids.association, householdId: ids.household, actorId: ids.leader, now });
const remove = (fingerprint) => deleteLeaderHousehold({ associationId: ids.association, householdId: ids.household, actor, expectedFingerprint: fingerprint, now });

test('confirmation loading is read-only and limited to current-year assigned districts', async (t) => {
  fixture(t);
  const details = await load();
  assert.equal(details.members.length, 3);
  assert.deepEqual(Household.findOne.mock.calls[0].arguments[0].districtGroup.$in, [ids.district]);
  const permission = AnnualLeaderAssignment.find.mock.calls[0].arguments[0];
  assert.equal(permission.fiscalYear, 2026);
  assert.equal(permission.cancelledAt, null);
  assert.equal(Household.updateOne.mock.callCount(), 0);
  assert.equal(AssociationMembership.updateMany.mock.callCount(), 0);
});

test('non-leaders cannot load a deletion confirmation', async (t) => {
  fixture(t);
  AnnualLeaderAssignment.find.mock.mockImplementation(() => query([]));
  await assert.rejects(load(), error => error.status === 403);
  assert.equal(Household.findOne.mock.callCount(), 0);
});

test('withdrawn members cannot act as a leader even if an old assignment remains', async (t) => {
  fixture(t);
  AssociationMembership.findOne.mock.mockImplementation(() => query(null));
  await assert.rejects(load(), error => error.status === 403);
});

test('other-district, deleted, and moved households cannot be deleted', async (t) => {
  fixture(t);
  Household.findOne.mock.mockImplementation(() => query(null));
  await assert.rejects(remove('fingerprint'), error => error.status === 404);
  assert.equal(Household.updateOne.mock.callCount(), 0);
  assert.equal(User.updateMany.mock.callCount(), 0);
});

test('invalid IDs are rejected before database access', async (t) => {
  fixture(t);
  await assert.rejects(loadLeaderHouseholdDeletion({ associationId: 'invalid', householdId: ids.household, actorId: ids.leader }), error => error.status === 400);
  assert.equal(NeighborhoodAssociation.findOne.mock.callCount(), 0);
});

test('deletion archives the household, withdraws household accounts, and preserves other groups', async (t) => {
  fixture(t);
  const details = await load();
  const result = await remove(details.fingerprint);
  assert.equal(result.removedOwnMembership, false);
  const archive = Household.updateOne.mock.calls[0].arguments[1].$set;
  assert.equal(archive.active, false);
  assert.equal(archive.deletedBy, ids.leader);
  assert.equal(AssociationMembership.updateMany.mock.calls[0].arguments[1].$set.status, 'inactive');
  const removedUsers = Group.updateOne.mock.calls[0].arguments[1].$pull.members.$in;
  assert.deepEqual(removedUsers, [ids.representative, ids.resident]);
  assert.ok(!removedUsers.includes(ids.outsider));
  assert.deepEqual(User.updateMany.mock.calls[0].arguments[1], { $pull: { groups: ids.group } });
  assert.deepEqual(User.updateMany.mock.calls[1].arguments[0]._id.$in, [ids.representative]);
  assert.equal(AuditLog.create.mock.calls[0].arguments[0][0].after.sharedAccountsPreserved, true);
});

test('deleted household invitation/applications and current/future offices are cancelled, not erased', async (t) => {
  fixture(t);
  const details = await load();
  await remove(details.fingerprint);
  assert.equal(Invitation.updateMany.mock.calls[0].arguments[1].$set.status, 'cancelled');
  assert.equal(JoinApplication.updateMany.mock.calls[0].arguments[1].$set.status, 'cancelled');
  assert.equal(AnnualOfficer.find.mock.calls[0].arguments[0].fiscalYear.$gte, 2026);
  assert.equal(AnnualLeaderAssignment.find.mock.calls[1].arguments[0].fiscalYear.$gte, 2026);
  assert.equal(AnnualOfficer.updateMany.mock.calls[0].arguments[1].$set.cancelledAt, now);
  assert.equal(RoleAssignment.updateMany.mock.calls[0].arguments[1].$set.endsAt.getTime(), now.getTime() - 1);
});

test('stale confirmation prevents writes when member data changes', async (t) => {
  fixture(t);
  const details = await load();
  HouseholdMember.find.mock.mockImplementation(() => query([...members, { _id: id(), name: '追加メンバー' }]));
  await assert.rejects(remove(details.fingerprint), error => error.status === 409);
  assert.equal(Household.updateOne.mock.callCount(), 0);
});

test('a concurrent deletion cannot trigger a second removal', async (t) => {
  fixture(t);
  const details = await load();
  Household.updateOne.mock.mockImplementation(async () => ({ modifiedCount: 0 }));
  await assert.rejects(remove(details.fingerprint), error => error.status === 409);
  assert.equal(AssociationMembership.updateMany.mock.callCount(), 0);
  assert.equal(Notification.create.mock.callCount(), 0);
});

test('standalone database failure restores exact records and existing group memberships', async (t) => {
  fixture(t);
  const details = await load();
  AuditLog.create.mock.mockImplementation(async () => { throw new Error('audit_failed'); });
  await assert.rejects(remove(details.fingerprint), /audit_failed/);
  const restoreMembership = AssociationMembership.updateOne.mock.calls[0].arguments;
  assert.equal(restoreMembership[0].endedAt, now);
  assert.equal(restoreMembership[1].$set.status, 'active');
  assert.equal(Household.updateOne.mock.calls.at(-1).arguments[1].$set.active, true);
  assert.deepEqual(Group.updateOne.mock.calls.at(-1).arguments[1].$addToSet.members.$each, [ids.representative, ids.resident]);
  assert.equal(Notification.deleteMany.mock.calls[0].arguments[0]._id.$in.length, 2);
});

test('stale household-member account references cannot revoke another household membership', async (t) => {
  fixture(t);
  const staleMember = { _id: id(), name: '古い紐付け', user: ids.outsider };
  HouseholdMember.find.mock.mockImplementation(() => query([...members, staleMember]));
  const details = await load();
  await remove(details.fingerprint);
  assert.deepEqual(User.updateMany.mock.calls[0].arguments[0]._id.$in, [ids.representative, ids.resident]);
});

const deletionRoute = (method) => householdsRouter.stack.find(layer => layer.route?.path === '/:associationId/leader/households/:householdId/delete' && layer.route.methods[method]).route;

test('deletion POST requires CSRF verification and a prior confirmation token', async () => {
  const route = deletionRoute('post');
  assert.ok(route.stack.some(layer => layer.handle === verifyCsrfToken));
  let error;
  await route.stack.at(-1).handle({ params: { associationId: String(ids.association), householdId: String(ids.household) }, session: {}, body: { confirmDeletion: 'on' } }, {}, value => { error = value; });
  assert.equal(error.status, 400);
});

test('confirmation tokens cannot be reused for a different household or after expiry', async () => {
  const handler = deletionRoute('post').stack.at(-1).handle;
  for (const overrides of [{ householdId: String(id()) }, { expiresAt: 0 }]) {
    let error;
    await handler({ params: { associationId: String(ids.association), householdId: String(ids.household) }, session: { householdDeletionConfirmation: { associationId: String(ids.association), householdId: String(ids.household), token: 'a'.repeat(64), expiresAt: Date.now() + 60000, ...overrides } }, body: { confirmationToken: 'a'.repeat(64), confirmDeletion: 'on' } }, {}, value => { error = value; });
    assert.equal(error.status, 400);
  }
});

test('GET preview issues a token without deleting and successful POST consumes it', async (t) => {
  fixture(t);
  const req = { user: actor, params: { associationId: String(ids.association), householdId: String(ids.household) }, session: {}, body: {} };
  let preview, redirect, error;
  const res = { set() { return this; }, render(name, data) { preview = { name, data }; }, redirect(url) { redirect = url; } };
  const next = value => { error = value; };
  await deletionRoute('get').stack.at(-1).handle(req, res, next);
  assert.equal(error, undefined);
  assert.equal(preview.name, 'leader-household-delete');
  assert.equal(Household.updateOne.mock.callCount(), 0);
  req.body = { confirmationToken: preview.data.confirmationToken, confirmDeletion: 'on' };
  await deletionRoute('post').stack.at(-1).handle(req, res, next);
  assert.equal(error, undefined);
  assert.equal(req.session.householdDeletionConfirmation, undefined);
  assert.equal(redirect, `/associations/${ids.association}/leader?tab=members`);
  await deletionRoute('post').stack.at(-1).handle(req, res, next);
  assert.equal(error.status, 400);
});

test('removing a leader own household returns an outcome suitable for redirecting to home', async (t) => {
  fixture(t);
  AssociationMembership.find.mock.mockImplementation(() => query([{ ...memberships[0], user: ids.leader }, memberships[1]]));
  const details = await load();
  const result = await remove(details.fingerprint);
  assert.equal(result.removedOwnMembership, true);
});

const render = (name, data) => ejs.renderFile(fileURLToPath(new URL(`../src/views/${name}.ejs`, import.meta.url)), { title: 'テスト', csrfToken: 'csrf', notice: null, currentPath: '/', currentUser: actor, ...data });

test('confirmation page shows members, account preservation, cancel and explicit confirmation', async () => {
  const html = await render('leader-household-delete', { association, household, members, confirmationToken: 'token' });
  assert.match(html, /世帯削除の確認/);
  assert.match(html, /山田 子ども/);
  assert.match(html, /共通アカウントや他のグループの所属は削除しません/);
  assert.match(html, /name="confirmDeletion" required/);
  assert.match(html, /name="confirmationToken" value="token"/);
  assert.match(html, /キャンセル/);
  assert.match(html, /method="post"/);
});

test('leader household list links to the confirmation page and can return to household tab', async () => {
  const html = await render('leader-dashboard', { association, districtGroups: [household.districtGroup], fiscalYear: 2026, households: [household], membersByHousehold: { [String(ids.household)]: members }, applications: [] });
  assert.match(html, new RegExp(`href="/associations/${ids.association}/leader/households/${ids.household}/delete"`));
  assert.match(html, /世帯を削除/);
  assert.match(html, /URLSearchParams/);
});

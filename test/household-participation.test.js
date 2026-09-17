import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ejs from 'ejs';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'node:url';
import { Invitation, JoinApplication } from '../src/models/workflow.js';
import { Household, HouseholdMember, DistrictGroup } from '../src/models/organization.js';
import { User } from '../src/models/user.js';
import { Group } from '../src/models/group.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { Notification } from '../src/models/notification.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { AuditLog } from '../src/models/auditLog.js';
import { ResidentRegistration } from '../src/models/residentRegistration.js';
import { PendingUserRegistration } from '../src/models/pendingUserRegistration.js';
import { registerUser } from '../src/services/userService.js';
import { verifyEmailToken, sendHouseholdInvitationEmail } from '../src/services/emailVerificationService.js';
import { householdInvitationsRouter } from '../src/routes/householdInvitations.js';
import { householdsRouter } from '../src/routes/households.js';
import { managementRouter } from '../src/routes/management.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';
import { createHouseholdInvitationToken, digestInvitationToken, parseResidentProfile, loadHouseholdInvitation, acceptHouseholdInvitation, requestHouseholdLink, confirmHouseholdLink, decideJoinApplication } from '../src/services/householdParticipationService.js';

const id = () => new mongoose.Types.ObjectId();
const ids = { association: id(), household: id(), district: id(), head: id(), user: id(), member: id(), invitation: id(), group: id(), application: id() };
const user = { _id: ids.user, displayname: '山田 花子', username: 'hanako', email: 'hanako@example.test' };
const association = { _id: ids.association, name: 'テスト町内会', status: 'active', group: ids.group };
const household = { _id: ids.household, association: ids.association, representative: ids.head, districtGroup: ids.district, displayName: '山田世帯', active: true, address: { postalCode: '100-0001', street: '東京都千代田区' } };
const member = { _id: ids.member, household: ids.household, association: ids.association, name: '山田 花子', nameKana: 'やまだ はなこ', birthDate: new Date('1995-04-01'), gender: 'female', email: user.email, isRepresentative: false };
const invitation = { _id: ids.invitation, association, household: ids.household, householdMember: ids.member, email: user.email, invitedBy: { _id: ids.head, displayname: '山田 太郎' }, status: 'pending', expiresAt: new Date(Date.now() + 86400000) };
const body = { representativeKana: 'やまだ はなこ', birthDate: '1995-04-01', gender: 'female', relationship: '配偶者' };
const query = (value) => ({
  select() { return this; }, populate() { return this; }, sort() { return this; }, collation() { return this; }, session() { return this; },
  lean() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
});
// Database operations are stubbed: never connect to or mutate the developer's database.
mongoose.connection.db = { admin: () => ({ command: async () => ({}) }) };
const stub = (t, model, method, implementation) => t.mock.method(model, method, implementation);
const stubInvitation = (t) => {
  stub(t, AnnualLeaderAssignment, 'find', () => query([]));
  stub(t, Invitation, 'findOne', filter => query(filter.email && filter.email !== user.email ? null : invitation));
  stub(t, Household, 'findOne', () => query({ ...household, districtGroup: { _id: ids.district, name: '1班', active: true } }));
  stub(t, HouseholdMember, 'findOne', () => query(member));
  stub(t, AssociationMembership, 'exists', filter => Promise.resolve(String(filter.user) === String(ids.head) ? { _id: id() } : null));
  stub(t, JoinApplication, 'exists', async () => null);
  stub(t, NeighborhoodAssociation, 'findOne', () => query(association));
  stub(t, ResidentRegistration, 'deleteOne', async () => ({ deletedCount: 1 }));
};
const stubDecision = (t, source = 'household_invitation') => {
  const application = new JoinApplication({ _id: ids.application, association: ids.association, applicant: ids.user, household: ids.household, districtGroup: ids.district, status: 'pending', source, householdMember: ids.member, householdConfirmedBy: ids.head });
  stub(t, Household, 'findOne', () => query(household));
  stub(t, NeighborhoodAssociation, 'findOne', () => query(association));
  stub(t, DistrictGroup, 'findOne', () => query({ _id: ids.district, name: '1班' }));
  stub(t, HouseholdMember, 'exists', async () => ({ _id: ids.member }));
  stub(t, HouseholdMember, 'findOne', () => query({ ...member, user: ids.user }));
  stub(t, HouseholdMember, 'updateOne', async () => ({ modifiedCount: 1 }));
  stub(t, AssociationMembership, 'exists', filter => Promise.resolve(String(filter.user) === String(ids.head) ? { _id: id() } : null));
  stub(t, AssociationMembership, 'findOne', () => query(null));
  stub(t, AssociationMembership, 'findOneAndUpdate', async (_filter, update) => ({ _id: id(), ...update.$set }));
  stub(t, AssociationMembership, 'updateOne', async () => ({ modifiedCount: 1 }));
  stub(t, AssociationMembership, 'deleteOne', async () => ({ deletedCount: 1 }));
  stub(t, Group, 'findById', () => query({ _id: ids.group, members: [ids.head] }));
  stub(t, User, 'findById', () => query({ _id: ids.user, groups: [] }));
  stub(t, Group, 'updateOne', async () => ({ modifiedCount: 1 }));
  stub(t, User, 'updateOne', async () => ({ modifiedCount: 1 }));
  stub(t, JoinApplication, 'findOneAndUpdate', async (_filter, update) => ({ ...application.toObject(), ...update.$set }));
  stub(t, JoinApplication, 'updateOne', async () => ({ modifiedCount: 1 }));
  stub(t, Notification, 'create', async documents => documents.map(document => ({ _id: id(), ...document })));
  stub(t, Notification, 'deleteOne', async () => ({ deletedCount: 1 }));
  stub(t, AuditLog, 'create', async documents => documents.map(document => ({ _id: id(), ...document })));
  stub(t, AuditLog, 'deleteOne', async () => ({ deletedCount: 1 }));
  stub(t, ResidentRegistration, 'deleteOne', async () => ({ deletedCount: 1 }));
  return application;
};

test('invitation token is random, hashed, and valid for seven days', () => {
  const first = createHouseholdInvitationToken(), second = createHouseholdInvitationToken();
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.token, first.tokenDigest);
  assert.equal(first.tokenDigest, digestInvitationToken(first.token));
  assert.ok(Math.abs(first.expiresAt.getTime() - Date.now() - 7 * 86400000) < 1000);
});

test('invitation lookup rejects malformed tokens without a database lookup', async (t) => {
  const lookup = stub(t, Invitation, 'findOne', () => { throw new Error('must_not_query'); });
  assert.equal(await loadHouseholdInvitation({ token: 'invalid' }), null);
  assert.equal(await loadHouseholdInvitation(), null);
  assert.equal(lookup.mock.callCount(), 0);
});

test('invitation lookup requires a pending unexpired invitation and an unlinked member', async (t) => {
  stubInvitation(t);
  const token = createHouseholdInvitationToken().token;
  const result = await loadHouseholdInvitation({ token });
  assert.equal(result.member._id, ids.member);
  assert.equal(Invitation.findOne.mock.calls[0].arguments[0].status, 'pending');
  assert.ok(Invitation.findOne.mock.calls[0].arguments[0].expiresAt.$gt instanceof Date);
  assert.equal(HouseholdMember.findOne.mock.calls[0].arguments[0].user, null);
});

test('expired or cancelled invitations are unavailable', async (t) => {
  stub(t, Invitation, 'findOne', () => query(null));
  assert.equal(await loadHouseholdInvitation({ token: createHouseholdInvitationToken().token }), null);
});

test('resident profile uses the account name and email and validates calendar dates', () => {
  const profile = parseResidentProfile({ ...body, name: '偽名', email: 'other@example.test' }, user);
  assert.equal(profile.name, user.displayname);
  assert.equal(profile.email, user.email);
  assert.throws(() => parseResidentProfile({ ...body, birthDate: '2026-02-30' }, user), /正しく入力/);
  assert.throws(() => parseResidentProfile({ ...body, gender: 'unknown' }, user), /正しく入力/);
});

test('general signup requires a different valid household-head email', async () => {
  for (const email of ['', 'invalid', user.email]) {
    await assert.rejects(registerUser({ username: user.username, email: user.email, password: 'abcdefgh', residentMode: 'general', householdHeadEmail: email }), /invalid_household_head_email/);
  }
});

test('verification transfers household onboarding to an application-specific collection', async (t) => {
  const pending = { _id: id(), username: user.username, email: user.email, displayname: user.displayname, salt: 'salt', hash: 'hash', residentMode: 'general', householdHeadEmail: 'head@example.test', householdInvitation: ids.invitation };
  stub(t, PendingUserRegistration, 'findOne', () => query(pending));
  stub(t, PendingUserRegistration, 'deleteOne', async () => ({}));
  stub(t, User, 'findOne', () => query(null));
  stub(t, User, 'create', async fields => ({ _id: ids.user, ...fields }));
  stub(t, ResidentRegistration, 'findOneAndUpdate', async () => ({}));
  stub(t, Invitation, 'findOne', () => query(null));
  stub(t, console, 'error', () => {});
  const verified = await verifyEmailToken('a'.repeat(64));
  assert.equal(verified._id, ids.user);
  const accountFields = User.create.mock.calls[0].arguments[0];
  assert.equal(accountFields.householdHeadEmail, undefined);
  assert.equal(accountFields.householdInvitation, undefined);
  const onboarding = ResidentRegistration.findOneAndUpdate.mock.calls[0].arguments[1].$set;
  assert.equal(onboarding.householdInvitation, ids.invitation);
  assert.equal(onboarding.householdHeadEmail, 'head@example.test');
  assert.ok(verified.$locals.householdParticipationError);
});

test('invited signup automatically links the household after email verification', async (t) => {
  stubInvitation(t);
  stub(t, PendingUserRegistration, 'findOne', () => query({ _id: id(), username: user.username, email: user.email, displayname: user.displayname, salt: 'salt', hash: 'hash', residentMode: 'general', householdInvitation: ids.invitation }));
  stub(t, PendingUserRegistration, 'deleteOne', async () => ({}));
  stub(t, User, 'findOne', () => query(null));
  stub(t, User, 'create', async fields => ({ _id: ids.user, ...fields }));
  stub(t, ResidentRegistration, 'findOneAndUpdate', async () => ({}));
  stub(t, Invitation, 'findOneAndUpdate', async () => ({ _id: ids.invitation }));
  stub(t, HouseholdMember, 'findOneAndUpdate', async () => ({ ...member, user: ids.user }));
  stub(t, JoinApplication, 'findOneAndUpdate', async (_filter, update) => ({ _id: ids.application, association: ids.association, ...update.$set }));
  const verified = await verifyEmailToken('a'.repeat(64));
  assert.equal(verified.$locals.householdParticipationSubmitted, true);
  assert.equal(JoinApplication.findOneAndUpdate.mock.calls[0].arguments[1].$set.status, 'pending');
  assert.equal(HouseholdMember.findOneAndUpdate.mock.calls[0].arguments[1].$set.user, ids.user);
  assert.deepEqual(verified.groups, []);
});

test('accepting a household invitation links the existing member but grants no membership', async (t) => {
  stubInvitation(t);
  stub(t, Invitation, 'findOneAndUpdate', async () => ({ _id: ids.invitation }));
  stub(t, HouseholdMember, 'findOneAndUpdate', async () => ({ ...member, user: ids.user }));
  stub(t, JoinApplication, 'findOneAndUpdate', async (_filter, update) => ({ _id: ids.application, association: ids.association, ...update.$set }));
  const grant = stub(t, AssociationMembership, 'findOneAndUpdate', () => { throw new Error('must_not_grant'); });
  const result = await acceptHouseholdInvitation({ invitationId: ids.invitation, user });
  assert.equal(result.householdMember, ids.member);
  assert.equal(result.household, ids.household);
  assert.equal(result.status, 'pending');
  assert.equal(result.source, 'household_invitation');
  assert.equal(result.invitedBy, ids.head);
  assert.equal(grant.mock.callCount(), 0);
});

test('invitation acceptance rejects an account with a different email', async (t) => {
  stubInvitation(t);
  const claim = stub(t, Invitation, 'findOneAndUpdate', () => { throw new Error('must_not_claim'); });
  await assert.rejects(acceptHouseholdInvitation({ invitationId: ids.invitation, user: { ...user, email: 'other@example.test' } }), /宛先が異なります/);
  assert.equal(claim.mock.callCount(), 0);
});

test('invited residents notify current district leaders, bypassing household-head approval', async (t) => {
  stubInvitation(t);
  const leader = id();
  AnnualLeaderAssignment.find.mock.mockImplementation(filter => {
    assert.equal(filter.cancelledAt, null);
    assert.equal(filter.districtGroup, ids.district);
    return query([{ representative: leader }, { representative: leader }]);
  });
  AssociationMembership.exists.mock.mockImplementation(filter => Promise.resolve(String(filter.user) === String(ids.head) || String(filter.user) === String(leader) ? {} : null));
  stub(t, Invitation, 'findOneAndUpdate', async () => ({ _id: ids.invitation }));
  stub(t, HouseholdMember, 'findOneAndUpdate', async () => ({ ...member, user: ids.user }));
  stub(t, JoinApplication, 'findOneAndUpdate', async (_filter, update) => ({ _id: ids.application, association: ids.association, ...update.$set }));
  stub(t, Notification, 'create', async document => document);
  const application = await acceptHouseholdInvitation({ invitationId: ids.invitation, user });
  assert.equal(application.status, 'pending');
  assert.equal(application.householdConfirmedBy, ids.head);
  assert.equal(Notification.create.mock.callCount(), 1);
  const notification = Notification.create.mock.calls[0].arguments[0];
  assert.equal(notification.recipient, String(leader));
  assert.equal(notification.type, 'join_application_received');
  assert.match(notification.title, /山田世帯の山田 花子さん/);
  assert.match(notification.body, /班長メニュー/);
  assert.doesNotMatch(notification.body, /プロフィール/);
});

test('leader invitation approval is displayed as joint district and household participation', async () => {
  const html = await ejs.renderFile(fileURLToPath(new URL('../src/views/partials/join-application-list.ejs', import.meta.url)), {
    association, csrfToken: 'csrf', decisionPath: 'leader', applications: [{ _id: ids.application, applicant: user, household, districtGroup: { name: '1班' }, status: 'pending', source: 'household_invitation', invitedBy: invitation.invitedBy }]
  });
  assert.match(html, /山田世帯の山田 花子さんの参加申請/);
  assert.match(html, /世帯主による再確認は不要/);
  assert.match(html, /班・世帯への参加を承認/);
  assert.match(html, new RegExp(`/leader/applications/${ids.application}/approve`));
  assert.doesNotMatch(html, /href="\/profile/);
});

test('an invitation cannot be accepted twice even after a concurrent lookup', async (t) => {
  stubInvitation(t);
  stub(t, Invitation, 'findOneAndUpdate', async () => null);
  const link = stub(t, HouseholdMember, 'findOneAndUpdate', () => { throw new Error('must_not_link'); });
  await assert.rejects(acceptHouseholdInvitation({ invitationId: ids.invitation, user }), /既に使用/);
  assert.equal(link.mock.callCount(), 0);
});

test('invitation acceptance rolls back the claim and member link if application save fails', async (t) => {
  stubInvitation(t);
  stub(t, Invitation, 'findOneAndUpdate', async () => ({ _id: ids.invitation }));
  stub(t, HouseholdMember, 'findOneAndUpdate', async () => ({ ...member, user: ids.user }));
  stub(t, JoinApplication, 'findOneAndUpdate', async () => { throw new Error('save_failed'); });
  stub(t, Invitation, 'updateOne', async () => ({}));
  stub(t, HouseholdMember, 'updateOne', async () => ({}));
  await assert.rejects(acceptHouseholdInvitation({ invitationId: ids.invitation, user }), /save_failed/);
  assert.equal(Invitation.updateOne.mock.calls[0].arguments[1].$set.status, 'pending');
  assert.equal(HouseholdMember.updateOne.mock.calls[0].arguments[1].$unset.user, '');
});

test('a self-request inherits its household district and waits for household-head confirmation', async (t) => {
  stub(t, AssociationMembership, 'exists', filter => Promise.resolve(String(filter.user) === String(ids.head) ? {} : null));
  stub(t, JoinApplication, 'exists', async () => null);
  stub(t, NeighborhoodAssociation, 'findOne', () => query(association));
  stub(t, User, 'findOne', () => query({ _id: ids.head }));
  stub(t, Household, 'findOne', () => query(household));
  stub(t, DistrictGroup, 'exists', async () => ({}));
  stub(t, JoinApplication, 'findOneAndUpdate', async (_filter, update) => ({ _id: ids.application, ...update.$set }));
  stub(t, Notification, 'create', async () => ({}));
  stub(t, ResidentRegistration, 'findOneAndUpdate', async () => ({}));
  const result = await requestHouseholdLink({ associationId: ids.association, districtGroupId: ids.district, user, headEmail: 'HEAD@example.test', body });
  assert.equal(result.household, ids.household);
  assert.equal(result.districtGroup, ids.district);
  assert.equal(result.status, 'awaiting_household');
  assert.equal(Notification.create.mock.calls[0].arguments[0].recipient, ids.head);
});

test('self-request cannot link to an unrelated district or household', async (t) => {
  stub(t, AssociationMembership, 'exists', async () => null);
  stub(t, JoinApplication, 'exists', async () => null);
  stub(t, NeighborhoodAssociation, 'findOne', () => query(association));
  stub(t, User, 'findOne', () => query({ _id: ids.head }));
  stub(t, Household, 'findOne', () => query(null));
  const create = stub(t, JoinApplication, 'findOneAndUpdate', () => { throw new Error('must_not_create'); });
  await assert.rejects(requestHouseholdLink({ associationId: ids.association, districtGroupId: id(), user, headEmail: 'head@example.test', body }), /世帯を確認できません/);
  assert.equal(create.mock.callCount(), 0);
});

test('withdrawn general resident reuses the approved application instead of inserting a duplicate', async t => {
  stub(t, AssociationMembership, 'exists', filter => Promise.resolve(String(filter.user) === String(ids.head) || (String(filter.user) === String(ids.user) && filter.status === 'inactive' && String(filter.association) === String(ids.association)) ? {} : null));
  stub(t, JoinApplication, 'exists', async () => null);
  stub(t, NeighborhoodAssociation, 'findOne', () => query(association));
  stub(t, User, 'findOne', () => query({ _id: ids.head }));
  stub(t, Household, 'findOne', () => query(household));
  stub(t, DistrictGroup, 'exists', async () => ({}));
  stub(t, ResidentRegistration, 'findOneAndUpdate', async () => ({}));
  stub(t, Notification, 'create', async () => ({}));
  stub(t, JoinApplication, 'findOneAndUpdate', async (filter, update) => {
    assert.equal(filter.association, ids.association);
    assert.equal(filter.applicant, ids.user);
    assert.equal(filter.status.$nin.includes('approved'), false, 'old approved row must match');
    assert.deepEqual(filter.status.$nin, ['pending', 'awaiting_household']);
    assert.equal(update.$unset.decidedAt, '');
    assert.equal(update.$unset.householdConfirmedBy, '');
    return { _id: ids.application, ...update.$set };
  });
  const result = await requestHouseholdLink({ associationId: ids.association, districtGroupId: ids.district, user, headEmail: 'head@example.test', body });
  assert.equal(result._id, ids.application);
  assert.equal(result.status, 'awaiting_household');
  assert.equal(result.source, 'household_link');
});

test('active residents still cannot reapply or overwrite their approved application', async t => {
  stub(t, AssociationMembership, 'exists', async () => ({}));
  stub(t, JoinApplication, 'exists', async () => null);
  const write = stub(t, JoinApplication, 'findOneAndUpdate', async () => { throw new Error('must not write'); });
  await assert.rejects(requestHouseholdLink({ associationId: ids.association, districtGroupId: ids.district, user, headEmail: 'head@example.test', body }), { status: 409 });
  assert.equal(write.mock.callCount(), 0);
});

test('final rejoin approval restores the retained household member but not before approval', async t => {
  const application = stubDecision(t);
  const previous = { ...member, user: ids.user, startsAt: new Date('2024-01-01'), endsAt: new Date('2025-01-01') };
  HouseholdMember.findOne.mock.mockImplementation(() => query(previous));
  await decideJoinApplication({ application, actor: { _id: ids.head }, approve: true });
  const [filter, update] = HouseholdMember.updateOne.mock.calls[0].arguments;
  assert.equal(filter._id, ids.member);
  assert.equal(filter.endsAt, previous.endsAt);
  assert.equal(update.$unset.endsAt, '');
  assert.ok(update.$set.startsAt instanceof Date);
});

test('failed rejoin approval restores the previous household member end date', async t => {
  const application = stubDecision(t);
  const previous = { ...member, user: ids.user, startsAt: new Date('2024-01-01'), endsAt: new Date('2025-01-01') };
  HouseholdMember.findOne.mock.mockImplementation(() => query(previous));
  AuditLog.create.mock.mockImplementation(async () => { throw new Error('audit failed'); });
  await assert.rejects(decideJoinApplication({ application, actor: { _id: ids.head }, approve: true }), /audit failed/);
  const update = HouseholdMember.updateOne.mock.calls[1].arguments[1];
  assert.equal(update.$set.endsAt, previous.endsAt);
  assert.equal(update.$set.startsAt, previous.startsAt);
});

test('only the household owner can confirm a self-request', async (t) => {
  stub(t, Household, 'findOne', () => query(null));
  await assert.rejects(confirmHouseholdLink({ associationId: ids.association, householdId: ids.household, applicationId: ids.application, userId: ids.user, approve: true }), /確認できる世帯紐付け申請/);
  assert.equal(Household.findOne.mock.calls[0].arguments[0].representative, ids.user);
});

const stubConfirmation = (t) => {
  stub(t, AnnualLeaderAssignment, 'find', () => query([]));
  const application = new JoinApplication({ _id: ids.application, association: ids.association, applicant: ids.user, household: ids.household, districtGroup: ids.district, source: 'household_link', status: 'awaiting_household', residentProfile: parseResidentProfile(body, user) });
  stub(t, Household, 'findOne', () => query(household));
  stub(t, JoinApplication, 'findOne', () => query(application));
  stub(t, JoinApplication, 'findOneAndUpdate', async () => application);
  stub(t, JoinApplication, 'updateOne', async () => ({ modifiedCount: 1 }));
  stub(t, AssociationMembership, 'exists', filter => Promise.resolve(String(filter.user) === String(ids.head) ? {} : null));
  stub(t, User, 'findById', () => query(user));
  stub(t, HouseholdMember, 'findOne', () => query(null));
  stub(t, HouseholdMember, 'findOneAndUpdate', async (_filter, update) => ({ ...member, ...update.$set, ...update.$setOnInsert }));
  stub(t, HouseholdMember, 'deleteOne', async () => ({}));
  stub(t, HouseholdMember, 'updateOne', async () => ({}));
  stub(t, Notification, 'create', async () => ({}));
  return application;
};

test('head confirmation adds an account member only once and still does not grant membership', async (t) => {
  stubConfirmation(t);
  const membership = stub(t, AssociationMembership, 'findOneAndUpdate', () => { throw new Error('must_not_grant'); });
  await confirmHouseholdLink({ associationId: ids.association, householdId: ids.household, applicationId: ids.application, userId: ids.head, approve: true });
  const insertion = HouseholdMember.findOneAndUpdate.mock.calls[0].arguments[1].$setOnInsert;
  assert.equal(insertion.name, user.displayname);
  assert.equal(insertion.nameKana, body.representativeKana);
  assert.equal(JoinApplication.findOneAndUpdate.mock.calls[0].arguments[1].$set.status, 'pending');
  assert.equal(JoinApplication.updateOne.mock.calls[0].arguments[1].$set.householdMember, ids.member);
  assert.equal(membership.mock.callCount(), 0);
});

test('head confirmation links an existing accountless child instead of creating a duplicate', async (t) => {
  stubConfirmation(t);
  HouseholdMember.findOne.mock.mockImplementation(() => query(member));
  await confirmHouseholdLink({ associationId: ids.association, householdId: ids.household, applicationId: ids.application, userId: ids.head, memberId: ids.member, approve: true });
  const update = HouseholdMember.findOneAndUpdate.mock.calls[0].arguments[1];
  assert.equal(update.$set.user, ids.user);
  assert.equal(update.$setOnInsert, undefined);
  assert.equal(JoinApplication.updateOne.mock.calls[0].arguments[1].$set.householdMember, ids.member);
});

test('failed head confirmation restores the request and removes only its newly created member', async (t) => {
  stubConfirmation(t);
  JoinApplication.updateOne.mock.mockImplementation(async (_filter, update) => { if (update.$set.householdMember) throw new Error('save_failed'); return {}; });
  await assert.rejects(confirmHouseholdLink({ associationId: ids.association, householdId: ids.household, applicationId: ids.application, userId: ids.head, approve: true }), /save_failed/);
  assert.equal(HouseholdMember.deleteOne.mock.calls[0].arguments[0]._id, ids.member);
  assert.equal(JoinApplication.updateOne.mock.calls[1].arguments[1].$set.status, 'awaiting_household');
});

test('head rejection leaves the existing accountless household members untouched', async (t) => {
  stubConfirmation(t);
  await confirmHouseholdLink({ associationId: ids.association, householdId: ids.household, applicationId: ids.application, userId: ids.head, approve: false });
  assert.equal(JoinApplication.updateOne.mock.calls[0].arguments[1].$set.status, 'rejected');
  assert.equal(HouseholdMember.findOneAndUpdate.mock.callCount(), 0);
  assert.equal(Notification.create.mock.calls[0].arguments[0].recipient, ids.user);
});

test('second head confirmation cannot attach an extra member', async (t) => {
  stubConfirmation(t);
  JoinApplication.findOneAndUpdate.mock.mockImplementation(async () => null);
  await assert.rejects(confirmHouseholdLink({ associationId: ids.association, householdId: ids.household, applicationId: ids.application, userId: ids.head, approve: true }), /既に確認/);
  assert.equal(HouseholdMember.findOneAndUpdate.mock.callCount(), 0);
});

test('approval of an invited resident grants the same household and district after group sync', async (t) => {
  const application = stubDecision(t);
  await decideJoinApplication({ application, actor: { _id: ids.head }, approve: true });
  const pending = AssociationMembership.findOneAndUpdate.mock.calls[0].arguments[1].$set;
  assert.equal(pending.status, 'pending');
  assert.equal(pending.household, ids.household);
  assert.equal(pending.districtGroup, ids.district);
  assert.equal(pending.joinedBy, 'invitation');
  assert.equal(AssociationMembership.updateOne.mock.calls[0].arguments[1].$set.status, 'active');
  assert.deepEqual(Group.updateOne.mock.calls[0].arguments[1].$addToSet, { members: ids.user });
});

test('the existing household-head registration route remains approvable', async (t) => {
  const application = stubDecision(t, 'representative');
  Household.findOne.mock.mockImplementation(() => query({ ...household, representative: ids.user }));
  await decideJoinApplication({ application, actor: { _id: ids.head }, approve: true });
  assert.equal(AssociationMembership.findOneAndUpdate.mock.calls[0].arguments[1].$set.joinedBy, 'application');
  assert.equal(AssociationMembership.updateOne.mock.calls[0].arguments[1].$set.status, 'active');
});

test('a confirmed general resident is granted application membership in the existing household', async (t) => {
  const application = stubDecision(t, 'household_link');
  await decideJoinApplication({ application, actor: { _id: ids.head }, approve: true });
  const membership = AssociationMembership.findOneAndUpdate.mock.calls[0].arguments[1].$set;
  assert.equal(membership.joinedBy, 'application');
  assert.equal(membership.household, ids.household);
});

test('approvers cannot bypass household-head confirmation', async (t) => {
  const application = stubDecision(t, 'household_link');
  application.householdConfirmedBy = undefined;
  await assert.rejects(decideJoinApplication({ application, actor: { _id: ids.head }, approve: true }), /世帯主の確認が完了/);
  assert.equal(AssociationMembership.findOneAndUpdate.mock.callCount(), 0);
});

test('rejecting an invited member unlinks its account but preserves the household member', async (t) => {
  const application = stubDecision(t);
  await decideJoinApplication({ application, actor: { _id: ids.head }, approve: false, rejectionReason: '世帯を確認できません' });
  assert.equal(HouseholdMember.updateOne.mock.calls[0].arguments[1].$unset.user, '');
  assert.equal(AssociationMembership.findOneAndUpdate.mock.callCount(), 0);
  assert.equal(JoinApplication.findOneAndUpdate.mock.calls[0].arguments[1].$set.status, 'rejected');
});

test('guardian-only registration supports household members without a login account', () => {
  const accountless = new HouseholdMember({ ...member, user: undefined });
  assert.equal(accountless.validateSync(), undefined);
  assert.equal(accountless.user, undefined);
  const waiting = new JoinApplication({ association: ids.association, applicant: ids.user, household: ids.household, districtGroup: ids.district, source: 'household_link', status: 'awaiting_household' });
  assert.equal(waiting.validateSync(), undefined);
  const index = HouseholdMember.schema.indexes().find(([fields]) => fields.household && fields.user);
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression, { user: { $type: 'objectId' } });
});

test('a second approval cannot overwrite an already-decided application', async (t) => {
  const application = stubDecision(t);
  JoinApplication.findOneAndUpdate.mock.mockImplementation(async () => null);
  await assert.rejects(decideJoinApplication({ application, actor: { _id: ids.head }, approve: true }), /既に処理/);
  assert.equal(AssociationMembership.findOneAndUpdate.mock.callCount(), 0);
  assert.equal(JoinApplication.updateOne.mock.callCount(), 0);
});

test('failed approval restores pending state and never leaves a new active membership', async (t) => {
  const application = stubDecision(t);
  User.updateOne.mock.mockImplementation(async (_filter, update) => { if (update.$addToSet) throw new Error('group_sync_failed'); return {}; });
  await assert.rejects(decideJoinApplication({ application, actor: { _id: ids.head }, approve: true }), /group_sync_failed/);
  assert.equal(AssociationMembership.updateOne.mock.callCount(), 0);
  assert.equal(AssociationMembership.deleteOne.mock.callCount(), 1);
  assert.equal(JoinApplication.updateOne.mock.calls[0].arguments[1].$set.status, 'pending');
  assert.deepEqual(Group.updateOne.mock.calls[1].arguments[1].$pull, { members: ids.user });
});

test('failed approval does not remove pre-existing legacy group membership', async (t) => {
  const application = stubDecision(t);
  Group.findById.mock.mockImplementation(() => query({ _id: ids.group, members: [ids.head, ids.user] }));
  User.findById.mock.mockImplementation(() => query({ _id: ids.user, groups: [ids.group] }));
  AuditLog.create.mock.mockImplementation(async () => { throw new Error('audit_failed'); });
  await assert.rejects(decideJoinApplication({ application, actor: { _id: ids.head }, approve: true }), /audit_failed/);
  assert.equal(Group.updateOne.mock.callCount(), 1);
  assert.equal(User.updateOne.mock.callCount(), 1);
  assert.equal(Notification.deleteOne.mock.callCount(), 1);
});

const render = (name, data) => ejs.renderFile(fileURLToPath(new URL(`../src/views/${name}.ejs`, import.meta.url)), { title: 'テスト', csrfToken: 'csrf', notice: null, currentPath: '/', currentUser: user, values: {}, ...data });

test('invitation page offers signup/login and binds acceptance to the exact invitation', async () => {
  const details = { ...invitation, household: { ...household, districtGroup: { name: '1班' } }, member };
  const anonymous = await render('household-invitation', { currentUser: null, invitation: details, emailMatches: true });
  assert.match(anonymous, /招待から会員登録/);
  assert.match(anonymous, /href="\/login"/);
  const loggedIn = await render('household-invitation', { invitation: details, emailMatches: true });
  assert.match(loggedIn, new RegExp(`/household-invitations/${ids.invitation}/accept`));
  const mismatch = await render('household-invitation', { invitation: details, emailMatches: false });
  assert.doesNotMatch(mismatch, /\/accept"/);
});

test('registration and joining expose general/resident routes and household-head email', async () => {
  const registration = await render('register', { values: { residentMode: 'general', householdHeadEmail: 'head@example.test' } });
  assert.match(registration, /name="householdHeadEmail"/);
  assert.match(registration, /value="general" selected/);
  const joining = await render('household-application', { association, districtGroups: [{ _id: ids.district, name: '1班' }] });
  assert.match(joining, /世帯主として登録する/);
  assert.match(joining, /一般メンバーとして既存の世帯に参加する/);
  assert.match(joining, /name="householdHeadEmail"/);
});

test('manager inbox identifies household invitations and disables unconfirmed self-requests', async () => {
  const applications = [
    { _id: ids.application, applicant: user, districtGroup: { name: '1班' }, household, source: 'household_invitation', status: 'pending', invitedBy: invitation.invitedBy },
    { _id: 'waiting', applicant: user, districtGroup: { name: '1班' }, household, source: 'household_link', status: 'awaiting_household' }
  ];
  const html = await render('association-applications', { association, applications });
  assert.match(html, /世帯主からの招待/);
  assert.match(html, /招待元：山田 太郎/);
  assert.match(html, new RegExp(`/manage/applications/${ids.application}/approve`));
  assert.doesNotMatch(html, /applications\/waiting\/approve/);
});

test('co-resident profile shows own household without another resident edit or new household form', async () => {
  const html = await render('profile', { formError: null, households: [], membersByHousehold: {}, availableHouseholdRegistrations: [], affiliatedHouseholds: [{ ...household, association, representative: { displayname: '山田 太郎' }, districtGroup: { name: '1班' } }], ownHouseholdMembers: [{ ...member, user: ids.user }], householdLinkApplications: [], invitationByMember: {}, activeHouseholdIds: [String(ids.household)] });
  assert.match(html, /所属する世帯/);
  assert.match(html, /self-update/);
  assert.doesNotMatch(html, /世帯情報を登録<\/h2>/);
  assert.doesNotMatch(html, /\/members\/[^/]+\/delete/);
  assert.doesNotMatch(html, /name="postalCode"/);
});

test('guardian profile supports accounts and accountless children together with invitations', async () => {
  const child = { ...member, _id: id(), name: '山田 子ども', email: '', birthDate: new Date('2020-04-01') };
  const html = await render('profile', { formError: null, households: [{ ...household, association, districtGroup: { name: '1班' } }], membersByHousehold: { [String(ids.household)]: [child, { ...member, user: { _id: ids.user, displayname: '山田 花子', username: 'hanako', email: 'hanako@example.test' } }] }, availableHouseholdRegistrations: [], householdLinkApplications: [], invitationByMember: {}, activeHouseholdIds: [String(ids.household)] });
  assert.match(html, new RegExp(`/members/${child._id}/invite`));
  assert.match(html, new RegExp(`/members/${child._id}/update`));
  assert.doesNotMatch(html, new RegExp(`/members/${ids.member}/update`));
  assert.match(html, /アカウント紐付け済み/);
  assert.match(html, new RegExp(`/members/${ids.member}/delete`));
  assert.match(html, /このメンバーを世帯から削除/);
  assert.match(html, /ユーザー名：hanako/);
  assert.match(html, /メールアドレス：hanako@example.test/);
  assert.match(html, new RegExp(`data-open-member-dialog="member-dialog-${ids.member}"`));
  assert.match(html, new RegExp(`<dialog class="household-member-dialog" id="member-dialog-${ids.member}"`));
  assert.match(html, /data-close-member-dialog/);
});

test('orphaned account reference is shown as removable without edit or invite controls', async () => {
  const html = await render('profile', { formError: null, households: [{ ...household, association, districtGroup: { name: '1班' } }], membersByHousehold: { [String(ids.household)]: [{ ...member, user: null, linkedAccountMissing: true }] }, availableHouseholdRegistrations: [], householdLinkApplications: [], invitationByMember: {}, activeHouseholdIds: [String(ids.household)] });
  assert.match(html, /アカウント削除済み/);
  assert.match(html, new RegExp(`/members/${ids.member}/delete`));
  assert.doesNotMatch(html, new RegExp(`/members/${ids.member}/update`));
  assert.doesNotMatch(html, new RegExp(`/members/${ids.member}/invite`));
});

test('application status and onboarding pages render the household-confirmation flow', async () => {
  const html = await render('participation-status', { application: { association, districtGroup: { name: '1班' }, status: 'awaiting_household', source: 'household_link' } });
  assert.match(html, /世帯主の確認待ち/);
  const onboarding = await render('resident-onboarding', { associations: [association], registration: { residentMode: 'general', householdHeadEmail: 'head@example.test' } });
  assert.match(onboarding, /head@example.test/);
  assert.match(onboarding, new RegExp(`/associations/${ids.association}/join`));
});

test('invitation email uses the existing SMTP config and escapes household-supplied HTML', async (t) => {
  const config = { PUBLIC_BASE_URL: 'https://town.example.test', SMTP_HOST: 'smtp.example.test', SMTP_USER: 'test-user', SMTP_PASS: 'test-password', MAIL_FROM: 'town@example.test' };
  const previous = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  Object.assign(process.env, config);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let mail;
  stub(t, nodemailer, 'createTransport', options => {
    assert.equal(options.disableFileAccess, true);
    assert.equal(options.disableUrlAccess, true);
    return { sendMail: async message => { mail = message; } };
  });
  await sendHouseholdInvitationEmail({ email: user.email, token: 'a'.repeat(64), associationName: '<町内会>', inviterName: '<script>太郎</script>', memberName: user.displayname });
  assert.equal(mail.to, user.email);
  assert.match(mail.text, /https:\/\/town.example.test\/household-invitations\?token=/);
  assert.match(mail.html, /&lt;script&gt;/);
  assert.doesNotMatch(mail.html, /<script>/);
});

const route = (router, path, method = 'post') => router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;

test('all new mutation endpoints require CSRF verification', () => {
  const endpoints = [
    [householdInvitationsRouter, '/household-invitations/:invitationId/accept'],
    [householdInvitationsRouter, '/household-invitations/decline'],
    [householdInvitationsRouter, '/associations/:associationId/household/:householdId/members/:memberId/invite'],
    [householdInvitationsRouter, '/associations/:associationId/household/:householdId/invitations/:invitationId/cancel'],
    [householdsRouter, '/:associationId/household/:householdId/applications/:applicationId/confirm'],
    [householdsRouter, '/:associationId/household/:householdId/members/:memberId/self-update'],
    [managementRouter, '/:associationId/manage/applications/:applicationId/approve']
  ];
  endpoints.forEach(([router, path]) => assert.ok(route(router, path).stack.some(layer => layer.handle === verifyCsrfToken), path));
});

test('accept endpoint rejects guessed invitation IDs without an invitation link or signup context', async (t) => {
  stub(t, ResidentRegistration, 'findOne', () => query(null));
  const handler = route(householdInvitationsRouter, '/household-invitations/:invitationId/accept').stack.at(-1).handle;
  let error;
  await handler({ user, params: { invitationId: String(ids.invitation) }, session: {} }, {}, value => { error = value; });
  assert.equal(error.status, 403);
});

test('invitation sender endpoint requires the owned household and an unlinked member', async (t) => {
  stub(t, Household, 'findOne', () => query(null));
  const handler = route(householdInvitationsRouter, '/associations/:associationId/household/:householdId/members/:memberId/invite').stack.at(-1).handle;
  let error;
  await handler({ user, params: { associationId: String(ids.association), householdId: String(ids.household), memberId: String(ids.member) }, body: { email: 'recipient@example.test' } }, {}, value => { error = value; });
  assert.equal(error.status, 403);
  assert.equal(Household.findOne.mock.calls[0].arguments[0].representative, ids.user);
});

test('manager approval endpoint cannot approve applications from another association or awaiting head consent', async (t) => {
  stub(t, JoinApplication, 'findOne', () => query(null));
  const handler = route(managementRouter, '/:associationId/manage/applications/:applicationId/approve').stack.at(-1).handle;
  let error;
  await handler({ user, params: { associationId: String(ids.association), applicationId: String(ids.application) } }, {}, value => { error = value; });
  assert.equal(error.status, 409);
  const filter = JoinApplication.findOne.mock.calls[0].arguments[0];
  assert.equal(filter.association, String(ids.association));
  assert.equal(filter.status, 'pending');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import { WithdrawalApplication, Invitation, JoinApplication } from '../src/models/workflow.js';
import { Household, HouseholdMember, DistrictGroup } from '../src/models/organization.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleAssignment } from '../src/models/role.js';
import { User } from '../src/models/user.js';
import { Group } from '../src/models/group.js';
import { Notification } from '../src/models/notification.js';
import { AuditLog } from '../src/models/auditLog.js';
import { requestWithdrawal, confirmWithdrawal, decideWithdrawal, cancelWithdrawal } from '../src/services/withdrawalService.js';
import { withdrawalsRouter } from '../src/routes/withdrawals.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';

const oid = number => number.toString(16).padStart(24, '0');
const association = oid(1), household = oid(2), district = oid(3), head = oid(4), resident = oid(5), leader = oid(6), group = oid(7), otherGroup = oid(8);
const copy = value => structuredClone(value);
const eq = (a, b) => a instanceof Date && b instanceof Date ? +a === +b : String(a) === String(b);
const matches = (document, filter) => Object.entries(filter).every(([field, value]) => {
  if (field === '$or') return value.some(option => matches(document, option));
  const actual = document[field];
  if (value === null) return actual == null;
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).every(([operator, expected]) => {
    if (operator === '$in') return expected.some(item => eq(item, actual));
    if (operator === '$gte') return actual >= expected;
    if (operator === '$gt') return actual > expected;
    if (operator === '$exists') return (actual !== undefined) === expected;
    if (operator === '$ne') return !eq(actual, expected);
    throw new Error(`Unsupported filter ${operator}`);
  });
  return eq(actual, value);
});
const apply = (document, update) => {
  Object.assign(document, copy(update.$set || {}));
  for (const key of Object.keys(update.$unset || {})) delete document[key];
  for (const [key, value] of Object.entries(update.$pull || {})) document[key] = (document[key] || []).filter(item => value?.$in ? !value.$in.some(target => eq(item, target)) : !eq(item, value));
  for (const [key, value] of Object.entries(update.$addToSet || {})) for (const item of value?.$each || [value]) if (!(document[key] || []).some(target => eq(item, target))) (document[key] ||= []).push(item);
};
const query = value => ({ session() { return this; }, select() { return this; }, populate() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => copy(value), then: (resolve, reject) => Promise.resolve(copy(value)).then(resolve, reject) });
// All persistence is in memory; no developer database is accessed.
mongoose.connection.db = { admin: () => ({ command: async () => ({}) }) };
const setup = t => {
  const now = new Date(), fiscalYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  const data = new Map([
    [NeighborhoodAssociation, [{ _id: association, status: 'active', group }]],
    [Household, [{ _id: household, association, districtGroup: district, representative: head, displayName: '山田世帯', active: true }]],
    [DistrictGroup, [{ _id: district, association, active: true }]],
    [AssociationMembership, [head, resident].map((user, index) => ({ _id: oid(20 + index), association, household, districtGroup: district, user, status: 'active' })).concat([{ _id: oid(22), association, districtGroup: district, user: leader, status: 'active' }])],
    [HouseholdMember, [{ _id: oid(30), association, household, user: head, isRepresentative: true }, { _id: oid(31), association, household, user: resident, isRepresentative: false }, { _id: oid(32), association, household, name: '子供', isRepresentative: false }]],
    [AnnualLeaderAssignment, [{ _id: oid(40), association, districtGroup: district, representative: leader, fiscalYear }]],
    [AnnualOfficer, [{ _id: oid(41), association, user: resident, fiscalYear }]],
    [RoleAssignment, [{ _id: oid(42), association, user: resident, startsAt: now }]],
    [User, [head, resident, leader].map(user => ({ _id: user, groups: [group, otherGroup], defaultGroup: group, displayname: '住民' }))],
    [Group, [{ _id: group, members: [head, resident, leader] }, { _id: otherGroup, members: [head, resident] }]],
    [WithdrawalApplication, []], [Invitation, [{ _id: oid(43), association, household, invitedBy: head, status: 'pending' }]],
    [JoinApplication, [{ _id: oid(44), association, household, status: 'pending' }]], [Notification, []], [AuditLog, []]
  ]);
  let sequence = 100;
  for (const [Model, documents] of data) {
    t.mock.method(Model, 'find', filter => query(documents.filter(document => matches(document, filter || {}))));
    t.mock.method(Model, 'findOne', filter => query(documents.find(document => matches(document, filter)) || null));
    t.mock.method(Model, 'findById', id => query(documents.find(document => eq(document._id, id)) || null));
    t.mock.method(Model, 'exists', filter => query(documents.find(document => matches(document, filter)) ? { _id: oid(99) } : null));
    for (const method of ['updateOne', 'updateMany']) t.mock.method(Model, method, async (filter, update) => {
      const found = documents.filter(document => matches(document, filter));
      for (const document of method === 'updateOne' ? found.slice(0, 1) : found) apply(document, update);
      return { matchedCount: found.length, modifiedCount: found.length };
    });
    t.mock.method(Model, 'create', async input => {
      const create = value => { const document = { _id: oid(sequence++), ...copy(value) }; documents.push(document); return copy(document); };
      if (Model === WithdrawalApplication && documents.some(document => eq(document.household, input.household) && ['pending', 'awaiting_household', 'processing'].includes(document.status))) throw Object.assign(new Error('duplicate'), { code: 11000 });
      return Array.isArray(input) ? input.map(create) : create(input);
    });
    t.mock.method(Model, 'deleteOne', async filter => {
      const index = documents.findIndex(document => matches(document, filter));
      if (index >= 0) documents.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    });
  }
  return Model => data.get(Model);
};
const request = (userId = resident, scope = 'individual', successorId) => requestWithdrawal({ associationId: association, userId, scope, successorId, confirmed: true });
const decide = (application, approve = true, actorId = leader) => decideWithdrawal({ associationId: association, applicationId: application._id, actorId, approve });

test('resident withdrawal requires household-head approval before the leader', async t => {
  const records = setup(t), application = await request();
  assert.equal(application.status, 'awaiting_household');
  assert.equal(records(Notification)[0].recipient, head);
  await assert.rejects(decide(application), { status: 404 });
  assert.equal(records(AssociationMembership)[1].status, 'active');
  await confirmWithdrawal({ associationId: association, applicationId: application._id, actorId: head, approve: true });
  assert.equal(records(WithdrawalApplication)[0].status, 'pending');
  assert.equal(records(Notification)[1].recipient, leader);
  await decide(application);
  assert.equal(records(AssociationMembership)[1].status, 'inactive');
  assert.equal(records(AssociationMembership)[0].status, 'active');
  assert.equal(records(Household)[0].active, true);
  assert.ok(records(HouseholdMember)[1].endsAt);
  assert.equal(records(User).length, 3);
  assert.deepEqual(records(User)[1].groups, [otherGroup]);
  assert.equal(records(User)[1].defaultGroup, undefined);
  assert.deepEqual(records(Group)[1].members, [head, resident]);
  assert.ok(records(RoleAssignment)[0].endsAt);
  assert.ok(records(AnnualOfficer)[0].cancelledAt);
});

test('whole household withdrawal bypasses head approval and ends all household records', async t => {
  const records = setup(t), application = await request(head, 'household');
  assert.equal(application.status, 'pending');
  assert.equal(records(Notification)[0].recipient, leader);
  assert.equal(application.membershipIds.length, 2);
  await decide(application);
  assert.equal(records(Household)[0].active, false);
  assert.ok(records(HouseholdMember).every(member => member.endsAt));
  assert.ok(records(AssociationMembership).slice(0, 2).every(member => member.status === 'inactive'));
  assert.equal(records(AssociationMembership)[2].status, 'active');
  assert.equal(records(Invitation)[0].status, 'cancelled');
  assert.equal(records(JoinApplication)[0].status, 'cancelled');
  assert.equal(records(WithdrawalApplication)[0].status, 'approved');
});

test('head-only withdrawal transfers representation atomically upon leader approval', async t => {
  const records = setup(t), application = await request(head, 'representative', resident);
  assert.equal(records(Household)[0].representative, head);
  await decide(application);
  assert.equal(records(Household)[0].representative, resident);
  assert.equal(records(Household)[0].active, true);
  assert.equal(records(HouseholdMember)[0].isRepresentative, false);
  assert.equal(records(HouseholdMember)[1].isRepresentative, true);
  assert.equal(records(HouseholdMember)[1].endsAt, undefined);
  assert.equal(records(AssociationMembership)[0].status, 'inactive');
  assert.equal(records(AssociationMembership)[1].status, 'active');
});

test('head cannot choose an outside user or self as successor', async t => {
  setup(t);
  for (const successorId of [head, leader]) await assert.rejects(request(head, 'representative', successorId), { status: 400 });
});

test('non-head cannot withdraw their whole household', async t => {
  setup(t);
  await assert.rejects(request(resident, 'household'), { status: 400 });
});

test('confirmation is required and duplicate household requests are blocked', async t => {
  setup(t);
  await assert.rejects(requestWithdrawal({ associationId: association, userId: resident, scope: 'individual' }), { status: 400 });
  await request();
  await assert.rejects(request(head, 'household'), { code: 11000 });
});

test('only the current household head can confirm a resident request', async t => {
  const records = setup(t), application = await request();
  await assert.rejects(confirmWithdrawal({ associationId: association, applicationId: application._id, actorId: leader, approve: true }), { status: 403 });
  assert.equal(records(WithdrawalApplication)[0].status, 'awaiting_household');
});

test('head rejection keeps membership and household unchanged', async t => {
  const records = setup(t), application = await request();
  await confirmWithdrawal({ associationId: association, applicationId: application._id, actorId: head, approve: false });
  assert.equal(records(WithdrawalApplication)[0].status, 'rejected');
  assert.equal(records(AssociationMembership)[1].status, 'active');
});

test('leader rejection never transfers the head or removes memberships', async t => {
  const records = setup(t), application = await request(head, 'representative', resident);
  await decide(application, false);
  assert.equal(records(WithdrawalApplication)[0].status, 'rejected');
  assert.equal(records(Household)[0].representative, head);
  assert.equal(records(AssociationMembership)[0].status, 'active');
});

test('other users and leaders from other districts cannot approve', async t => {
  const records = setup(t), application = await request(head, 'household');
  await assert.rejects(decide(application, true, resident), { status: 403 });
  records(AnnualLeaderAssignment)[0].districtGroup = oid(999);
  await assert.rejects(decide(application), { status: 403 });
  assert.equal(records(WithdrawalApplication)[0].status, 'pending');
});

test('a cancelled leader assignment cannot approve withdrawal', async t => {
  const records = setup(t), application = await request(head, 'household');
  records(AnnualLeaderAssignment)[0].cancelledAt = new Date();
  await assert.rejects(decide(application), { status: 403 });
});

test('household changes or a new member require a fresh withdrawal request', async t => {
  const records = setup(t), application = await request(head, 'household');
  records(AssociationMembership).push({ _id: oid(900), association, household, user: oid(901), districtGroup: district, status: 'active' });
  await assert.rejects(decide(application), /世帯メンバーが増えています/);
  assert.equal(records(WithdrawalApplication)[0].status, 'pending');
  records(Household)[0].districtGroup = oid(902);
  await assert.rejects(decide(application), { status: 409 });
});

test('withdrawal can be cancelled only by the applicant before completion', async t => {
  const records = setup(t), application = await request();
  await assert.rejects(cancelWithdrawal({ applicationId: application._id, actorId: head }), { status: 404 });
  await cancelWithdrawal({ applicationId: application._id, actorId: resident });
  assert.equal(records(WithdrawalApplication)[0].status, 'cancelled');
  assert.equal(records(AssociationMembership)[1].status, 'active');
});

test('approval cannot be replayed', async t => {
  setup(t);
  const application = await request(head, 'household');
  await decide(application);
  await assert.rejects(decide(application), { status: 404 });
});

test('failed approval restores memberships, groups and successor on standalone MongoDB', async t => {
  const records = setup(t), application = await request(head, 'representative', resident);
  const snapshot = () => {
    const value = copy([records(Household), records(HouseholdMember), records(AssociationMembership), records(User), records(Group), records(Invitation)]);
    for (const documents of value) for (const document of documents) {
      document.groups?.sort();
      document.members?.sort();
    }
    return value;
  };
  const before = snapshot();
  AuditLog.create.mock.mockImplementation(async () => { throw new Error('audit unavailable'); });
  await assert.rejects(decide(application), /audit unavailable/);
  assert.deepEqual(snapshot(), before);
  assert.equal(records(WithdrawalApplication)[0].status, 'pending');
});

test('withdrawal routes require login and all writes require CSRF', () => {
  for (const layer of withdrawalsRouter.stack.filter(layer => layer.route)) assert.ok(layer.route.stack.some(item => item.handle === requireLogin));
  for (const layer of withdrawalsRouter.stack.filter(layer => layer.route?.methods.post)) assert.ok(layer.route.stack.some(item => item.handle === verifyCsrfToken));
});

test('withdrawal routes allow an anonymous public association page to continue', () => {
  let continued = false;
  withdrawalsRouter.handle({ method: 'GET', url: `/associations/${association}/public`, originalUrl: `/associations/${association}/public` }, {}, () => { continued = true; });
  assert.equal(continued, true);
});

test('withdrawal inbox uses head and leader routes with successor details', async () => {
  for (const withdrawalDecisionPath of ['head', 'leader']) {
    const html = await ejs.renderFile(fileURLToPath(new URL('../src/views/partials/withdrawal-list.ejs', import.meta.url)), { association: { _id: association }, csrfToken: 'csrf', withdrawalDecisionPath, withdrawalApplications: [{ _id: oid(100), scope: 'representative', household: { displayName: '山田世帯' }, requestedBy: { displayname: '山田 太郎' }, successor: { displayname: '山田 花子' } }] });
    assert.match(html, /山田 花子/);
    assert.match(html, /name="_csrf"/);
    assert.match(html, withdrawalDecisionPath === 'head' ? /\/head\/approve/ : /\/leader\/withdrawals\/.*\/approve/);
  }
});

test('successor withdrawal cannot proceed if the chosen member has left', async t => {
  const records = setup(t), application = await request(head, 'representative', resident);
  records(AssociationMembership)[1].status = 'inactive';
  await assert.rejects(decide(application), /新しい世帯主/);
  assert.equal(records(Household)[0].representative, head);
  assert.equal(records(WithdrawalApplication)[0].status, 'pending');
});

test('changed household head invalidates a previously confirmed application', async t => {
  const records = setup(t), application = await request(head, 'household');
  records(Household)[0].representative = resident;
  await assert.rejects(decide(application), /世帯主・班が変更/);
  assert.equal(records(AssociationMembership)[0].status, 'active');
});

test('profile withdrawal page renders scope choices, confirmation, cancellation and approvals', async () => {
  const html = await ejs.renderFile(fileURLToPath(new URL('../src/views/withdrawals.ejs', import.meta.url)), {
    title: '退会申請', currentPath: '/profile/withdrawals', currentUser: { _id: head, displayname: '山田 太郎', username: 'head' }, notice: null, csrfToken: 'csrf',
    memberships: [{ association: { _id: association, name: 'テスト町内会' }, household: { _id: household, active: true, representative: head } }],
    successors: [{ household, user: { _id: resident, displayname: '山田 花子' } }], busyHouseholds: [], headApplications: [],
    applications: [{ _id: oid(100), association: { name: 'テスト町内会' }, status: 'pending', scope: 'representative' }]
  });
  assert.match(html, /世帯全員で退会する/);
  assert.match(html, /新しい世帯主/);
  assert.match(html, /山田 花子/);
  assert.match(html, /name="confirmWithdrawal" required/);
  assert.match(html, /班長の承認待ち/);
  assert.match(html, /\/cancel/);
});

test('withdrawal schema stores tenant, target, successor and active-request uniqueness', () => {
  const application = new WithdrawalApplication({ association, membership: oid(20), requestedBy: head, household, districtGroup: district, originalRepresentative: head, scope: 'representative', successor: resident, membershipIds: [oid(20)], status: 'pending' });
  assert.equal(application.validateSync(), undefined);
  const index = WithdrawalApplication.schema.indexes().find(([fields]) => fields.household === 1);
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression.status.$in, ['awaiting_household', 'pending', 'processing']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { Household, HouseholdMember } from '../src/models/organization.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { RoleAssignment } from '../src/models/role.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { Invitation, JoinApplication, WithdrawalApplication } from '../src/models/workflow.js';
import { Group } from '../src/models/group.js';
import { User } from '../src/models/user.js';
import { AuditLog } from '../src/models/auditLog.js';
import { Notification } from '../src/models/notification.js';
import { removeLinkedHouseholdMember } from '../src/services/householdMemberRemovalService.js';

const id = () => new mongoose.Types.ObjectId();
const ids = { association: id(), household: id(), member: id(), head: id(), linked: id(), group: id(), membership: id() };
const query = value => ({ select() { return this; }, session() { return this; }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
mongoose.connection.db = { admin: () => ({ command: async () => ({}) }) };

test('head removal ends linked participation and retains the shared account', async t => {
  const changes = [];
  t.mock.method(Household, 'findOne', () => query({ _id: ids.household, representative: ids.head }));
  t.mock.method(AssociationMembership, 'exists', () => query({ _id: id() }));
  t.mock.method(HouseholdMember, 'findOne', () => query({ _id: ids.member, user: ids.linked, isRepresentative: false, endsAt: null }));
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: ids.association, group: ids.group }));
  t.mock.method(Group, 'findById', () => query({ _id: ids.group, members: [ids.linked] }));
  t.mock.method(User, 'findById', () => query({ _id: ids.linked, groups: [ids.group], defaultGroup: ids.group }));
  t.mock.method(WithdrawalApplication, 'exists', () => query(null));
  const records = new Map([
    [HouseholdMember, [{ _id: ids.member, endsAt: null }]],
    [AssociationMembership, [{ _id: ids.membership, status: 'active' }]]
  ]);
  for (const Model of [HouseholdMember, AssociationMembership, RoleAssignment, AnnualOfficer, AnnualLeaderAssignment, Invitation, JoinApplication, WithdrawalApplication]) {
    t.mock.method(Model, 'find', () => query(records.get(Model) || []));
    t.mock.method(Model, 'updateMany', async (_filter, change) => { changes.push({ model: Model.modelName, change }); return { modifiedCount: 1 }; });
    t.mock.method(Model, 'updateOne', async (_filter, change) => { changes.push({ model: `${Model.modelName}.restore`, change }); return { modifiedCount: 1 }; });
  }
  t.mock.method(Group, 'updateOne', async (_filter, change) => { changes.push({ model: 'Group', change }); return { modifiedCount: 1 }; });
  t.mock.method(User, 'updateOne', async (_filter, change) => { changes.push({ model: 'User', change }); return { modifiedCount: 1 }; });
  t.mock.method(User, 'deleteOne', async () => { throw new Error('shared account must remain'); });
  t.mock.method(Notification, 'create', async () => [{ _id: id() }]);
  t.mock.method(Notification, 'deleteOne', async () => ({ deletedCount: 1 }));
  t.mock.method(AuditLog, 'create', async () => [{ _id: id() }]);

  await removeLinkedHouseholdMember({ associationId: ids.association, householdId: ids.household, memberId: ids.member, actorId: ids.head });
  assert.ok(changes.some(item => item.model === 'HouseholdMember' && item.change.$set?.endsAt));
  assert.ok(changes.some(item => item.model === 'AssociationMembership' && item.change.$set?.status === 'inactive'));
  assert.ok(changes.some(item => item.model === 'Group' && item.change.$pull?.members));
  assert.equal(User.deleteOne.mock.callCount(), 0);

  changes.length = 0;
  AuditLog.create.mock.mockImplementation(async () => { throw new Error('audit failure'); });
  await assert.rejects(removeLinkedHouseholdMember({ associationId: ids.association, householdId: ids.household, memberId: ids.member, actorId: ids.head }), /audit failure/);
  assert.ok(changes.some(item => item.model === 'HouseholdMember.restore' && item.change.$set?.endsAt === null));
  assert.ok(changes.some(item => item.model === 'AssociationMembership.restore' && item.change.$set?.status === 'active'));
  assert.ok(changes.some(item => item.model === 'Group' && item.change.$addToSet?.members));

  AuditLog.create.mock.mockImplementation(async () => [{ _id: id() }]);
  User.findById.mock.mockImplementation(() => query(null));
  const notificationCount = Notification.create.mock.callCount();
  const userUpdateCount = User.updateOne.mock.callCount();
  const result = await removeLinkedHouseholdMember({ associationId: ids.association, householdId: ids.household, memberId: ids.member, actorId: ids.head });
  assert.equal(result.accountExists, false);
  assert.equal(Notification.create.mock.callCount(), notificationCount);
  assert.equal(User.updateOne.mock.callCount(), userUpdateCount);
});

test('head cannot remove the household representative', async t => {
  t.mock.method(Household, 'findOne', () => query({ _id: ids.household, representative: ids.head }));
  t.mock.method(AssociationMembership, 'exists', () => query({ _id: id() }));
  t.mock.method(HouseholdMember, 'findOne', () => query(null));
  await assert.rejects(removeLinkedHouseholdMember({ associationId: ids.association, householdId: ids.household, memberId: ids.member, actorId: ids.head }), { status: 404 });
});

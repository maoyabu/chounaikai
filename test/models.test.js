import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { User } from '../src/models/user.js';
import { Group } from '../src/models/group.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { PendingUserRegistration } from '../src/models/pendingUserRegistration.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { Notification } from '../src/models/notification.js';
import { Household, HouseholdMember } from '../src/models/organization.js';
import { JoinApplication } from '../src/models/workflow.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';

test('compatibility models explicitly use legacy collection names', () => {
  assert.equal(User.collection.name, 'users');
  assert.equal(Group.collection.name, 'groups');
});

test('association is an extension document linked to a legacy group', () => {
  const association = new NeighborhoodAssociation({
    publicSlug: 'Yoshida-Chokai',
    name: '吉田町町内会',
    requestedGroupName: '吉田町町内会',
    requestedBy: new mongoose.Types.ObjectId()
  });
  assert.equal(association.publicSlug, 'yoshida-chokai');
  assert.equal(association.status, 'pending');
  assert.equal(association.validateSync(), undefined);
});

test('membership validates supported lifecycle states', () => {
  const membership = new AssociationMembership({
    association: new mongoose.Types.ObjectId(),
    user: new mongoose.Types.ObjectId(),
    status: 'active',
    joinedBy: 'admin'
  });
  assert.equal(membership.validateSync(), undefined);
  membership.status = 'deleted';
  assert.ok(membership.validateSync()?.errors.status);
});

test('chounaikai-only fields are not accepted by compatibility User model', () => {
  const user = new User({ username: 'sample', email: 'sample@example.test', neighborhoodRole: 'admin' });
  assert.equal(user.neighborhoodRole, undefined);
});

test('unverified signups are isolated from the shared users collection', () => {
  assert.equal(PendingUserRegistration.collection.name, 'pending_user_registrations');
  assert.notEqual(PendingUserRegistration.collection.name, User.collection.name);
});

test('annual district leader and notification are association scoped', () => {
  const association = new mongoose.Types.ObjectId();
  const user = new mongoose.Types.ObjectId();
  const assignment = new AnnualLeaderAssignment({ association, fiscalYear: 2027, districtGroup: new mongoose.Types.ObjectId(), representative: user, assignedBy: user });
  const notification = new Notification({ association, recipient: user, type: 'district_leader_assigned', title: '班長のお願い', body: '班長に指定されました。' });
  assert.equal(assignment.validateSync(), undefined);
  assert.equal(notification.validateSync(), undefined);
});

test('household application data contains a district and editable resident profile', () => {
  const association = new mongoose.Types.ObjectId(), districtGroup = new mongoose.Types.ObjectId(), user = new mongoose.Types.ObjectId();
  const household = new Household({ association, districtGroup, representative: user, displayName: '山田世帯', address: { postalCode: '100-0001', street: '東京都千代田区' } });
  const member = new HouseholdMember({ association, household: household._id, name: '山田 太郎', nameKana: 'やまだ たろう', birthDate: new Date('1990-01-01'), gender: 'male', isRepresentative: true });
  const application = new JoinApplication({ association, applicant: user, districtGroup, household: household._id });
  assert.equal(household.validateSync(), undefined);
  assert.equal(member.validateSync(), undefined);
  assert.equal(application.validateSync(), undefined);
});

test('annual officers are separated from permanent authorization roles', () => {
  const association = new mongoose.Types.ObjectId(), user = new mongoose.Types.ObjectId();
  const officer = new AnnualOfficer({ association, fiscalYear: 2027, user, selectedBy: user });
  assert.equal(officer.validateSync(), undefined);
  assert.equal(officer.fiscalYear, 2027);
});

test('roles, departments and districts accept a display order', async () => {
  const association = new mongoose.Types.ObjectId();
  const role = new (await import('../src/models/role.js')).RoleDefinition({ association, name: '会長', sortOrder: 1, permissions: [] });
  const { Department, DistrictGroup } = await import('../src/models/organization.js');
  assert.equal(new Department({ association, name: '総務部', sortOrder: 2 }).validateSync(), undefined);
  assert.equal(new DistrictGroup({ association, name: '1班', sortOrder: 3 }).validateSync(), undefined);
  assert.equal(role.sortOrder, 1);
});

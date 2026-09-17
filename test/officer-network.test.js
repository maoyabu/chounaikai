import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import mongoose from 'mongoose';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleDefinition } from '../src/models/role.js';
import { Department } from '../src/models/organization.js';
import { OfficerContactGroup } from '../src/models/officerContactGroup.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../src/models/officerAnnouncement.js';
import { Notification } from '../src/models/notification.js';
import { publishAnnouncement, remindAnnouncement, summarizeAnnouncementResponses } from '../src/services/officerAnnouncementService.js';
import { saveOfficerContactGroup, deleteOfficerContactGroup } from '../src/services/officerContactGroupService.js';
import { officerNetworkRouter } from '../src/routes/officerNetwork.js';

const id = () => new mongoose.Types.ObjectId();
const association = id(), sender = id(), first = id(), second = id(), inactive = id(), departmentId = id(), groupId = id(), announcementId = id();
const query = value => ({ select() { return this; }, lean: async () => value });
const access = t => {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: association, name: '中央町内会' }));
  t.mock.method(AssociationMembership, 'findOne', () => query({ association, status: 'active' }));
  t.mock.method(RoleDefinition, 'find', () => query([]));
  t.mock.method(AnnualOfficer, 'exists', async () => ({ _id: id() }));
};
const sending = t => {
  access(t);
  t.mock.method(AnnualOfficer, 'find', () => query([
    { user: first, department: departmentId }, { user: second, department: id() }, { user: inactive, department: departmentId }
  ]));
  t.mock.method(AssociationMembership, 'find', criteria => query([{ user: first }, { user: second }].filter(item => criteria.user.$in.some(value => String(value) === String(item.user)))));
  t.mock.method(OfficerAnnouncement, 'create', async value => ({ _id: announcementId, ...value }));
  let receipts, notifications;
  t.mock.method(OfficerAnnouncementReceipt, 'insertMany', async values => { receipts = values; });
  t.mock.method(Notification, 'insertMany', async values => { notifications = values; });
  return { get receipts() { return receipts; }, get notifications() { return notifications; } };
};
const message = { associationId: association, userId: sender, channel: 'officer', urgency: 5,
  title: '役員会', body: '確認してください', responseMode: 'multiple', options: ['出席', '欠席'] };

test('all-officer delivery includes only active current officers', async t => {
  const records = sending(t);
  const result = await publishAnnouncement({ ...message, audience: 'officers_all' });
  assert.equal(result.recipientCount, 2);
  assert.deepEqual(records.receipts.map(item => String(item.recipient)), [String(first), String(second)]);
  assert.equal(records.notifications[0].type, 'officer_network');
  assert.match(records.notifications[0].title, /役員間の連絡/);
});

test('department, individual and group delivery restrict recipients to active officers', async t => {
  const records = sending(t);
  t.mock.method(Department, 'findOne', () => query({ _id: departmentId }));
  t.mock.method(OfficerContactGroup, 'findOne', () => query({ _id: groupId, members: [second, inactive] }));
  await publishAnnouncement({ ...message, audience: 'department', targetId: departmentId });
  assert.deepEqual(records.receipts.map(item => String(item.recipient)), [String(first)]);
  const individual = await publishAnnouncement({ ...message, audience: 'officer_individual', targetOfficerIds: [first, second] });
  assert.deepEqual(records.receipts.map(item => String(item.recipient)), [String(first), String(second)]);
  assert.deepEqual(individual.announcement.targetOfficers, [String(first), String(second)]);
  await publishAnnouncement({ ...message, audience: 'officer_group', targetId: groupId });
  assert.deepEqual(records.receipts.map(item => String(item.recipient)), [String(second)]);
  await assert.rejects(publishAnnouncement({ ...message, audience: 'officer_individual', targetOfficerIds: [inactive] }), { status: 400 });
  await assert.rejects(publishAnnouncement({ ...message, audience: 'officer_individual', targetOfficerIds: [] }), { status: 400 });
  assert.equal(OfficerContactGroup.findOne.mock.calls[0].arguments[0].association, association);
});

test('group save rejects non-officers and update and delete stay within the association', async t => {
  access(t);
  t.mock.method(AnnualOfficer, 'find', () => query([{ user: first }, { user: inactive }]));
  t.mock.method(AssociationMembership, 'find', () => query([{ user: first }]));
  t.mock.method(OfficerContactGroup, 'create', async value => ({ _id: groupId, ...value }));
  t.mock.method(OfficerContactGroup, 'findOneAndUpdate', async (_filter, update) => ({ _id: groupId, ...update.$set }));
  t.mock.method(OfficerContactGroup, 'deleteOne', async () => ({ deletedCount: 1 }));
  await assert.rejects(saveOfficerContactGroup({ associationId: association, userId: sender, name: '防災', members: [inactive] }), { status: 400 });
  const created = await saveOfficerContactGroup({ associationId: association, userId: sender, name: '防災', members: [first] });
  assert.equal(created.name, '防災');
  const updated = await saveOfficerContactGroup({ associationId: association, userId: sender, groupId, name: '広報', members: [first] });
  assert.equal(updated.name, '広報');
  assert.equal(String(OfficerContactGroup.findOneAndUpdate.mock.calls[0].arguments[0].association), String(association));
  await deleteOfficerContactGroup({ associationId: association, userId: sender, groupId });
  assert.equal(String(OfficerContactGroup.deleteOne.mock.calls[0].arguments[0].association), String(association));
});

test('network reminder addresses only unread officers with the correct notification type', async t => {
  access(t);
  t.mock.method(OfficerAnnouncement, 'findOne', () => query({ _id: announcementId, channel: 'officer', title: '役員会' }));
  t.mock.method(OfficerAnnouncementReceipt, 'find', () => query([{ _id: id(), recipient: first }]));
  t.mock.method(OfficerAnnouncementReceipt, 'findOneAndUpdate', async () => ({ _id: id() }));
  let notices;
  t.mock.method(Notification, 'insertMany', async values => { notices = values; });
  await remindAnnouncement({ associationId: association, announcementId, userId: sender, recipientId: first, channel: 'officer' });
  assert.equal(notices[0].type, 'officer_network_reminder');
});

test('network screens show targets, groups, answers and reminders', async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const officer = { user: { _id: first, displayname: '田中' }, department: { name: '防災部' } };
  const group = { _id: groupId, name: '防災班', members: [first] };
  const announcement = { _id: announcementId, channel: 'officer', audience: 'officer_group', targetGroup: { name: '防災班' }, urgency: 5,
    title: '役員会', body: '集合', responseMode: 'single', options: ['出席', '欠席'], createdAt: new Date() };
  const values = { title: '役員間の連絡網', currentUser: { username: '田中', email: 'a@example.test' }, currentRoleTags: [], currentPath: '', csrfToken: 'token', notice: null,
    association: { _id: association, name: '中央町内会' }, associationId: association, officers: [officer], departments: [{ _id: departmentId, name: '防災部' }], groups: [group], announcement };
  const compose = await ejs.renderFile(path.join(directory, '../src/views/officer-network-new.ejs'), values);
  const groups = await ejs.renderFile(path.join(directory, '../src/views/officer-network-groups.ejs'), values);
  const hub = await ejs.renderFile(path.join(directory, '../src/views/officer-network.ejs'), { ...values, announcements: [], groupCount: 1, unreadReceivedCount: 1 });
  const receipts = [{ recipient: officer.user, readAt: null }];
  const detail = await ejs.renderFile(path.join(directory, '../src/views/officer-announcement-detail.ejs'), { ...values, networkMode: true, receipts,
    responseSummary: summarizeAnnouncementResponses(announcement, receipts) });
  assert.match(compose, /value="officers_all"/);
  assert.match(compose, /value="department"/);
  assert.match(compose, /value="officer_individual"/);
  assert.match(compose, /name="targetOfficerIds"/);
  assert.match(compose, /複数選択可/);
  assert.match(compose, /value="officer_group"/);
  assert.match(compose, /★★★★★ 緊急/);
  assert.match(groups, /グループを作成/);
  assert.match(groups, /変更を保存/);
  assert.match(groups, /グループを削除/);
  assert.match(hub, /届いた役員間の連絡/);
  assert.match(detail, /防災班宛て/);
  assert.match(detail, /未確認者全員に再通知/);
  assert.match(detail, new RegExp(`/associations/${association}/officer-network/${announcementId}/remind`));
});

test('network mutation routes require CSRF and login', () => {
  const routes = officerNetworkRouter.stack.filter(layer => layer.route).map(layer => layer.route);
  const writes = routes.filter(route => route.methods.post);
  assert.equal(writes.length, 6);
  for (const route of writes) assert.ok(route.stack.some(layer => layer.name === 'verifyCsrfToken'));
  assert.ok(officerNetworkRouter.stack.some(layer => layer.name === 'requireLogin'));
});

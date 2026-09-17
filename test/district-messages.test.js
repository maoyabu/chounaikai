import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import mongoose from 'mongoose';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../src/models/officerAnnouncement.js';
import { Notification } from '../src/models/notification.js';
import { publishAnnouncement, remindAnnouncement } from '../src/services/officerAnnouncementService.js';
import { districtMessagesRouter } from '../src/routes/districtMessages.js';

const id = () => new mongoose.Types.ObjectId();
const association = id(), district = id(), sender = id(), first = id(), second = id(), otherDistrict = id(), announcementId = id();
const query = value => ({ select() { return this; }, lean: async () => value });
const message = { associationId: association, userId: sender, channel: 'district', urgency: 5, title: '班内の確認', body: '確認してください', responseMode: 'single', options: ['参加', '不参加'] };
const setup = (t, leader = false) => {
  t.mock.method(AssociationMembership, 'findOne', () => query({ districtGroup: district }));
  t.mock.method(AnnualLeaderAssignment, 'exists', async () => leader ? { _id: id() } : null);
  t.mock.method(AssociationMembership, 'find', criteria => query([sender, first, second].map(user => ({ user })).filter(item => !criteria.user?.$in || criteria.user.$in.some(value => String(value) === String(item.user)))));
  t.mock.method(OfficerAnnouncement, 'create', async value => ({ _id: announcementId, ...value }));
  let receipts, notices;
  t.mock.method(OfficerAnnouncementReceipt, 'insertMany', async values => { receipts = values; });
  t.mock.method(Notification, 'insertMany', async values => { notices = values; });
  return { get receipts() { return receipts; }, get notices() { return notices; } };
};

test('班員は同じ班の複数人に送り、他班の住人は指定できない', async t => {
  const records = setup(t);
  const result = await publishAnnouncement({ ...message, audience: 'district_individual', targetOfficerIds: [first, second] });
  assert.equal(result.recipientCount, 2);
  assert.deepEqual(records.receipts.map(item => String(item.recipient)), [String(first), String(second)]);
  assert.equal(String(result.announcement.districtGroup), String(district));
  assert.equal(records.notices[0].type, 'district_message');
  await assert.rejects(publishAnnouncement({ ...message, audience: 'district_individual', targetOfficerIds: [first, otherDistrict] }), { status: 400 });
});

test('班全員への送信は現年度の班長のみ', async t => {
  const records = setup(t);
  await assert.rejects(publishAnnouncement({ ...message, audience: 'district_all' }), { status: 403 });
  AnnualLeaderAssignment.exists.mock.mockImplementation(async () => ({ _id: id() }));
  const result = await publishAnnouncement({ ...message, audience: 'district_all' });
  assert.equal(result.recipientCount, 3);
  assert.equal(records.receipts.length, 3);
});

test('再通知は元の送信者に限られる', async t => {
  t.mock.method(AssociationMembership, 'findOne', () => query({ districtGroup: district }));
  t.mock.method(OfficerAnnouncement, 'findOne', () => query({ _id: announcementId, channel: 'district', sender, districtGroup: district, title: '班内の確認' }));
  await assert.rejects(remindAnnouncement({ associationId: association, announcementId, userId: first, channel: 'district' }), { status: 403 });
  t.mock.method(OfficerAnnouncementReceipt, 'find', () => query([{ _id: id(), recipient: first }]));
  t.mock.method(OfficerAnnouncementReceipt, 'findOneAndUpdate', async () => ({ _id: id() }));
  let notices;
  t.mock.method(Notification, 'insertMany', async values => { notices = values; });
  assert.equal(await remindAnnouncement({ associationId: association, announcementId, userId: sender, channel: 'district' }), 1);
  assert.equal(notices[0].type, 'district_message_reminder');
});

test('班内の送信画面は複数選択、回答方法、緊急度を表示する', async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const values = { title: '班内の連絡', currentUser: { username: '山田' }, currentRoleTags: [], currentPath: '', csrfToken: 'token', notice: null,
    association: { _id: association, name: '中央町内会' }, districtGroup: { _id: district, name: '第1班' }, isLeader: true,
    members: [{ user: { _id: first, displayname: '田中' } }] };
  const html = await ejs.renderFile(path.join(directory, '../src/views/district-messages-new.ejs'), values);
  assert.match(html, /value="district_all"/);
  assert.match(html, /name="recipientIds"/);
  assert.match(html, /複数選択可/);
  assert.match(html, /★★★★★ 緊急/);
  assert.match(html, /value="multiple"/);
  const resident = await ejs.renderFile(path.join(directory, '../src/views/district-messages-new.ejs'), { ...values, isLeader: false });
  assert.doesNotMatch(resident, /value="district_all"/);
});

test('班内連絡の更新経路はログインとCSRFを要求する', () => {
  const routes = districtMessagesRouter.stack.filter(layer => layer.route).map(layer => layer.route);
  assert.equal(routes.filter(route => route.methods.post).length, 3);
  for (const route of routes.filter(route => route.methods.post)) assert.ok(route.stack.some(layer => layer.name === 'verifyCsrfToken'));
  assert.ok(districtMessagesRouter.stack.some(layer => layer.name === 'requireLogin'));
});

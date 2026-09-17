import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import mongoose from 'mongoose';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { RoleDefinition } from '../src/models/role.js';
import { Notification } from '../src/models/notification.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../src/models/officerAnnouncement.js';
import { confirmAnnouncement, loadRecipientAnnouncement, publishAnnouncement, remindAnnouncement, summarizeAnnouncementResponses } from '../src/services/officerAnnouncementService.js';
import { officerAnnouncementsRouter } from '../src/routes/officerAnnouncements.js';

const id = () => new mongoose.Types.ObjectId();
const association = id(), officer = id(), leader = id(), another = id(), announcementId = id();
const query = value => ({ select() { return this; }, lean: async () => value });
const access = t => {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: association, name: '中央町内会' }));
  t.mock.method(AssociationMembership, 'findOne', () => query({ association, status: 'active' }));
  t.mock.method(RoleDefinition, 'find', () => query([]));
  t.mock.method(AnnualOfficer, 'exists', async () => ({ _id: id() }));
};

test('leader announcement targets only distinct active leaders and creates per-person receipts', async t => {
  access(t);
  t.mock.method(AnnualLeaderAssignment, 'find', () => query([{ representative: leader }, { representative: leader }, { representative: another }]));
  t.mock.method(AssociationMembership, 'find', () => query([{ user: leader }]));
  t.mock.method(OfficerAnnouncement, 'create', async value => ({ _id: announcementId, ...value }));
  let receipts, notifications;
  t.mock.method(OfficerAnnouncementReceipt, 'insertMany', async values => { receipts = values; return values; });
  t.mock.method(Notification, 'insertMany', async values => { notifications = values; return values; });
  const result = await publishAnnouncement({ associationId: association, userId: officer, audience: 'leaders', urgency: 5,
    title: '避難所', body: '開設しました', responseMode: 'single', options: ['確認した', '支援が必要'] });
  assert.equal(result.recipientCount, 1);
  assert.equal(receipts.length, 1);
  assert.equal(String(receipts[0].recipient), String(leader));
  assert.equal(notifications[0].type, 'officer_announcement');
  assert.match(notifications[0].body, /★★★★★ 緊急/);
  assert.equal(result.announcement.urgency, 5);
});

test('choice validation rejects invalid counts and priorities', async t => {
  access(t);
  const base = { associationId: association, userId: officer, audience: 'all', title: '確認', body: '内容', responseMode: 'multiple', urgency: 3 };
  await assert.rejects(publishAnnouncement({ ...base, options: ['1つだけ'] }), { status: 400 });
  await assert.rejects(publishAnnouncement({ ...base, urgency: 6, options: ['はい', 'いいえ'] }), { status: 400 });
  await assert.rejects(publishAnnouncement({ ...base, options: ['同じ', '同じ'] }), { status: 400 });
});

test('recipient confirms a single answer and clears matching notifications', async t => {
  access(t);
  t.mock.method(OfficerAnnouncementReceipt, 'findOne', () => query({ _id: id(), recipient: leader }));
  t.mock.method(OfficerAnnouncement, 'findOne', () => query({ _id: announcementId, association, responseMode: 'single', options: ['はい', 'いいえ'] }));
  let change, cleared;
  t.mock.method(OfficerAnnouncementReceipt, 'updateOne', async (_filter, update) => { change = update; return { modifiedCount: 1 }; });
  t.mock.method(Notification, 'updateMany', async filter => { cleared = filter; return { modifiedCount: 1 }; });
  await assert.rejects(confirmAnnouncement({ associationId: association, announcementId, userId: leader, selectedOptions: ['0', '1'] }), { status: 400 });
  await confirmAnnouncement({ associationId: association, announcementId, userId: leader, selectedOptions: '1' });
  assert.deepEqual(change.$set.selectedOptions, [1]);
  assert.ok(change.$set.readAt instanceof Date);
  assert.equal(cleared.relatedType, 'OfficerAnnouncement');
  assert.equal(String(cleared.recipient), String(leader));
});

test('only an addressed resident can view and only unread recipients can be reminded', async t => {
  access(t);
  t.mock.method(OfficerAnnouncementReceipt, 'findOne', () => query(null));
  await assert.rejects(loadRecipientAnnouncement({ associationId: association, announcementId, userId: another }), { status: 403 });
  t.mock.method(OfficerAnnouncement, 'findOne', () => query({ _id: announcementId, association, title: '確認' }));
  t.mock.method(OfficerAnnouncementReceipt, 'find', () => query([{ _id: id(), recipient: leader }]));
  t.mock.method(OfficerAnnouncementReceipt, 'findOneAndUpdate', async () => ({ _id: id() }));
  let notices;
  t.mock.method(Notification, 'insertMany', async values => { notices = values; });
  const count = await remindAnnouncement({ associationId: association, announcementId, userId: officer, recipientId: leader });
  assert.equal(count, 1);
  assert.equal(notices[0].type, 'officer_announcement_reminder');
  assert.equal(String(notices[0].recipient), String(leader));
});

test('response summary counts each selected choice and residents without answers', () => {
  const summary = summarizeAnnouncementResponses({ options: ['参加', '欠席', '相談'] }, [
    { recipient: { displayname: '田中' }, respondedAt: new Date(), selectedOptions: [0, 2] },
    { recipient: { displayname: '佐藤' }, respondedAt: new Date(), selectedOptions: [0] },
    { recipient: { displayname: '鈴木' }, readAt: new Date(), selectedOptions: [] },
    { recipient: { displayname: '山本' }, selectedOptions: [] }
  ]);
  assert.deepEqual(summary.choices.map(choice => choice.respondents), [['田中', '佐藤'], [], ['田中']]);
  assert.deepEqual(summary.choices.map(choice => choice.percentage), [50, 0, 25]);
  assert.deepEqual(summary.unanswered, ['鈴木', '山本']);
  assert.equal(summary.unansweredPercentage, 50);
  assert.equal(summary.answeredCount, 2);
  assert.equal(summary.recipientCount, 4);
  assert.equal(summarizeAnnouncementResponses({ options: ['参加'] }, []).choices[0].percentage, 0);
});

test('officer and resident announcement screens show choices and confirmation status', async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const announcement = { _id: announcementId, audience: 'leaders', urgency: 4, title: '作業確認', body: '集合してください', responseMode: 'multiple', options: ['参加', '欠席'], createdAt: new Date() };
  const common = { title: '連絡', currentUser: { username: '住人', email: 'a@example.test' }, currentRoleTags: [], currentPath: '', csrfToken: 'token', notice: null,
    association: { _id: association, name: '中央町内会' }, associationId: association, announcement };
  const receipts = [{ recipient: { _id: leader, displayname: '班長' }, readAt: null, selectedOptions: [] }];
  const officerHtml = await ejs.renderFile(path.join(directory, '../src/views/officer-announcement-detail.ejs'), {
    ...common, receipts, responseSummary: summarizeAnnouncementResponses(announcement, receipts)
  });
  const residentHtml = await ejs.renderFile(path.join(directory, '../src/views/resident-announcement-detail.ejs'), {
    ...common, receipt: { readAt: null, selectedOptions: [] }
  });
  assert.match(officerHtml, /未確認者全員に再通知/);
  assert.match(officerHtml, /個別に再通知/);
  assert.match(officerHtml, /回答集計/);
  assert.match(officerHtml, /class="announcement-tally-count">合計 0人/);
  assert.match(officerHtml, /class="announcement-tally-percent">0％/);
  assert.match(officerHtml, /未回答/);
  assert.match(officerHtml, /未回答/);
  assert.match(officerHtml, /班長/);
  assert.match(residentHtml, /type="checkbox"/);
  assert.match(residentHtml, /回答して確認済みにする/);
  const compose = await ejs.renderFile(path.join(directory, '../src/views/officer-announcement-new.ejs'), common);
  assert.match(compose, /name="audience"/);
  assert.match(compose, /value="leaders"/);
  assert.match(compose, /value="all"/);
  assert.match(compose, /<select name="urgency" required>/);
  assert.match(compose, /<option value="5" >★★★★★ 緊急<\/option>/);
  assert.doesNotMatch(compose, /type="radio" name="urgency"/);
  assert.match(compose, /name="option5"/);
});

test('announcement mutations require CSRF and login', () => {
  const routes = officerAnnouncementsRouter.stack.filter(layer => layer.route).map(layer => layer.route);
  const writes = routes.filter(route => route.methods.post);
  assert.equal(writes.length, 3);
  for (const route of writes) assert.ok(route.stack.some(layer => layer.name === 'verifyCsrfToken'));
  assert.ok(officerAnnouncementsRouter.stack.some(layer => layer.name === 'requireLogin'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Notification } from '../src/models/notification.js';
import { OfficerAnnouncementReceipt } from '../src/models/officerAnnouncement.js';
import { QuestionThread } from '../src/models/questionThread.js';
import { JoinApplication, WithdrawalApplication } from '../src/models/workflow.js';
import { deleteNotification, markNotificationRead, syncCompletedNotifications, updateNotificationState, notificationPriority } from '../src/services/notificationInboxService.js';

test('confirmation and deletion target only the recipient notification', async t => {
  const notificationId = new mongoose.Types.ObjectId();
  const recipient = new mongoose.Types.ObjectId();
  let readFilter, deleteFilter;
  t.mock.method(Notification, 'updateOne', async (filter, change) => {
    if (change.$set.readAt) { readFilter = filter; assert.ok(change.$set.readAt instanceof Date); }
    else { deleteFilter = filter; assert.ok(change.$set.hiddenAt instanceof Date); }
    return { modifiedCount: 1 };
  });
  await markNotificationRead({ notificationId, recipient });
  await deleteNotification({ notificationId, recipient });
  assert.deepEqual(readFilter, { _id: notificationId, recipient, readAt: null });
  assert.deepEqual(deleteFilter, { _id: notificationId, recipient });
  await assert.rejects(deleteNotification({ notificationId: 'invalid', recipient }), { status: 404 });
});

test('completed replies, confirmations and approvals are read while pending requests stay unread', async t => {
  const recipient = new mongoose.Types.ObjectId();
  const announcement = new mongoose.Types.ObjectId(), question = new mongoose.Types.ObjectId();
  const approvedJoin = new mongoose.Types.ObjectId(), pendingJoin = new mongoose.Types.ObjectId();
  const finishedWithdrawal = new mongoose.Types.ObjectId(), pendingWithdrawal = new mongoose.Types.ObjectId();
  const items = [
    { type: 'officer_announcement', relatedId: announcement },
    { type: 'question_answered', relatedId: question },
    { type: 'join_application_received', relatedId: approvedJoin },
    { type: 'join_application_received', relatedId: pendingJoin },
    { type: 'withdrawal_leader_requested', relatedId: finishedWithdrawal },
    { type: 'withdrawal_leader_requested', relatedId: pendingWithdrawal }
  ].map(item => ({ _id: new mongoose.Types.ObjectId(), ...item }));
  const query = value => ({ select() { return this; }, lean: async () => value });
  t.mock.method(Notification, 'find', () => query(items));
  t.mock.method(OfficerAnnouncementReceipt, 'find', () => query([{ announcement }]));
  t.mock.method(QuestionThread, 'find', () => query([{ _id: question, lastOfficerAt: new Date('2026-01-01'), residentReadAt: new Date('2026-01-02') }]));
  t.mock.method(JoinApplication, 'find', () => query([{ _id: approvedJoin, status: 'approved' }, { _id: pendingJoin, status: 'pending' }]));
  t.mock.method(WithdrawalApplication, 'find', () => query([{ _id: finishedWithdrawal, status: 'approved' }, { _id: pendingWithdrawal, status: 'pending' }]));
  let filter;
  t.mock.method(Notification, 'updateMany', async criteria => { filter = criteria; });
  assert.equal(await syncCompletedNotifications({ recipient }), 4);
  assert.equal(String(filter.recipient), String(recipient));
  assert.deepEqual(filter._id.$in.map(String), [0, 1, 2, 4].map(index => String(items[index]._id)));
});

test('leader confirmation reads the leader notice while the manager notice remains pending', async t => {
  const leader = new mongoose.Types.ObjectId(), manager = new mongoose.Types.ObjectId(), application = new mongoose.Types.ObjectId(), notice = new mongoose.Types.ObjectId();
  const query = value => ({ select() { return this; }, lean: async () => value });
  t.mock.method(Notification, 'find', () => query([{ _id: notice, type: 'join_application_received', relatedId: application }]));
  t.mock.method(OfficerAnnouncementReceipt, 'find', () => query([]));
  t.mock.method(QuestionThread, 'find', () => query([]));
  t.mock.method(WithdrawalApplication, 'find', () => query([]));
  t.mock.method(JoinApplication, 'find', () => query([{ _id: application, status: 'pending', leaderApprovedBy: leader, leaderApprovedAt: new Date() }]));
  const update = t.mock.method(Notification, 'updateMany', async () => ({}));
  assert.equal(await syncCompletedNotifications({ recipient: leader }), 1);
  assert.equal(await syncCompletedNotifications({ recipient: manager }), 0);
  assert.equal(update.mock.callCount(), 1);
});

test('manual unread and restore preserve recipient isolation', async t => {
  const notificationId = new mongoose.Types.ObjectId(), recipient = new mongoose.Types.ObjectId();
  const changes = [];
  t.mock.method(Notification, 'updateOne', async (filter, change) => { assert.deepEqual(filter, { _id: notificationId, recipient }); changes.push(change.$set); });
  await updateNotificationState({ notificationId, recipient, state: 'unread' });
  await updateNotificationState({ notificationId, recipient, state: 'restore' });
  assert.deepEqual(changes, [{ readAt: null, manuallyUnread: true }, { hiddenAt: null }]);
  await assert.rejects(updateNotificationState({ notificationId, recipient, state: 'invalid' }), { status: 400 });
});
test('urgent takes precedence over actions and ordinary messages', () => {
  assert.equal(notificationPriority({ type: 'alert_level', priority: 'action' }), 'urgent');
  assert.equal(notificationPriority({ type: 'join_application_received' }), 'action');
  assert.equal(notificationPriority({ type: 'good_place' }), 'normal');
});

test('inbox defaults to unread first and separates hidden notices with recipient scope', async t => {
  const { webRouter } = await import('../src/routes/web.js');
  const handler = webRouter.stack.find(item => item.route?.path === '/notifications').route.stack.at(-1).handle;
  const query = value => ({ select() { return this; }, populate() { return this; }, lean: async () => value });
  const filters = [];
  t.mock.method(Notification, 'find', filter => {
    if (filter.type) return query([]);
    filters.push(filter);
    return query([
      { _id: '1', title: '既読', type: 'good_place', readAt: new Date(), createdAt: new Date('2026-11-02') },
      { _id: '2', title: '未読', type: 'danger_report', createdAt: new Date('2026-11-01') }
    ]);
  });
  let rendered;
  const res = { render: (view, data) => { rendered = { view, ...data }; } };
  await handler({ user: { _id: 'recipient' }, query: {} }, res, error => { throw error; });
  assert.equal(rendered.view, 'notifications');
  assert.deepEqual(rendered.notifications.map(item => item._id), ['2', '1']);
  assert.deepEqual(filters[0], { recipient: 'recipient', hiddenAt: null });
  await handler({ user: { _id: 'recipient' }, query: { view: 'hidden', filter: 'urgent', sort: 'newest' } }, res, error => { throw error; });
  assert.deepEqual(filters[1], { recipient: 'recipient', hiddenAt: { $ne: null } });
  assert.deepEqual(rendered.notifications.map(item => item._id), ['2']);
});

test('inbox and detail templates escape content and restrict hide actions to detail', async () => {
  const { renderView } = await import('../test-support/renderView.js');
  const common = { title: 'お知らせ', csrfToken: 'token', currentUser: { username: 'member' }, currentRoleTags: [], currentPath: '/notifications' };
  const notification = { _id: '507f1f77bcf86cd799439011', title: '<script>alert(1)</script>', body: '本文', priority: 'urgent', createdAt: new Date() };
  const html = await renderView('src/views/notifications.ejs', { ...common, notifications: [notification], hidden: false, filter: 'all', sort: 'unread', page: 1, total: 1 });
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /\/delete/);
  assert.match(html, /notification-priority-urgent/);
  assert.match(html, /data-notification-modal/);
  assert.match(html, /<dialog class="notification-modal"/);
  assert.match(html, /notification-modal\.js/);
  const detail = await renderView('src/views/notification-detail.ejs', { ...common, notification, priority: 'urgent', action: { actionUrl: '/dashboard', actionLabel: '内容を確認' } });
  assert.match(detail, /未読に戻す/);
  assert.match(detail, /非表示にする/);
  assert.match(detail, /&lt;script&gt;/);
  const hiddenDetail = await renderView('src/views/notification-detail.ejs', { ...common, notification: { ...notification, hiddenAt: new Date() }, priority: 'urgent', action: { actionUrl: '/dashboard', actionLabel: '内容を確認' } });
  assert.match(hiddenDetail, /再表示する/);
  assert.doesNotMatch(hiddenDetail, /\/delete/);
});

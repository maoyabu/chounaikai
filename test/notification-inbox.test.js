import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Notification } from '../src/models/notification.js';
import { OfficerAnnouncementReceipt } from '../src/models/officerAnnouncement.js';
import { QuestionThread } from '../src/models/questionThread.js';
import { JoinApplication, WithdrawalApplication } from '../src/models/workflow.js';
import { deleteNotification, markNotificationRead, syncCompletedNotifications } from '../src/services/notificationInboxService.js';

test('confirmation and deletion target only the recipient notification', async t => {
  const notificationId = new mongoose.Types.ObjectId();
  const recipient = new mongoose.Types.ObjectId();
  let readFilter, deleteFilter;
  t.mock.method(Notification, 'updateOne', async (filter, change) => { readFilter = filter; assert.ok(change.$set.readAt instanceof Date); return { modifiedCount: 1 }; });
  t.mock.method(Notification, 'deleteOne', async filter => { deleteFilter = filter; return { deletedCount: 1 }; });
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

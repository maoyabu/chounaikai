import mongoose from 'mongoose';
import { Notification } from '../models/notification.js';
import { OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { QuestionThread } from '../models/questionThread.js';
import { JoinApplication, WithdrawalApplication } from '../models/workflow.js';

const validateId = (notificationId) => {
  if (!mongoose.isValidObjectId(notificationId)) throw Object.assign(new Error('お知らせを確認できません。'), { status: 404 });
};

export const markNotificationRead = async ({ notificationId, recipient }) => {
  validateId(notificationId);
  return Notification.updateOne({ _id: notificationId, recipient, readAt: null }, { $set: { readAt: new Date() } });
};

export const deleteNotification = async ({ notificationId, recipient }) => {
  validateId(notificationId);
  return Notification.deleteOne({ _id: notificationId, recipient });
};

const announcementTypes = ['officer_announcement', 'officer_announcement_reminder', 'officer_network', 'officer_network_reminder', 'district_message', 'district_message_reminder'];
const actionableTypes = [...announcementTypes, 'question_answered', 'join_application_received', 'household_link_requested', 'withdrawal_head_requested', 'withdrawal_leader_requested'];

export const syncCompletedNotifications = async ({ recipient }) => {
  const unread = await Notification.find({ recipient, readAt: null, type: { $in: actionableTypes } }).select('_id type relatedId').lean();
  if (!unread.length) return 0;
  const relatedIds = types => [...new Set(unread.filter(item => types.includes(item.type) && item.relatedId).map(item => String(item.relatedId)))];
  const [receipts, threads, joins, withdrawals] = await Promise.all([
    OfficerAnnouncementReceipt.find({ recipient, announcement: { $in: relatedIds(announcementTypes) }, readAt: { $ne: null } }).select('announcement').lean(),
    QuestionThread.find({ _id: { $in: relatedIds(['question_answered']) }, author: recipient }).select('_id lastOfficerAt residentReadAt').lean(),
    JoinApplication.find({ _id: { $in: relatedIds(['join_application_received', 'household_link_requested']) } }).select('_id status').lean(),
    WithdrawalApplication.find({ _id: { $in: relatedIds(['withdrawal_head_requested', 'withdrawal_leader_requested']) } }).select('_id status').lean()
  ]);
  const confirmedAnnouncements = new Set(receipts.map(item => String(item.announcement)));
  const readQuestions = new Set(threads.filter(item => item.residentReadAt && item.lastOfficerAt && new Date(item.residentReadAt) >= new Date(item.lastOfficerAt)).map(item => String(item._id)));
  const joinById = new Map(joins.map(item => [String(item._id), item.status]));
  const withdrawalById = new Map(withdrawals.map(item => [String(item._id), item.status]));
  const completed = unread.filter(item => {
    const id = String(item.relatedId);
    if (announcementTypes.includes(item.type)) return confirmedAnnouncements.has(id);
    if (item.type === 'question_answered') return readQuestions.has(id);
    if (item.type === 'join_application_received') return joinById.has(id) && joinById.get(id) !== 'pending';
    if (item.type === 'household_link_requested') return joinById.has(id) && joinById.get(id) !== 'awaiting_household';
    if (item.type === 'withdrawal_head_requested') return withdrawalById.has(id) && withdrawalById.get(id) !== 'awaiting_household';
    if (item.type === 'withdrawal_leader_requested') return withdrawalById.has(id) && !['pending', 'processing'].includes(withdrawalById.get(id));
    return false;
  });
  if (!completed.length) return 0;
  await Notification.updateMany({ _id: { $in: completed.map(item => item._id) }, recipient, readAt: null }, { $set: { readAt: new Date() } });
  return completed.length;
};

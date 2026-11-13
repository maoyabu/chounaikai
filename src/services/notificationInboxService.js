import mongoose from 'mongoose';
import { EquipmentLoan } from '../models/equipment.js';
import { LocationLinkRequest } from '../models/locationLinkRequest.js';
import { Notification } from '../models/notification.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { QuestionThread } from '../models/questionThread.js';
import { JoinApplication, WithdrawalApplication } from '../models/workflow.js';
import { AssociationGroupRequest, AssociationGroupJoinRequest, AssociationGroupMembership } from '../models/associationGroup.js';

const validateId = (notificationId) => {
  if (!mongoose.isValidObjectId(notificationId)) throw Object.assign(new Error('お知らせを確認できません。'), { status: 404 });
};

export const markNotificationRead = async ({ notificationId, recipient }) => {
  validateId(notificationId);
  return Notification.updateOne({ _id: notificationId, recipient, readAt: null }, { $set: { readAt: new Date() } });
};

export const deleteNotification = async ({ notificationId, recipient }) => {
  validateId(notificationId);
  return Notification.updateOne({ _id: notificationId, recipient }, { $set: { hiddenAt: new Date() } });
};

const announcementTypes = ['officer_announcement', 'officer_announcement_reminder', 'officer_network', 'officer_network_reminder', 'district_message', 'district_message_reminder', 'group_message', 'group_message_reminder'];
const actionableTypes = [...announcementTypes, 'question_answered', 'join_application_received', 'household_link_requested', 'withdrawal_head_requested', 'withdrawal_leader_requested'];

export const syncCompletedNotifications = async ({ recipient }) => {
  const unread = await Notification.find({ recipient, readAt: null, manuallyUnread: { $ne: true }, type: { $in: actionableTypes } }).select('_id type relatedId').lean();
  if (!unread.length) return 0;
  const relatedIds = types => [...new Set(unread.filter(item => types.includes(item.type) && item.relatedId).map(item => String(item.relatedId)))];
  const [receipts, threads, joins, withdrawals] = await Promise.all([
    OfficerAnnouncementReceipt.find({ recipient, announcement: { $in: relatedIds(announcementTypes) }, readAt: { $ne: null } }).select('announcement').lean(),
    QuestionThread.find({ _id: { $in: relatedIds(['question_answered']) }, author: recipient }).select('_id lastOfficerAt residentReadAt').lean(),
    JoinApplication.find({ _id: { $in: relatedIds(['join_application_received', 'household_link_requested']) } }).select('_id status leaderApprovedBy leaderApprovedAt').lean(),
    WithdrawalApplication.find({ _id: { $in: relatedIds(['withdrawal_head_requested', 'withdrawal_leader_requested']) } }).select('_id status').lean()
  ]);
  const confirmedAnnouncements = new Set(receipts.map(item => String(item.announcement)));
  const readQuestions = new Set(threads.filter(item => item.residentReadAt && item.lastOfficerAt && new Date(item.residentReadAt) >= new Date(item.lastOfficerAt)).map(item => String(item._id)));
  const joinById = new Map(joins.map(item => [String(item._id), item.status]));
  const leaderConfirmed = new Set(joins.filter(item => item.leaderApprovedAt && String(item.leaderApprovedBy) === String(recipient)).map(item => String(item._id)));
  const withdrawalById = new Map(withdrawals.map(item => [String(item._id), item.status]));
  const completed = unread.filter(item => {
    const id = String(item.relatedId);
    if (announcementTypes.includes(item.type)) return confirmedAnnouncements.has(id);
    if (item.type === 'question_answered') return readQuestions.has(id);
    if (item.type === 'join_application_received') return joinById.has(id) && (joinById.get(id) !== 'pending' || leaderConfirmed.has(id));
    if (item.type === 'household_link_requested') return joinById.has(id) && joinById.get(id) !== 'awaiting_household';
    if (item.type === 'withdrawal_head_requested') return withdrawalById.has(id) && withdrawalById.get(id) !== 'awaiting_household';
    if (item.type === 'withdrawal_leader_requested') return withdrawalById.has(id) && !['pending', 'processing'].includes(withdrawalById.get(id));
    return false;
  });
  if (!completed.length) return 0;
  await Notification.updateMany({ _id: { $in: completed.map(item => item._id) }, recipient, readAt: null, manuallyUnread: { $ne: true } }, { $set: { readAt: new Date() } });
  return completed.length;
};

export const updateNotificationState = async ({ notificationId, recipient, state }) => {
  validateId(notificationId);
  const changes = {
    unread: { readAt: null, manuallyUnread: true },
    hide: { hiddenAt: new Date() },
    restore: { hiddenAt: null }
  };
  if (!changes[state]) throw Object.assign(new Error('操作を確認してください。'), { status: 400 });
  return Notification.updateOne({ _id: notificationId, recipient }, { $set: changes[state] });
};

export const notificationPriority = item => {
  if (item.priority === 'urgent' || ['alert_level', 'danger_report'].includes(item.type)) return 'urgent';
  if (item.type === 'equipment_loan' && !/の貸出申込み：/.test(item.title || '')) return 'normal';
  if (item.priority === 'action' || ['question_created', 'question_reopened', 'location_link_requested', 'join_application_received', 'household_link_requested', 'withdrawal_head_requested', 'withdrawal_leader_requested', 'equipment_loan'].includes(item.type) || (item.type === 'group_request' && /申請が届きました/.test(item.title || ''))) return 'action';
  return 'normal';
};

// Reading a notice is independent of completing its underlying request.
export const enrichNotificationStates = async (items, { recipient }) => {
  await attachSurveyResponseState(items, recipient);
  const load = async (types, Model, fields) => {
    const ids = items.filter(item => types.includes(item.type) && item.relatedId).map(item => item.relatedId);
    return ids.length ? Model.find({ _id: { $in: ids } }).select(fields).lean() : [];
  };
  const groupItems = items.filter(item => item.type === 'group_request' && item.relatedRequest && /申請が届きました/.test(item.title || ''));
  const groupRequestIds = kind => groupItems.filter(item => kind.test(item.title || '')).map(item => item.relatedRequest);
  const groupLoad = (kind, Model, fields) => {
    const ids = groupRequestIds(kind);
    return ids.length ? Model.find({ _id: { $in: ids } }).select(fields).lean() : [];
  };
  const [joins, withdrawals, questions, locations, loans, groupCreations, groupJoins, groupWithdrawals] = await Promise.all([
    load(['join_application_received', 'household_link_requested'], JoinApplication, '_id status leaderApprovedBy leaderApprovedAt'),
    load(['withdrawal_head_requested', 'withdrawal_leader_requested'], WithdrawalApplication, '_id status'),
    load(['question_created', 'question_reopened'], QuestionThread, '_id status'),
    load(['location_link_requested'], LocationLinkRequest, '_id status'),
    items.some(item => item.type === 'equipment_loan' && /の貸出申込み：/.test(item.title || ''))
      ? EquipmentLoan.find({ equipment: { $in: items.filter(item => item.type === 'equipment_loan').map(item => item.relatedId).filter(Boolean) } }).select('_id association equipment status startDate startTime allDay createdAt').lean() : [],
    groupLoad(/グループ作成/, AssociationGroupRequest, '_id status'),
    groupLoad(/参加申請/, AssociationGroupJoinRequest, '_id status'),
    groupLoad(/退会申請/, AssociationGroupMembership, '_id status withdrawalRequestedAt')
  ]);
  const lookup = rows => new Map(rows.map(row => [String(row._id), row]));
  const j = lookup(joins), w = lookup(withdrawals), q = lookup(questions), l = lookup(locations), gc = lookup(groupCreations), gj = lookup(groupJoins), gw = lookup(groupWithdrawals);
  for (const item of items) {
    const id = String(item.relatedId);
    item.priority = notificationPriority(item);
    let completed = false;
    if (item.type === 'join_application_received' && j.has(id)) completed = j.get(id).status !== 'pending' || Boolean(j.get(id).leaderApprovedAt && String(j.get(id).leaderApprovedBy) === String(recipient));
    if (item.type === 'household_link_requested' && j.has(id)) completed = j.get(id).status !== 'awaiting_household';
    if (item.type === 'withdrawal_head_requested' && w.has(id)) completed = w.get(id).status !== 'awaiting_household';
    if (item.type === 'withdrawal_leader_requested' && w.has(id)) completed = !['pending', 'processing'].includes(w.get(id).status);
    if (['question_created', 'question_reopened'].includes(item.type) && q.has(id)) completed = q.get(id).status !== 'unanswered';
    if (item.type === 'location_link_requested' && l.has(id)) completed = l.get(id).status !== 'pending';
    if (item.type === 'equipment_loan' && item.priority === 'action') {
      const matching = loans.filter(loan => String(loan.equipment) === id && String(loan.association) === String(item.association?._id || item.association) && (item.relatedLoan ? String(loan._id) === String(item.relatedLoan) : (item.title || '').includes(`${loan.startDate} ${loan.allDay === false ? loan.startTime : '終日'}`)));
      completed = matching.length > 0 && matching.every(loan => loan.status !== 'pending');
    }
    if (item.type === 'group_request' && item.relatedRequest) {
      const requestId = String(item.relatedRequest);
      if (/グループ作成/.test(item.title || '') && gc.has(requestId)) completed = gc.get(requestId).status !== 'pending';
      if (/参加申請/.test(item.title || '') && gj.has(requestId)) completed = gj.get(requestId).status !== 'pending';
      if (/退会申請/.test(item.title || '') && gw.has(requestId)) completed = !gw.get(requestId).withdrawalRequestedAt;
    }
    item.actionCompleted = completed || ['join_application_approved', 'join_application_rejected'].includes(item.type);
  }
  return items;
};

export const notificationSortRank = item => item.priority === 'urgent' ? 0 : item.actionCompleted ? 3 : !item.readAt ? 1 : item.priority === 'action' ? 2 : 3;

export const attachSurveyResponseState = async (items, recipient) => {
  const notices = items.filter(item => ['officer_announcement', 'officer_announcement_reminder'].includes(item.type) && item.relatedId);
  for (const item of items) item.requiresSurveyResponse = false;
  if (!notices.length) return;
  const ids = [...new Set(notices.map(item => String(item.relatedId)))];
  const [announcements, receipts] = await Promise.all([
    OfficerAnnouncement.find({ _id: { $in: ids } }).select('_id responseMode mutedAt').lean(),
    OfficerAnnouncementReceipt.find({ recipient, announcement: { $in: ids } }).select('announcement respondedAt').lean()
  ]);
  const surveys = new Set(announcements.filter(item => !item.mutedAt && ['single', 'multiple'].includes(item.responseMode)).map(item => String(item._id)));
  const responses = new Map(receipts.map(item => [String(item.announcement), item]));
  for (const item of notices) {
    const id = String(item.relatedId);
    item.requiresSurveyResponse = surveys.has(id) && responses.has(id) && !responses.get(id).respondedAt;
  }
};

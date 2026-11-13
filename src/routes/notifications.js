import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { disablePushSubscription, savePushSubscription } from '../services/notificationService.js';
import { Notification } from '../models/notification.js';
import { excludeMutedAnnouncementNotifications } from '../services/notificationVisibilityService.js';
import { enrichNotificationStates, markNotificationRead, notificationPriority, notificationSortRank, syncCompletedNotifications, updateNotificationState } from '../services/notificationInboxService.js';
import { notificationAction } from '../services/notificationDestination.js';
import { loadMobileHome } from '../services/mobileHomeService.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { AssociationEvent } from '../models/associationEvent.js';
import { setAnnouncementPin } from '../services/officerAnnouncementService.js';
import { AssociationEquipment, EquipmentLoan } from '../models/equipment.js';
import { decideEquipmentLoan, equipmentAccess } from '../services/equipmentService.js';
import { AssociationGroupRequest, AssociationGroup, AssociationGroupMembership, AssociationGroupJoinRequest } from '../models/associationGroup.js';
import { RoleAssignment, RoleDefinition } from '../models/role.js';
import { queueNotice } from '../services/notificationRecipients.js';
import { JoinApplication, WithdrawalApplication } from '../models/workflow.js';
import { decideJoinApplication, loadLeaderDistrictIds } from '../services/householdParticipationService.js';
import { confirmWithdrawal, decideWithdrawal } from '../services/withdrawalService.js';
import { QuestionThread } from '../models/questionThread.js';
import { addQuestionMessage, loadQuestionBoxAccess } from '../services/questionBoxService.js';
import { acceptAnnouncementAttachments } from '../services/announcementAttachmentService.js';

export const notificationsRouter = express.Router();
notificationsRouter.use(requireLogin);

const mobileNotification = (notification, context = {}) => {
  const association = notification.association;
  const action = notificationAction(notification, context);
  return {
    id: String(notification._id),
    type: notification.type,
    title: notification.title,
    body: notification.body,
    association: association ? { id: String(association._id || association), name: association.name || '' } : null,
    createdAt: notification.createdAt,
    readAt: notification.readAt || null,
    hiddenAt: notification.hiddenAt || null,
    priority: notificationPriority(notification),
    actionCompleted: Boolean(notification.actionCompleted),
    pinned: Boolean(notification.pinned),
    pinnedAt: notification.pinnedAt || null,
    relatedId: notification.relatedId ? String(notification.relatedId) : null,
    relatedLoan: notification.relatedLoan ? String(notification.relatedLoan) : null,
    relatedRequest: notification.relatedRequest ? String(notification.relatedRequest) : null,
    actionUrl: action.actionUrl,
    actionLabel: action.actionLabel
  };
};

const attachAnnouncementPins = async (notifications, userId) => {
  const announcementIds = notifications
    .filter(item => ['officer_announcement', 'officer_announcement_reminder'].includes(item.type) && item.relatedId)
    .map(item => item.relatedId);
  if (!announcementIds.length) return notifications;
  const receipts = await OfficerAnnouncementReceipt.find({ recipient: userId, announcement: { $in: announcementIds } })
    .select('announcement pinnedAt').lean();
  const pinnedByAnnouncement = new Map(receipts.map(receipt => [String(receipt.announcement), receipt.pinnedAt || null]));
  for (const notification of notifications) {
    const pinnedAt = pinnedByAnnouncement.get(String(notification.relatedId));
    notification.pinned = Boolean(pinnedAt);
    notification.pinnedAt = pinnedAt;
  }
  return notifications;
};

const mobileNotificationContexts = async (notifications, user) => {
  const [home, groupMessages, groupEvents] = await Promise.all([
    loadMobileHome({ userId: user._id }),
    OfficerAnnouncement.find({
      _id: { $in: notifications.filter(item => ['group_message', 'group_message_reminder'].includes(item.type)).map(item => item.relatedId).filter(Boolean) }
    }).select('_id associationGroup').lean(),
    AssociationEvent.find({
      _id: { $in: notifications.filter(item => item.type === 'group_event').map(item => item.relatedId).filter(Boolean) }
    }).select('_id group').lean()
  ]);
  const managerAssociations = home.associations.filter(item => item.roles.some(role => role.kind === 'management')).map(item => ({ _id: item.association.id }));
  const leaderAssociations = home.associations.filter(item => item.roles.some(role => role.kind === 'district_leader')).map(item => ({ _id: item.association.id }));
  const messageGroups = new Map(groupMessages.map(item => [String(item._id), item.associationGroup]));
  const eventGroups = new Map(groupEvents.map(item => [String(item._id), item.group]));
  return notification => ({
    currentManagerAssociations: managerAssociations,
    currentLeaderAssociations: leaderAssociations,
    isAdmin: Boolean(user.isAdmin),
    messageGroup: messageGroups.get(String(notification.relatedId)),
    eventGroup: eventGroups.get(String(notification.relatedId))
  });
};

const notificationCategory = notification => {
  const priority = notificationPriority(notification);
  if (priority === 'urgent') return 'emergency';
  if (priority === 'action') return 'request';
  return 'announcement';
};

const chatNotificationTypes = new Set([
  'officer_network',
  'officer_network_reminder',
  'district_message',
  'district_message_reminder',
  'group_message',
  'group_message_reminder'
]);

const filterMobileNotificationsByRole = async (notifications, userId) => {
  const home = await loadMobileHome({ userId });
  const requestAssociationIds = new Set(home.associations
    .filter(profile => profile.roles.some(role => ['management', 'officer', 'district_leader'].includes(role.kind)))
    .map(profile => profile.association.id));
  return notifications.filter(notification => {
    if (chatNotificationTypes.has(notification.type)) return false;
    if (notificationCategory(notification) !== 'request') return true;
    return requestAssociationIds.has(String(notification.association?._id || notification.association || ''));
  });
};

notificationsRouter.get('/', provideCsrfToken, async (req, res, next) => {
  try {
    await syncCompletedNotifications({ recipient: req.user._id });
    const hidden = req.query.view === 'hidden';
    const filter = ['unread', 'read', 'urgent', 'action'].includes(req.query.filter) ? req.query.filter : 'all';
    const category = ['announcement', 'emergency', 'request'].includes(req.query.category) ? req.query.category : null;
    const sort = ['unread', 'pinned'].includes(req.query.sort) ? req.query.sort : 'unread';
    const criteria = { recipient: req.user._id, hiddenAt: hidden ? { $ne: null } : null };
    if (filter === 'unread') criteria.readAt = null;
    if (filter === 'read') criteria.readAt = { $ne: null };
    let notifications = await Notification.find(criteria).populate('association', 'name').lean();
    notifications = await excludeMutedAnnouncementNotifications(notifications);
    await enrichNotificationStates(notifications, { recipient: req.user._id });
    await attachAnnouncementPins(notifications, req.user._id);
    notifications = await filterMobileNotificationsByRole(notifications, req.user._id);
    if (category) notifications = notifications.filter(item => notificationCategory(item) === category);
    if (filter === 'urgent') notifications = notifications.filter(item => item.priority === 'urgent');
    if (filter === 'action') notifications = notifications.filter(item => item.priority === 'action' && !item.actionCompleted);
    notifications.sort((a, b) => (sort === 'pinned'
      ? Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Number(Boolean(a.readAt)) - Number(Boolean(b.readAt))
      : Number(Boolean(a.readAt)) - Number(Boolean(b.readAt)) || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
      || notificationSortRank(a) - notificationSortRank(b)
      || new Date(b.createdAt) - new Date(a.createdAt)
      || String(a._id).localeCompare(String(b._id)));
    const total = notifications.length;
    const totalPages = Math.max(1, Math.ceil(total / 30));
    const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), totalPages);
    notifications = notifications.slice((page - 1) * 30, page * 30);
    const contextFor = await mobileNotificationContexts(notifications, req.user);
    const items = notifications.map(item => mobileNotification(item, contextFor(item)));
    res.set('Cache-Control', 'private, no-store');
    return res.json({ notifications: items, page, total, totalPages, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

const equipmentLoanPayload = async ({ notification, userId }) => {
  if (notification.type !== 'equipment_loan' || !/の貸出申込み：/.test(notification.title || '')) throw Object.assign(new Error('貸出申込みを確認できません。'), { status: 404 });
  await equipmentAccess(notification.association, userId, true);
  let loan;
  if (notification.relatedLoan) {
    loan = await EquipmentLoan.findOne({ _id: notification.relatedLoan, association: notification.association }).populate('borrower', 'displayname username').lean();
  } else if (notification.relatedId) {
    const candidates = await EquipmentLoan.find({ association: notification.association, equipment: notification.relatedId, createdAt: { $lte: new Date(new Date(notification.createdAt).getTime() + 60000) } })
      .populate('borrower', 'displayname username').sort({ createdAt: -1 }).lean();
    loan = candidates.find(item => (notification.title || '').includes(`${item.startDate} ${item.allDay === false ? item.startTime : '終日'}`)) || null;
  }
  if (!loan) throw Object.assign(new Error('貸出申込みを確認できません。'), { status: 404 });
  const equipment = await AssociationEquipment.findOne({ _id: loan.equipment, association: notification.association })
    .select('name place unit').lean();
  if (!equipment) throw Object.assign(new Error('設備・備品を確認できません。'), { status: 404 });
  return {
    id: String(loan._id),
    associationId: String(notification.association),
    equipment: { id: String(equipment._id), name: equipment.name, place: equipment.place, unit: equipment.unit },
    borrowerName: loan.borrower?.displayname || loan.borrower?.username || '利用者',
    startDate: loan.startDate,
    endDate: loan.endDate,
    allDay: loan.allDay !== false,
    startTime: loan.startTime || null,
    endTime: loan.endTime || null,
    quantity: loan.quantity,
    purpose: loan.purpose || '',
    status: loan.status,
    canDecide: loan.status === 'pending',
    createdAt: loan.createdAt,
    decidedAt: loan.decidedAt || null
  };
};

const groupManager = async (associationId, groupId, userId) => AssociationGroupMembership.exists({ association: associationId, group: groupId, user: userId, role: 'manager', status: 'active' });
const associationManager = async (associationId, user) => {
  if (user.isAdmin) return true;
  const roles = await RoleDefinition.find({ association: associationId, active: true, permissions: 'association.manage' }).distinct('_id');
  const now = new Date();
  return Boolean(await RoleAssignment.exists({ association: associationId, user: user._id, role: { $in: roles }, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] }));
};

const groupRequestPayload = async ({ notification, user }) => {
  if (notification.type !== 'group_request' || !/申請が届きました/.test(notification.title || '')) throw Object.assign(new Error('グループ申請を確認できません。'), { status: 404 });
  const associationId = notification.association;
  const relatedRequest = notification.relatedRequest;
  if (/グループ作成/.test(notification.title)) {
    if (!await associationManager(associationId, user)) throw Object.assign(new Error('この申請を操作する権限がありません。'), { status: 403 });
    const request = relatedRequest
      ? await AssociationGroupRequest.findOne({ _id: relatedRequest, association: associationId }).populate('requestedBy', 'displayname username').lean()
      : await AssociationGroupRequest.findOne({ association: associationId, createdAt: { $lte: new Date(new Date(notification.createdAt).getTime() + 60000) } }).populate('requestedBy', 'displayname username').sort({ createdAt: -1 }).lean();
    if (!request) throw Object.assign(new Error('グループ作成申請を確認できません。'), { status: 404 });
    return { id: String(request._id), kind: 'creation', groupId: null, groupName: request.name, applicantName: request.requestedBy?.displayname || request.requestedBy?.username || '利用者', purpose: request.purpose || '', status: request.status, canDecide: request.status === 'pending', createdAt: request.createdAt };
  }
  if (!notification.relatedId || !await groupManager(associationId, notification.relatedId, user._id)) throw Object.assign(new Error('この申請を操作する権限がありません。'), { status: 403 });
  const group = await AssociationGroup.findOne({ _id: notification.relatedId, association: associationId }).select('name').lean();
  if (!group) throw Object.assign(new Error('グループを確認できません。'), { status: 404 });
  if (/参加申請/.test(notification.title)) {
    const request = relatedRequest
      ? await AssociationGroupJoinRequest.findOne({ _id: relatedRequest, association: associationId, group: group._id }).populate('applicant', 'displayname username').lean()
      : await AssociationGroupJoinRequest.findOne({ association: associationId, group: group._id, createdAt: { $lte: new Date(new Date(notification.createdAt).getTime() + 60000) } }).populate('applicant', 'displayname username').sort({ createdAt: -1 }).lean();
    if (!request) throw Object.assign(new Error('グループ参加申請を確認できません。'), { status: 404 });
    return { id: String(request._id), kind: 'join', groupId: String(group._id), groupName: group.name, applicantName: request.applicant?.displayname || request.applicant?.username || '利用者', purpose: '', status: request.status, canDecide: request.status === 'pending', createdAt: request.createdAt };
  }
  const membership = relatedRequest
    ? await AssociationGroupMembership.findOne({ _id: relatedRequest, association: associationId, group: group._id }).populate('user', 'displayname username').lean()
    : await AssociationGroupMembership.findOne({ association: associationId, group: group._id, withdrawalRequestedAt: { $ne: null, $lte: new Date(new Date(notification.createdAt).getTime() + 60000) } }).populate('user', 'displayname username').sort({ withdrawalRequestedAt: -1 }).lean();
  if (!membership) throw Object.assign(new Error('グループ退会申請を確認できません。'), { status: 404 });
  return { id: String(membership._id), kind: 'withdrawal', groupId: String(group._id), groupName: group.name, applicantName: membership.user?.displayname || membership.user?.username || '利用者', purpose: '', status: membership.withdrawalRequestedAt ? 'pending' : membership.status === 'rejected' ? 'approved' : 'rejected', canDecide: Boolean(membership.withdrawalRequestedAt), createdAt: membership.withdrawalRequestedAt || membership.updatedAt };
};

const residentRequestPayload = async ({ notification, user }) => {
  const associationId = notification.association;
  if (notification.type === 'join_application_received') {
    const application = await JoinApplication.findOne({ _id: notification.relatedId, association: associationId })
      .populate('applicant', 'displayname username email')
      .populate('districtGroup', 'name')
      .populate('household', 'displayName')
      .lean();
    if (!application) throw Object.assign(new Error('参加申請を確認できません。'), { status: 404 });
    const manager = await associationManager(associationId, user);
    const leaderDistricts = manager ? [] : await loadLeaderDistrictIds(associationId, user._id);
    const leader = leaderDistricts.some(id => String(id) === String(application.districtGroup?._id || application.districtGroup));
    if (!manager && !leader) throw Object.assign(new Error('この申請を操作する権限がありません。'), { status: 403 });
    const canDecide = manager
      ? ['pending', 'awaiting_household'].includes(application.status)
      : application.status === 'pending' && !application.leaderApprovedAt;
    return {
      id: String(application._id), kind: 'join', applicantName: application.applicant?.displayname || application.applicant?.username || '利用者',
      householdName: application.household?.displayName || '', districtName: application.districtGroup?.name || '', scope: '', reason: application.applicantNote || '',
      status: application.status, step: manager ? 'manager' : 'leader', leaderApproved: Boolean(application.leaderApprovedAt), canDecide,
      canApprove: canDecide, canReject: canDecide && application.status === 'pending', createdAt: application.createdAt
    };
  }
  if (!['withdrawal_head_requested', 'withdrawal_leader_requested'].includes(notification.type)) throw Object.assign(new Error('申請を確認できません。'), { status: 404 });
  const application = await WithdrawalApplication.findOne({ _id: notification.relatedId, association: associationId })
    .populate('requestedBy', 'displayname username email')
    .populate('household', 'displayName')
    .populate('districtGroup', 'name')
    .populate('successor', 'displayname username')
    .lean();
  if (!application) throw Object.assign(new Error('退会申請を確認できません。'), { status: 404 });
  const step = notification.type === 'withdrawal_head_requested' ? 'householdHead' : 'leader';
  return {
    id: String(application._id), kind: 'withdrawal', applicantName: application.requestedBy?.displayname || application.requestedBy?.username || '利用者',
    householdName: application.household?.displayName || '', districtName: application.districtGroup?.name || '', scope: application.scope,
    reason: application.reason || '', successorName: application.successor?.displayname || application.successor?.username || null,
    status: application.status, step, leaderApproved: false,
    canDecide: step === 'householdHead' ? application.status === 'awaiting_household' : application.status === 'pending',
    canApprove: step === 'householdHead' ? application.status === 'awaiting_household' : application.status === 'pending',
    canReject: step === 'householdHead' ? application.status === 'awaiting_household' : application.status === 'pending', createdAt: application.createdAt
  };
};

const questionThreadPayload = async ({ notification, user }) => {
  if (!['question_created', 'question_reopened'].includes(notification.type) || !notification.relatedId) throw Object.assign(new Error('質問・ご意見を確認できません。'), { status: 404 });
  const access = await loadQuestionBoxAccess({ associationId: notification.association, userId: user._id });
  if (!access.canAnswer) throw Object.assign(new Error('質問・ご意見に回答する権限がありません。'), { status: 403 });
  const thread = await QuestionThread.findOne({ _id: notification.relatedId, association: notification.association })
    .populate('author', 'displayname username')
    .populate('districtGroup', 'name')
    .populate('messages.sender', 'displayname username')
    .lean();
  if (!thread) throw Object.assign(new Error('質問・ご意見を確認できません。'), { status: 404 });
  return {
    id: String(thread._id),
    associationId: String(thread.association),
    title: thread.title,
    authorName: thread.author?.displayname || thread.author?.username || '住人',
    districtName: thread.districtGroup?.name || '',
    status: thread.status,
    canReply: thread.status === 'unanswered',
    messages: (thread.messages || []).filter(message => !message.mutedAt).map(message => ({
      id: String(message._id),
      senderName: message.sender?.displayname || message.sender?.username || (message.kind === 'officer' ? '役員' : '住人'),
      kind: message.kind,
      body: message.body,
      createdAt: message.createdAt,
      attachments: (message.attachments || []).map(file => ({
        name: file.originalName,
        mimeType: file.mimeType || 'application/octet-stream',
        url: `/associations/${thread.association}/question-attachments/${encodeURIComponent(file.fileId)}`
      }))
    }))
  };
};

notificationsRouter.get('/push/status', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const endpoint = String(req.query.endpoint || '');
  if (!endpoint) return res.json({ enabled: false });
  const subscription = await import('../models/pushSubscription.js').then(({ PushSubscription }) => PushSubscription.exists({ user: req.user._id, endpoint, disabledAt: null }));
  return res.json({ enabled: Boolean(subscription) });
});

notificationsRouter.post('/permission-prompt/seen', verifyCsrfToken, (req, res) => {
  req.session.notificationPromptPending = false;
  return res.status(204).end();
});

notificationsRouter.get('/unread-count', async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try {
    let notifications = await Notification.find({ recipient: req.user._id, readAt: null, hiddenAt: null }).lean();
    notifications = await excludeMutedAnnouncementNotifications(notifications);
    await enrichNotificationStates(notifications, { recipient: req.user._id });
    notifications = await filterMobileNotificationsByRole(notifications, req.user._id);
    res.json({ unreadCount: notifications.length });
  } catch (error) { next(error); }
});

notificationsRouter.get('/push/public-key', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const key = String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim();
  if (!key) return res.status(503).json({ error: 'web_push_not_configured' });
  return res.json({ publicKey: key });
});

notificationsRouter.post('/push-subscriptions', verifyCsrfToken, async (req, res, next) => {
  try {
    const subscription = await savePushSubscription({ user: req.user._id, subscription: req.body, userAgent: req.get('user-agent') });
    return res.status(201).json({ id: subscription._id });
  } catch (error) { return next(error); }
});

notificationsRouter.delete('/push-subscriptions', verifyCsrfToken, async (req, res, next) => {
  try {
    await disablePushSubscription({ user: req.user._id, endpoint: req.body.endpoint });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

notificationsRouter.get('/:notificationId', provideCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.notificationId)) return res.status(404).json({ error: 'notification_not_found' });
    const notification = await Notification.findOne({ _id: req.params.notificationId, recipient: req.user._id }).populate('association', 'name').lean();
    if (!notification) return res.status(404).json({ error: 'notification_not_found' });
    await enrichNotificationStates([notification], { recipient: req.user._id });
    await attachAnnouncementPins([notification], req.user._id);
    await markNotificationRead({ notificationId: notification._id, recipient: req.user._id });
    notification.readAt ||= new Date();
    res.set('Cache-Control', 'private, no-store');
    const contextFor = await mobileNotificationContexts([notification], req.user);
    return res.json({ notification: mobileNotification(notification, contextFor(notification)), csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

notificationsRouter.get('/:notificationId/equipment-loan', provideCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.notificationId)) return res.status(404).json({ error: 'notification_not_found' });
    const notification = await Notification.findOne({ _id: req.params.notificationId, recipient: req.user._id }).select('association type title relatedId relatedLoan createdAt').lean();
    if (!notification) return res.status(404).json({ error: 'notification_not_found' });
    const loan = await equipmentLoanPayload({ notification, userId: req.user._id });
    if (!notification.relatedLoan) await Notification.updateOne({ _id: notification._id, recipient: req.user._id }, { $set: { relatedLoan: loan.id } });
    return res.json({ loan, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

notificationsRouter.get('/:notificationId/question-thread', provideCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.notificationId)) return res.status(404).json({ error: 'notification_not_found' });
    const notification = await Notification.findOne({ _id: req.params.notificationId, recipient: req.user._id }).select('association type relatedId').lean();
    if (!notification) return res.status(404).json({ error: 'notification_not_found' });
    const thread = await questionThreadPayload({ notification, user: req.user });
    return res.json({ thread, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

notificationsRouter.post('/:notificationId/question-thread', provideCsrfToken, acceptAnnouncementAttachments, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.notificationId)) return res.status(404).json({ error: 'notification_not_found' });
    const notification = await Notification.findOne({ _id: req.params.notificationId, recipient: req.user._id }).select('association type relatedId').lean();
    if (!notification) return res.status(404).json({ error: 'notification_not_found' });
    await questionThreadPayload({ notification, user: req.user });
    await addQuestionMessage({ associationId: notification.association, threadId: notification.relatedId, userId: req.user._id, body: req.body.body, files: req.files });
    await markNotificationRead({ notificationId: notification._id, recipient: req.user._id });
    const thread = await questionThreadPayload({ notification, user: req.user });
    return res.json({ thread, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

notificationsRouter.post('/:notificationId/equipment-loan', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.notificationId)) return res.status(404).json({ error: 'notification_not_found' });
    const notification = await Notification.findOne({ _id: req.params.notificationId, recipient: req.user._id }).select('association type title relatedId relatedLoan createdAt').lean();
    if (!notification) return res.status(404).json({ error: 'notification_not_found' });
    if (!['approved', 'rejected'].includes(req.body.action)) return res.status(400).json({ error: 'invalid_equipment_loan_action' });
    const current = await equipmentLoanPayload({ notification, userId: req.user._id });
    if (!notification.relatedLoan) await Notification.updateOne({ _id: notification._id, recipient: req.user._id }, { $set: { relatedLoan: current.id } });
    await decideEquipmentLoan({ associationId: notification.association, userId: req.user._id, loanId: current.id, action: req.body.action });
    notification.relatedLoan = current.id;
    return res.json({ loan: await equipmentLoanPayload({ notification, userId: req.user._id }), csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

notificationsRouter.get('/:notificationId/group-request', provideCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.notificationId)) return res.status(404).json({ error: 'notification_not_found' });
    const notification = await Notification.findOne({ _id: req.params.notificationId, recipient: req.user._id }).select('association type title relatedId relatedRequest createdAt').lean();
    if (!notification) return res.status(404).json({ error: 'notification_not_found' });
    const request = await groupRequestPayload({ notification, user: req.user });
    if (!notification.relatedRequest) await Notification.updateOne({ _id: notification._id, recipient: req.user._id }, { $set: { relatedRequest: request.id } });
    return res.json({ request, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

notificationsRouter.post('/:notificationId/group-request', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.notificationId)) return res.status(404).json({ error: 'notification_not_found' });
    if (!['approved', 'rejected'].includes(req.body.action)) return res.status(400).json({ error: 'invalid_group_request_action' });
    const notification = await Notification.findOne({ _id: req.params.notificationId, recipient: req.user._id }).select('association type title relatedId relatedRequest createdAt').lean();
    if (!notification) return res.status(404).json({ error: 'notification_not_found' });
    const request = await groupRequestPayload({ notification, user: req.user });
    if (!notification.relatedRequest) await Notification.updateOne({ _id: notification._id, recipient: req.user._id }, { $set: { relatedRequest: request.id } });
    if (!request.canDecide) throw Object.assign(new Error('申請の状態が変更されています。'), { status: 409 });
    const approved = req.body.action === 'approved';
    if (request.kind === 'creation') {
      const source = await AssociationGroupRequest.findOne({ _id: request.id, association: notification.association, status: 'pending' });
      if (!source) throw Object.assign(new Error('申請の状態が変更されています。'), { status: 409 });
      if (approved) {
        const group = await AssociationGroup.create({ association: notification.association, name: source.name, purpose: source.purpose, createdBy: req.user._id });
        await AssociationGroupMembership.create({ association: notification.association, group: group._id, user: source.requestedBy, role: 'manager', status: 'active', approvedBy: req.user._id, joinedAt: new Date() });
        await queueNotice({ association: notification.association, recipients: [source.requestedBy], type: 'group_request', title: 'グループ作成が承認されました', relatedId: group._id });
      } else {
        await queueNotice({ association: notification.association, recipients: [source.requestedBy], type: 'group_request', title: 'グループ作成申請が承認されませんでした' });
      }
      source.status = req.body.action; source.decidedBy = req.user._id; source.decidedAt = new Date(); source.rejectionReason = approved ? '' : String(req.body.reason || '').trim(); await source.save();
    } else if (request.kind === 'join') {
      const source = await AssociationGroupJoinRequest.findOne({ _id: request.id, association: notification.association, group: request.groupId, status: 'pending' });
      if (!source) throw Object.assign(new Error('申請の状態が変更されています。'), { status: 409 });
      if (approved) await AssociationGroupMembership.findOneAndUpdate({ association: source.association, group: source.group, user: source.applicant }, { $set: { status: 'active', role: 'member', approvedBy: req.user._id, joinedAt: new Date() }, $unset: { withdrawalRequestedAt: 1 } }, { upsert: true, new: true, setDefaultsOnInsert: true });
      source.status = req.body.action; source.decidedBy = req.user._id; source.decidedAt = new Date(); await source.save();
      await queueNotice({ association: source.association, recipients: [source.applicant], type: 'group_request', title: approved ? 'グループ参加が承認されました' : 'グループ参加申請が承認されませんでした', relatedId: source.group });
    } else {
      const source = await AssociationGroupMembership.findOne({ _id: request.id, association: notification.association, group: request.groupId, status: 'active', withdrawalRequestedAt: { $ne: null } });
      if (!source) throw Object.assign(new Error('申請の状態が変更されています。'), { status: 409 });
      if (approved && source.role === 'manager' && await AssociationGroupMembership.countDocuments({ association: notification.association, group: request.groupId, role: 'manager', status: 'active' }) <= 1) throw Object.assign(new Error('最後の責任者は退会できません。先に別のメンバーを責任者に指定してください。'), { status: 400 });
      await AssociationGroupMembership.updateOne({ _id: source._id, withdrawalRequestedAt: { $ne: null } }, { ...(approved ? { $set: { status: 'rejected', role: 'member' } } : {}), $unset: { withdrawalRequestedAt: 1 } });
      await queueNotice({ association: notification.association, recipients: [source.user], type: 'group_request', title: approved ? 'グループからの退会が承認されました' : 'グループからの退会申請が却下されました', relatedId: request.groupId });
    }
    await Notification.updateOne({ _id: notification._id, recipient: req.user._id }, { $set: { readAt: new Date() } });
    return res.json({ request: await groupRequestPayload({ notification, user: req.user }), csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

notificationsRouter.get('/:notificationId/resident-request', provideCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.notificationId)) return res.status(404).json({ error: 'notification_not_found' });
    const notification = await Notification.findOne({ _id: req.params.notificationId, recipient: req.user._id }).select('association type relatedId').lean();
    if (!notification) return res.status(404).json({ error: 'notification_not_found' });
    return res.json({ request: await residentRequestPayload({ notification, user: req.user }), csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

notificationsRouter.post('/:notificationId/resident-request', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.notificationId)) return res.status(404).json({ error: 'notification_not_found' });
    if (!['approved', 'rejected'].includes(req.body.action)) return res.status(400).json({ error: 'invalid_resident_request_action' });
    const notification = await Notification.findOne({ _id: req.params.notificationId, recipient: req.user._id }).select('association type relatedId').lean();
    if (!notification) return res.status(404).json({ error: 'notification_not_found' });
    const context = await residentRequestPayload({ notification, user: req.user });
    if (!context.canDecide) throw Object.assign(new Error('申請の状態が変更されています。'), { status: 409 });
    const approve = req.body.action === 'approved';
    if (notification.type === 'join_application_received') {
      const application = await JoinApplication.findOne({ _id: notification.relatedId, association: notification.association, status: context.step === 'manager' && approve ? { $in: ['pending', 'awaiting_household'] } : 'pending' }).populate('districtGroup', 'name');
      if (!application) throw Object.assign(new Error('承認できる参加申請がありません。'), { status: 409 });
      await decideJoinApplication({ application, actor: req.user, approve, rejectionReason: req.body.reason, managerOverride: context.step === 'manager', leaderApproval: context.step === 'leader' });
    } else if (notification.type === 'withdrawal_head_requested') {
      await confirmWithdrawal({ associationId: notification.association, applicationId: notification.relatedId, actorId: req.user._id, approve });
    } else if (notification.type === 'withdrawal_leader_requested') {
      await decideWithdrawal({ associationId: notification.association, applicationId: notification.relatedId, actorId: req.user._id, approve });
    } else {
      throw Object.assign(new Error('申請を確認できません。'), { status: 404 });
    }
    await Notification.updateOne({ _id: notification._id, recipient: req.user._id }, { $set: { readAt: new Date() } });
    return res.json({ request: await residentRequestPayload({ notification, user: req.user }), csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

notificationsRouter.post('/:notificationId/pin', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.notificationId)) return res.status(404).json({ error: 'notification_not_found' });
    const notification = await Notification.findOne({
      _id: req.params.notificationId,
      recipient: req.user._id,
      type: { $in: ['officer_announcement', 'officer_announcement_reminder'] }
    }).select('association relatedId').lean();
    if (!notification?.relatedId) return res.status(404).json({ error: 'notification_not_found' });
    await setAnnouncementPin({
      associationId: notification.association,
      announcementId: notification.relatedId,
      userId: req.user._id,
      pinned: req.body.pinned === true
    });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

notificationsRouter.post('/:notificationId/state', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    await updateNotificationState({ notificationId: req.params.notificationId, recipient: req.user._id, state: req.body.state });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

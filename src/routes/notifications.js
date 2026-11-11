import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { disablePushSubscription, savePushSubscription } from '../services/notificationService.js';
import { Notification } from '../models/notification.js';
import { enrichNotificationStates, markNotificationRead, notificationPriority, notificationSortRank, syncCompletedNotifications, updateNotificationState } from '../services/notificationInboxService.js';
import { notificationAction } from '../services/notificationDestination.js';
import { loadMobileHome } from '../services/mobileHomeService.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { AssociationEvent } from '../models/associationEvent.js';
import { setAnnouncementPin } from '../services/officerAnnouncementService.js';
import { AssociationEquipment, EquipmentLoan } from '../models/equipment.js';
import { decideEquipmentLoan, equipmentAccess } from '../services/equipmentService.js';

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
    await enrichNotificationStates(notifications, { recipient: req.user._id });
    await attachAnnouncementPins(notifications, req.user._id);
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
  if (notification.type !== 'equipment_loan' || !notification.relatedLoan) throw Object.assign(new Error('貸出申込みを確認できません。'), { status: 404 });
  await equipmentAccess(notification.association, userId, true);
  const loan = await EquipmentLoan.findOne({ _id: notification.relatedLoan, association: notification.association })
    .populate('borrower', 'displayname username').lean();
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
    const unreadCount = await Notification.countDocuments({ recipient: req.user._id, readAt: null, hiddenAt: null });
    res.json({ unreadCount });
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
    const notification = await Notification.findOne({ _id: req.params.notificationId, recipient: req.user._id }).select('association type relatedLoan').lean();
    if (!notification) return res.status(404).json({ error: 'notification_not_found' });
    return res.json({ loan: await equipmentLoanPayload({ notification, userId: req.user._id }), csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

notificationsRouter.post('/:notificationId/equipment-loan', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.notificationId)) return res.status(404).json({ error: 'notification_not_found' });
    const notification = await Notification.findOne({ _id: req.params.notificationId, recipient: req.user._id }).select('association type relatedLoan').lean();
    if (!notification) return res.status(404).json({ error: 'notification_not_found' });
    if (!['approved', 'rejected'].includes(req.body.action)) return res.status(400).json({ error: 'invalid_equipment_loan_action' });
    await equipmentLoanPayload({ notification, userId: req.user._id });
    await decideEquipmentLoan({ associationId: notification.association, userId: req.user._id, loanId: notification.relatedLoan, action: req.body.action });
    return res.json({ loan: await equipmentLoanPayload({ notification, userId: req.user._id }), csrfToken: req.session.csrfToken });
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

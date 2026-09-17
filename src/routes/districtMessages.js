import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { DistrictGroup } from '../models/organization.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { publishAnnouncement, confirmAnnouncement, loadRecipientAnnouncement, remindAnnouncement, requireDistrictMember, isCurrentDistrictLeader, summarizeAnnouncementResponses } from '../services/officerAnnouncementService.js';

export const districtMessagesRouter = express.Router();
districtMessagesRouter.use(requireLogin);
const base = associationId => `/associations/${associationId}/district-messages`;
const fail = (message, status = 404) => Object.assign(new Error(message), { status });
const context = async (associationId, userId) => {
  if (!mongoose.isValidObjectId(associationId)) throw fail('町内会を確認できません。');
  const membership = await requireDistrictMember(associationId, userId);
  const [association, districtGroup, isLeader] = await Promise.all([
    NeighborhoodAssociation.findOne({ _id: associationId, status: 'active', deletedAt: { $exists: false } }).select('name').lean(),
    DistrictGroup.findOne({ _id: membership.districtGroup, association: associationId }).select('name').lean(),
    isCurrentDistrictLeader(associationId, membership.districtGroup, userId)
  ]);
  if (!association || !districtGroup) throw fail('班を確認できません。');
  return { association, districtGroup, membership, isLeader };
};
const sentAnnouncement = async (associationId, announcementId, userId, districtGroup) => {
  if (!mongoose.isValidObjectId(announcementId)) throw fail('連絡を確認できません。');
  const announcement = await OfficerAnnouncement.findOne({ _id: announcementId, association: associationId, channel: 'district', sender: userId, districtGroup }).lean();
  if (!announcement) throw fail('連絡を確認できません。');
  return announcement;
};

districtMessagesRouter.get('/:associationId/district-messages', async (req, res, next) => {
  try {
    const { association, districtGroup, isLeader } = await context(req.params.associationId, req.user._id);
    const announcements = await OfficerAnnouncement.find({ association: association._id, channel: 'district', districtGroup: districtGroup._id, sender: req.user._id }).sort({ createdAt: -1 }).limit(50).lean();
    const [receipts, myReceipts] = await Promise.all([
      OfficerAnnouncementReceipt.find({ announcement: { $in: announcements.map(item => item._id) } }).select('announcement readAt').lean(),
      OfficerAnnouncementReceipt.find({ association: association._id, recipient: req.user._id, readAt: null }).populate('announcement', 'channel districtGroup').lean()
    ]);
    const rows = announcements.map(item => ({ ...item, recipientCount: receipts.filter(receipt => String(receipt.announcement) === String(item._id)).length,
      unreadCount: receipts.filter(receipt => String(receipt.announcement) === String(item._id) && !receipt.readAt).length }));
    const unreadCount = myReceipts.filter(item => item.announcement?.channel === 'district' && String(item.announcement.districtGroup) === String(districtGroup._id)).length;
    return res.render('district-messages', { title: `${districtGroup.name} 班内の連絡`, association, districtGroup, isLeader, announcements: rows, unreadCount });
  } catch (error) { return next(error); }
});

districtMessagesRouter.get('/:associationId/district-messages/new', async (req, res, next) => {
  try {
    const { association, districtGroup, isLeader } = await context(req.params.associationId, req.user._id);
    const members = await AssociationMembership.find({ association: association._id, districtGroup: districtGroup._id, status: 'active', user: { $ne: req.user._id } })
      .populate('user', 'displayname username').lean();
    return res.render('district-messages-new', { title: '班内の連絡を送る', association, districtGroup, isLeader, members: members.filter(item => item.user) });
  } catch (error) { return next(error); }
});

districtMessagesRouter.post('/:associationId/district-messages', verifyCsrfToken, async (req, res, next) => {
  try {
    await context(req.params.associationId, req.user._id);
    const { announcement, recipientCount } = await publishAnnouncement({ associationId: req.params.associationId, userId: req.user._id, channel: 'district', audience: req.body.audience,
      targetOfficerIds: req.body.recipientIds, urgency: req.body.urgency, title: req.body.title, body: req.body.body, responseMode: req.body.responseMode,
      options: [req.body.option1, req.body.option2, req.body.option3, req.body.option4, req.body.option5] });
    req.session.notice = `${recipientCount}人の班員に連絡を送りました。`;
    return res.redirect(`${base(req.params.associationId)}/${announcement._id}`);
  } catch (error) { return next(error); }
});

districtMessagesRouter.get('/:associationId/district-messages/inbox', async (req, res, next) => {
  try {
    const { association, districtGroup } = await context(req.params.associationId, req.user._id);
    const receipts = await OfficerAnnouncementReceipt.find({ association: association._id, recipient: req.user._id }).populate('announcement').sort({ createdAt: -1 }).lean();
    return res.render('resident-announcements', { title: '届いた班内の連絡', association,
      receipts: receipts.filter(item => item.announcement?.channel === 'district' && String(item.announcement.districtGroup) === String(districtGroup._id)), districtMode: true });
  } catch (error) { return next(error); }
});

districtMessagesRouter.get('/:associationId/district-messages/inbox/:announcementId', async (req, res, next) => {
  try {
    const { districtGroup } = await context(req.params.associationId, req.user._id);
    const { announcement, receipt } = await loadRecipientAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, channel: 'district' });
    if (String(announcement.districtGroup) !== String(districtGroup._id)) throw fail('連絡を確認できません。', 403);
    return res.render('resident-announcement-detail', { title: announcement.title, associationId: req.params.associationId, announcement, receipt, districtMode: true });
  } catch (error) { return next(error); }
});

districtMessagesRouter.post('/:associationId/district-messages/inbox/:announcementId/confirm', verifyCsrfToken, async (req, res, next) => {
  try {
    const { districtGroup } = await context(req.params.associationId, req.user._id);
    const { announcement } = await loadRecipientAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, channel: 'district' });
    if (String(announcement.districtGroup) !== String(districtGroup._id)) throw fail('連絡を確認できません。', 403);
    const confirmed = await confirmAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, selectedOptions: req.body.selectedOptions, channel: 'district' });
    req.session.notice = confirmed.responseMode === 'none' ? '連絡を確認しました。' : '連絡に回答しました。';
    return res.redirect('/dashboard');
  } catch (error) { return next(error); }
});

districtMessagesRouter.get('/:associationId/district-messages/:announcementId', async (req, res, next) => {
  try {
    const { association, districtGroup } = await context(req.params.associationId, req.user._id);
    const announcement = await sentAnnouncement(association._id, req.params.announcementId, req.user._id, districtGroup._id);
    const receipts = await OfficerAnnouncementReceipt.find({ announcement: announcement._id }).populate('recipient', 'displayname username').sort({ readAt: 1 }).lean();
    return res.render('officer-announcement-detail', { title: announcement.title, association, announcement, receipts,
      responseSummary: summarizeAnnouncementResponses(announcement, receipts), districtMode: true });
  } catch (error) { return next(error); }
});

districtMessagesRouter.post('/:associationId/district-messages/:announcementId/remind', verifyCsrfToken, async (req, res, next) => {
  try {
    const { association, districtGroup } = await context(req.params.associationId, req.user._id);
    await sentAnnouncement(association._id, req.params.announcementId, req.user._id, districtGroup._id);
    const count = await remindAnnouncement({ associationId: association._id, announcementId: req.params.announcementId, userId: req.user._id, recipientId: req.body.recipientId || null, channel: 'district' });
    req.session.notice = `${count}人の未確認班員に再通知しました。`;
    return res.redirect(`${base(req.params.associationId)}/${req.params.announcementId}`);
  } catch (error) { return next(error); }
});

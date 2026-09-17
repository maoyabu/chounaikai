import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { loadQuestionBoxAccess } from '../services/questionBoxService.js';
import { confirmAnnouncement, loadRecipientAnnouncement, publishAnnouncement, remindAnnouncement, requireAnnouncementOfficer, summarizeAnnouncementResponses } from '../services/officerAnnouncementService.js';

export const officerAnnouncementsRouter = express.Router();
officerAnnouncementsRouter.use(requireLogin);
const checkedId = value => {
  if (!mongoose.isValidObjectId(value)) throw Object.assign(new Error('連絡を確認できません。'), { status: 404 });
  return value;
};

officerAnnouncementsRouter.get('/:associationId/announcements/officer', async (req, res, next) => {
  try {
    const association = await requireAnnouncementOfficer(req.params.associationId, req.user._id);
    const announcements = await OfficerAnnouncement.find({ association: association._id, channel: { $ne: 'officer' } }).sort({ createdAt: -1 }).limit(50).lean();
    const receipts = await OfficerAnnouncementReceipt.find({ announcement: { $in: announcements.map(item => item._id) } }).select('announcement readAt').lean();
    const rows = announcements.map(item => ({ ...item, recipientCount: receipts.filter(receipt => String(receipt.announcement) === String(item._id)).length,
      unreadCount: receipts.filter(receipt => String(receipt.announcement) === String(item._id) && !receipt.readAt).length }));
    return res.render('officer-announcements', { title: `${association.name} 町内会役員から住人への連絡`, association, announcements: rows });
  } catch (error) { return next(error); }
});

officerAnnouncementsRouter.get('/:associationId/announcements/officer/new', async (req, res, next) => {
  try {
    const association = await requireAnnouncementOfficer(req.params.associationId, req.user._id);
    return res.render('officer-announcement-new', { title: '役員から連絡を送る', association });
  } catch (error) { return next(error); }
});

officerAnnouncementsRouter.post('/:associationId/announcements/officer', verifyCsrfToken, async (req, res, next) => {
  try {
    const { announcement, recipientCount } = await publishAnnouncement({ associationId: req.params.associationId, userId: req.user._id, ...req.body,
      options: [req.body.option1, req.body.option2, req.body.option3, req.body.option4, req.body.option5] });
    req.session.notice = `${recipientCount}人に連絡を送りました。`;
    return res.redirect(`/associations/${req.params.associationId}/announcements/officer/${announcement._id}`);
  } catch (error) { return next(error); }
});

officerAnnouncementsRouter.get('/:associationId/announcements/officer/:announcementId', async (req, res, next) => {
  try {
    const association = await requireAnnouncementOfficer(req.params.associationId, req.user._id);
    const announcement = await OfficerAnnouncement.findOne({ _id: checkedId(req.params.announcementId), association: association._id, channel: { $ne: 'officer' } }).lean();
    if (!announcement) return next(Object.assign(new Error('連絡を確認できません。'), { status: 404 }));
    const receipts = await OfficerAnnouncementReceipt.find({ announcement: announcement._id }).populate('recipient', 'displayname username').sort({ readAt: 1 }).lean();
    const responseSummary = summarizeAnnouncementResponses(announcement, receipts);
    return res.render('officer-announcement-detail', { title: announcement.title, association, announcement, receipts, responseSummary });
  } catch (error) { return next(error); }
});

officerAnnouncementsRouter.post('/:associationId/announcements/officer/:announcementId/remind', verifyCsrfToken, async (req, res, next) => {
  try {
    const count = await remindAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, recipientId: req.body.recipientId || null, channel: 'resident' });
    req.session.notice = `${count}人の未確認者に再通知しました。`;
    return res.redirect(`/associations/${req.params.associationId}/announcements/officer/${req.params.announcementId}`);
  } catch (error) { return next(error); }
});

officerAnnouncementsRouter.get('/:associationId/announcements', async (req, res, next) => {
  try {
    const { association } = await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id });
    const receipts = await OfficerAnnouncementReceipt.find({ association: association._id, recipient: req.user._id })
      .populate('announcement').sort({ createdAt: -1 }).lean();
    return res.render('resident-announcements', { title: `${association.name} 町内会役員から住人への連絡`, association, receipts: receipts.filter(item => item.announcement && (item.announcement.channel || 'resident') === 'resident') });
  } catch (error) { return next(error); }
});

officerAnnouncementsRouter.get('/:associationId/announcements/:announcementId', async (req, res, next) => {
  try {
    const { announcement, receipt } = await loadRecipientAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, channel: 'resident' });
    return res.render('resident-announcement-detail', { title: announcement.title, associationId: req.params.associationId, announcement, receipt });
  } catch (error) { return next(error); }
});

officerAnnouncementsRouter.post('/:associationId/announcements/:announcementId/confirm', verifyCsrfToken, async (req, res, next) => {
  try {
    const announcement = await confirmAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, selectedOptions: req.body.selectedOptions, channel: 'resident' });
    req.session.notice = announcement.responseMode === 'none' ? '連絡を確認しました。' : '連絡に回答しました。';
    return res.redirect('/dashboard');
  } catch (error) { return next(error); }
});

import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { loadQuestionBoxAccess } from '../services/questionBoxService.js';
import { confirmAnnouncement, loadRecipientAnnouncement, publishAnnouncement, remindAnnouncement, requireAnnouncementOfficer, summarizeAnnouncementResponses, updateAnnouncementVisibility } from '../services/officerAnnouncementService.js';
import { acceptAnnouncementAttachments, repairMojibakeFilename } from '../services/announcementAttachmentService.js';

export const officerAnnouncementsRouter = express.Router();
officerAnnouncementsRouter.use(requireLogin);
const checkedId = value => {
  if (!mongoose.isValidObjectId(value)) throw Object.assign(new Error('連絡を確認できません。'), { status: 404 });
  return value;
};

officerAnnouncementsRouter.get('/:associationId/announcements/officer', async (req, res, next) => {
  try {
    const association = await requireAnnouncementOfficer(req.params.associationId, req.user._id);
    const announcements = await OfficerAnnouncement.find({ association: association._id, sender: req.user._id, $or: [{ channel: 'resident' }, { channel: { $exists: false } }] }).populate('sender', 'displayname username').sort({ createdAt: -1 }).limit(50).lean();
    const receipts = await OfficerAnnouncementReceipt.find({ announcement: { $in: announcements.map(item => item._id) } }).select('announcement readAt').lean();
    const rows = announcements.map(item => ({ ...item, recipientCount: receipts.filter(receipt => String(receipt.announcement) === String(item._id)).length,
      unreadCount: receipts.filter(receipt => String(receipt.announcement) === String(item._id) && !receipt.readAt).length }));
    return res.render('officer-announcements', { title: `${association.name} 町内会役員から住人への連絡`, association, announcements: rows.filter(item => !item.mutedAt), mutedAnnouncements: rows.filter(item => item.mutedAt) });
  } catch (error) { return next(error); }
});

officerAnnouncementsRouter.get('/:associationId/announcements/officer/new', async (req, res, next) => {
  try {
    const association = await requireAnnouncementOfficer(req.params.associationId, req.user._id);
    return res.render('officer-announcement-new', { title: '役員から連絡を送る', association });
  } catch (error) { return next(error); }
});


officerAnnouncementsRouter.post('/:associationId/announcements/officer', acceptAnnouncementAttachments, verifyCsrfToken, async (req, res, next) => {
  try {
    const { announcement, recipientCount } = await publishAnnouncement({ associationId: req.params.associationId, userId: req.user._id, ...req.body, files: req.files,
      options: [req.body.option1, req.body.option2, req.body.option3, req.body.option4, req.body.option5] });
    req.session.notice = `${recipientCount}人に連絡を送りました。`;
    return res.redirect(`/associations/${req.params.associationId}/announcements/officer/${announcement._id}`);
  } catch (error) { return next(error); }
});

officerAnnouncementsRouter.get('/:associationId/announcements/officer/:announcementId', async (req, res, next) => {
  try {
    const association = await requireAnnouncementOfficer(req.params.associationId, req.user._id);
    const announcement = await OfficerAnnouncement.findOne({ _id: checkedId(req.params.announcementId), association: association._id, $or: [{ channel: 'resident' }, { channel: { $exists: false } }] }).lean();
    if (!announcement) return next(Object.assign(new Error('連絡を確認できません。'), { status: 404 }));
    announcement.attachments = (announcement.attachments || []).map(file => ({ ...file, originalName: repairMojibakeFilename(file.originalName) }));
    const receipts = await OfficerAnnouncementReceipt.find({ announcement: announcement._id }).populate('recipient', 'displayname username').sort({ readAt: 1 }).lean();
    const memberships = await AssociationMembership.find({ association: association._id, user: { $in: receipts.map(item => item.recipient?._id).filter(Boolean) }, status: 'active' }).populate('districtGroup', 'name').select('user districtGroup').lean();
    const districtByUser = new Map(memberships.map(item => [String(item.user), item.districtGroup]));
    const groupedReceipts = [...receipts.reduce((groups, receipt) => {
      const group = districtByUser.get(String(receipt.recipient?._id)) || { _id: 'unassigned', name: '班未設定' };
      const key = String(group._id);
      if (!groups.has(key)) groups.set(key, { group, receipts: [] });
      groups.get(key).receipts.push(receipt);
      return groups;
    }, new Map()).values()];
    const responseSummary = summarizeAnnouncementResponses(announcement, receipts);
    return res.render('officer-announcement-detail', { title: announcement.title, association, announcement, receipts, groupedReceipts, responseSummary });
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
      .populate({ path: 'announcement', match: { mutedAt: { $exists: false } } }).sort({ createdAt: -1 }).lean();
    return res.render('resident-announcements', { title: `${association.name} 町内会役員から住人への連絡`, association, receipts: receipts.filter(item => item.announcement && (item.announcement.channel || 'resident') === 'resident') });
  } catch (error) { return next(error); }
});

officerAnnouncementsRouter.post('/:associationId/announcements/officer/:announcementId/edit', verifyCsrfToken, async (req, res, next) => { try { await updateAnnouncementVisibility({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, title: req.body.title, body: req.body.body }); req.session.notice = '連絡を編集しました。'; return res.redirect(`/associations/${req.params.associationId}/announcements/officer/${req.params.announcementId}`); } catch (error) { return next(error); } });
officerAnnouncementsRouter.post('/:associationId/announcements/officer/:announcementId/mute', verifyCsrfToken, async (req, res, next) => { try { await updateAnnouncementVisibility({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, muted: true }); req.session.notice = '連絡をミュートしました。'; return res.redirect(`/associations/${req.params.associationId}/announcements/officer`); } catch (error) { return next(error); } });
officerAnnouncementsRouter.post('/:associationId/announcements/officer/:announcementId/unmute', verifyCsrfToken, async (req, res, next) => { try { await updateAnnouncementVisibility({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, muted: false }); req.session.notice = '連絡を復活しました。'; return res.redirect(`/associations/${req.params.associationId}/announcements/officer`); } catch (error) { return next(error); } });

officerAnnouncementsRouter.get('/:associationId/announcements/:announcementId', async (req, res, next) => {
  try {
    const { announcement, receipt } = await loadRecipientAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, channel: 'resident' });
    announcement.attachments = (announcement.attachments || []).map(file => ({ ...file, originalName: repairMojibakeFilename(file.originalName) }));
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

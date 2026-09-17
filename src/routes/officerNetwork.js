import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { Department } from '../models/organization.js';
import { OfficerContactGroup } from '../models/officerContactGroup.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { confirmAnnouncement, loadRecipientAnnouncement, publishAnnouncement, remindAnnouncement, requireAnnouncementOfficer, summarizeAnnouncementResponses } from '../services/officerAnnouncementService.js';
import { deleteOfficerContactGroup, saveOfficerContactGroup } from '../services/officerContactGroupService.js';

export const officerNetworkRouter = express.Router();
officerNetworkRouter.use(requireLogin);
const fiscalYear = (date = new Date()) => date.getMonth() < 3 ? date.getFullYear() - 1 : date.getFullYear();
const checkedId = value => {
  if (!mongoose.isValidObjectId(value)) throw Object.assign(new Error('連絡を確認できません。'), { status: 404 });
  return value;
};
const base = associationId => `/associations/${associationId}/officer-network`;
const loadOfficerDirectory = async associationId => {
  const assignments = await AnnualOfficer.find({ association: associationId, fiscalYear: fiscalYear(), cancelledAt: null })
    .populate('user', 'displayname username').populate('department', 'name').lean();
  const active = await AssociationMembership.find({ association: associationId, status: 'active', user: { $in: assignments.map(item => item.user?._id).filter(Boolean) } }).select('user').lean();
  const activeIds = new Set(active.map(item => String(item.user)));
  return assignments.filter(item => item.user && activeIds.has(String(item.user._id)));
};

officerNetworkRouter.get('/:associationId/officer-network', async (req, res, next) => {
  try {
    const association = await requireAnnouncementOfficer(req.params.associationId, req.user._id);
    const announcements = await OfficerAnnouncement.find({ association: association._id, channel: 'officer' }).sort({ createdAt: -1 }).limit(50).lean();
    const receipts = await OfficerAnnouncementReceipt.find({ announcement: { $in: announcements.map(item => item._id) } }).select('announcement readAt').lean();
    const rows = announcements.map(item => ({ ...item, recipientCount: receipts.filter(receipt => String(receipt.announcement) === String(item._id)).length,
      unreadCount: receipts.filter(receipt => String(receipt.announcement) === String(item._id) && !receipt.readAt).length }));
    const [groups, myReceipts] = await Promise.all([
      OfficerContactGroup.find({ association: association._id }).select('_id').lean(),
      OfficerAnnouncementReceipt.find({ association: association._id, recipient: req.user._id, readAt: null }).populate('announcement', 'channel').lean()
    ]);
    return res.render('officer-network', { title: `${association.name} 役員間の連絡網`, association, announcements: rows,
      groupCount: groups.length, unreadReceivedCount: myReceipts.filter(item => item.announcement?.channel === 'officer').length });
  } catch (error) { return next(error); }
});

officerNetworkRouter.get('/:associationId/officer-network/new', async (req, res, next) => {
  try {
    const association = await requireAnnouncementOfficer(req.params.associationId, req.user._id);
    const [officers, departments, groups] = await Promise.all([
      loadOfficerDirectory(association._id), Department.find({ association: association._id, active: true }).sort('sortOrder name').lean(),
      OfficerContactGroup.find({ association: association._id }).sort('name').lean()
    ]);
    return res.render('officer-network-new', { title: '役員間の連絡を送る', association, officers, departments, groups });
  } catch (error) { return next(error); }
});

officerNetworkRouter.post('/:associationId/officer-network', verifyCsrfToken, async (req, res, next) => {
  try {
    const { announcement, recipientCount } = await publishAnnouncement({ associationId: req.params.associationId, userId: req.user._id,
      channel: 'officer', audience: req.body.audience, targetId: req.body.targetId, targetOfficerIds: req.body.targetOfficerIds, urgency: req.body.urgency,
      title: req.body.title, body: req.body.body, responseMode: req.body.responseMode,
      options: [req.body.option1, req.body.option2, req.body.option3, req.body.option4, req.body.option5] });
    req.session.notice = `${recipientCount}人の役員に連絡を送りました。`;
    return res.redirect(`${base(req.params.associationId)}/${announcement._id}`);
  } catch (error) { return next(error); }
});

officerNetworkRouter.get('/:associationId/officer-network/groups', async (req, res, next) => {
  try {
    const association = await requireAnnouncementOfficer(req.params.associationId, req.user._id);
    const [officers, groups] = await Promise.all([
      loadOfficerDirectory(association._id), OfficerContactGroup.find({ association: association._id }).sort('name').lean()
    ]);
    return res.render('officer-network-groups', { title: '役員グループ', association, officers, groups });
  } catch (error) { return next(error); }
});

officerNetworkRouter.post('/:associationId/officer-network/groups', verifyCsrfToken, async (req, res, next) => {
  try {
    await saveOfficerContactGroup({ associationId: req.params.associationId, userId: req.user._id, name: req.body.name, members: req.body.members });
    req.session.notice = '役員グループを作成しました。';
    return res.redirect(`${base(req.params.associationId)}/groups`);
  } catch (error) { return next(error); }
});

officerNetworkRouter.post('/:associationId/officer-network/groups/:groupId/update', verifyCsrfToken, async (req, res, next) => {
  try {
    await saveOfficerContactGroup({ associationId: req.params.associationId, userId: req.user._id, groupId: req.params.groupId, name: req.body.name, members: req.body.members });
    req.session.notice = '役員グループを更新しました。';
    return res.redirect(`${base(req.params.associationId)}/groups`);
  } catch (error) { return next(error); }
});

officerNetworkRouter.post('/:associationId/officer-network/groups/:groupId/delete', verifyCsrfToken, async (req, res, next) => {
  try {
    await deleteOfficerContactGroup({ associationId: req.params.associationId, userId: req.user._id, groupId: req.params.groupId });
    req.session.notice = '役員グループを削除しました。';
    return res.redirect(`${base(req.params.associationId)}/groups`);
  } catch (error) { return next(error); }
});

officerNetworkRouter.get('/:associationId/officer-network/inbox', async (req, res, next) => {
  try {
    const association = await requireAnnouncementOfficer(req.params.associationId, req.user._id);
    const receipts = await OfficerAnnouncementReceipt.find({ association: association._id, recipient: req.user._id })
      .populate('announcement').sort({ createdAt: -1 }).lean();
    return res.render('resident-announcements', { title: '届いた役員間の連絡', association, receipts: receipts.filter(item => item.announcement?.channel === 'officer'), networkMode: true });
  } catch (error) { return next(error); }
});

officerNetworkRouter.get('/:associationId/officer-network/inbox/:announcementId', async (req, res, next) => {
  try {
    await requireAnnouncementOfficer(req.params.associationId, req.user._id);
    const { announcement, receipt } = await loadRecipientAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, channel: 'officer' });
    return res.render('resident-announcement-detail', { title: announcement.title, associationId: req.params.associationId, announcement, receipt, networkMode: true });
  } catch (error) { return next(error); }
});

officerNetworkRouter.post('/:associationId/officer-network/inbox/:announcementId/confirm', verifyCsrfToken, async (req, res, next) => {
  try {
    await requireAnnouncementOfficer(req.params.associationId, req.user._id);
    const announcement = await confirmAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, selectedOptions: req.body.selectedOptions, channel: 'officer' });
    req.session.notice = announcement.responseMode === 'none' ? '連絡を確認しました。' : '連絡に回答しました。';
    return res.redirect('/dashboard');
  } catch (error) { return next(error); }
});

officerNetworkRouter.get('/:associationId/officer-network/:announcementId', async (req, res, next) => {
  try {
    const association = await requireAnnouncementOfficer(req.params.associationId, req.user._id);
    const announcement = await OfficerAnnouncement.findOne({ _id: checkedId(req.params.announcementId), association: association._id, channel: 'officer' })
      .populate('targetDepartment', 'name').populate('targetOfficer', 'displayname username').populate('targetGroup', 'name').lean();
    if (!announcement) return next(Object.assign(new Error('連絡を確認できません。'), { status: 404 }));
    const receipts = await OfficerAnnouncementReceipt.find({ announcement: announcement._id }).populate('recipient', 'displayname username').sort({ readAt: 1 }).lean();
    return res.render('officer-announcement-detail', { title: announcement.title, association, announcement, receipts,
      responseSummary: summarizeAnnouncementResponses(announcement, receipts), networkMode: true });
  } catch (error) { return next(error); }
});

officerNetworkRouter.post('/:associationId/officer-network/:announcementId/remind', verifyCsrfToken, async (req, res, next) => {
  try {
    const count = await remindAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id,
      recipientId: req.body.recipientId || null, channel: 'officer' });
    req.session.notice = `${count}人の未確認役員に再通知しました。`;
    return res.redirect(`${base(req.params.associationId)}/${req.params.announcementId}`);
  } catch (error) { return next(error); }
});

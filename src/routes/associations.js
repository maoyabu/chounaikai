import express from 'express';
import mongoose from 'mongoose';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { requireLogin, requireSystemAdmin } from '../middleware/auth.js';
import { approveAssociation, hideAssociation, permanentlyDeleteAssociation, restoreAssociation } from '../services/associationService.js';
import { loadMobileHome } from '../services/mobileHomeService.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { confirmAnnouncement, loadRecipientAnnouncement } from '../services/officerAnnouncementService.js';
import { communicationCategory, mobileCommunication } from '../services/mobileCommunicationService.js';
import { User } from '../models/user.js';
import { loadResidentSafety, saveResidentSafety } from '../services/safetyService.js';
import { buildingStatuses, memberSafetyStatus, safetyEventKey, safetyStatuses } from '../lib/safetyStatus.js';

export const associationsRouter = express.Router();

associationsRouter.use(requireLogin);
const associationResponse = association => {
  const { officerDisclosureHistory, ...record } = association.toObject?.() || association;
  return record;
};

associationsRouter.get('/home', async (req, res, next) => {
  try {
    const home = await loadMobileHome({ userId: req.user._id });
    await req.auditPersonalData?.({ category: 'registration', resource: 'api-mobile-home', data: home });
    return res.json(home);
  } catch (error) {
    return next(error);
  }
});

const mobileSafety = (context, csrfToken) => ({
  association: {
    id: String(context.association._id),
    name: context.association.name,
    alertLevel: context.association.alertLevel || 0,
    eventKey: safetyEventKey(context.association)
  },
  household: context.household ? { id: String(context.household._id), name: context.household.displayName } : null,
  members: context.members.map(member => ({
    id: String(member._id),
    name: member.user?.displayname || member.user?.username || member.name,
    isRepresentative: Boolean(member.isRepresentative),
    status: memberSafetyStatus(context.report, member._id)
  })),
  buildingStatus: context.report?.buildingStatus || 1,
  updatedAt: context.report?.updatedAt || null,
  safetyStatuses: safetyStatuses.map(([value, label]) => ({ value, label })),
  buildingStatuses: buildingStatuses.map(([value, label]) => ({ value, label })),
  csrfToken
});

associationsRouter.get('/:associationId/safety', provideCsrfToken, async (req, res, next) => {
  try {
    const context = await loadResidentSafety(req.params.associationId, req.user._id);
    res.set('Cache-Control', 'private, no-store');
    return res.json(mobileSafety(context, req.session.csrfToken));
  } catch (error) { return next(error); }
});

associationsRouter.post('/:associationId/safety', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    const entries = req.body.memberStatuses && typeof req.body.memberStatuses === 'object' && !Array.isArray(req.body.memberStatuses)
      ? Object.entries(req.body.memberStatuses) : [];
    const body = {
      eventKey: req.body.eventKey,
      buildingStatus: String(req.body.buildingStatus ?? ''),
      memberIds: entries.map(([id]) => id)
    };
    for (const [id, status] of entries) body[`status_${id}`] = String(status);
    await saveResidentSafety({ associationId: req.params.associationId, userId: req.user._id, body });
    const context = await loadResidentSafety(req.params.associationId, req.user._id);
    res.set('Cache-Control', 'private, no-store');
    return res.json(mobileSafety(context, req.session.csrfToken));
  } catch (error) { return next(error); }
});

associationsRouter.get('/:associationId/communications', provideCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(400).json({ error: 'invalid_association_id' });
    const membership = await AssociationMembership.findOne({ association: req.params.associationId, user: req.user._id, status: 'active' }).lean();
    if (!membership) return res.status(403).json({ error: 'active_membership_required' });
    if (!['emergency', 'announcement'].includes(req.query.category)) return res.status(400).json({ error: 'invalid_category' });

    const receipts = await OfficerAnnouncementReceipt.find({ association: req.params.associationId, recipient: req.user._id })
      .sort({ createdAt: -1 }).limit(100).lean();
    const announcements = await OfficerAnnouncement.find({
      _id: { $in: receipts.map(item => item.announcement) },
      mutedAt: { $exists: false },
      $or: [{ channel: 'resident' }, { channel: { $exists: false } }]
    }).populate('sender', 'displayname username').lean();
    const byId = new Map(announcements.map(item => [String(item._id), item]));
    const communications = receipts.map(receipt => ({ announcement: byId.get(String(receipt.announcement)), receipt }))
      .filter(item => item.announcement && communicationCategory(item.announcement) === req.query.category)
      .map(mobileCommunication);
    res.set('Cache-Control', 'private, no-store');
    return res.json({ communications, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

associationsRouter.get('/:associationId/communications/:announcementId', provideCsrfToken, async (req, res, next) => {
  try {
    const { announcement, receipt } = await loadRecipientAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, channel: 'resident' });
    const sender = await User.findById(announcement.sender).select('displayname username').lean();
    announcement.sender = sender;
    res.set('Cache-Control', 'private, no-store');
    return res.json({ communication: mobileCommunication({ announcement, receipt }), csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

associationsRouter.post('/:associationId/communications/:announcementId/read', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    const { receipt } = await loadRecipientAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, channel: 'resident' });
    await OfficerAnnouncementReceipt.updateOne({ _id: receipt._id, recipient: req.user._id, readAt: null }, { $set: { readAt: new Date() } });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

associationsRouter.post('/:associationId/communications/:announcementId/answer', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    await confirmAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, selectedOptions: req.body.selectedOptions, channel: 'resident' });
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

associationsRouter.get('/', async (req, res, next) => {
  try {
    const memberships = await AssociationMembership.find({ user: req.user._id, status: 'active' }).select('association');
    const associations = await NeighborhoodAssociation.find({ _id: { $in: memberships.map((item) => item.association) }, deletedAt: { $exists: false } }).lean();
    await req.auditPersonalData?.({ category: 'registration', resource: 'api-associations', data: { associations } });
    res.json({ associations: associations.map(associationResponse) });
  } catch (error) {
    next(error);
  }
});

associationsRouter.post('/:associationId/approve', requireSystemAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(400).json({ error: 'invalid_association_id' });
    const association = await NeighborhoodAssociation.findById(req.params.associationId);
    if (!association) return res.status(404).json({ error: 'association_not_found' });
    const result = await approveAssociation({ association, actor: req.user, requestMeta: { requestId: req.get('x-request-id'), ip: req.ip } });
    return res.json({ association: associationResponse(result.association) });
  } catch (error) { return next(error); }
});

associationsRouter.delete('/:associationId', requireSystemAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(400).json({ error: 'invalid_association_id' });
    const association = await NeighborhoodAssociation.findById(req.params.associationId);
    if (!association) return res.status(404).json({ error: 'association_not_found' });
    if (req.query.mode === 'permanent') await permanentlyDeleteAssociation({ association });
    else await hideAssociation({ association, actor: req.user, requestMeta: { requestId: req.get('x-request-id'), ip: req.ip } });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

associationsRouter.post('/:associationId/restore', requireSystemAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(400).json({ error: 'invalid_association_id' });
    const association = await NeighborhoodAssociation.findById(req.params.associationId);
    if (!association) return res.status(404).json({ error: 'association_not_found' });
    await restoreAssociation({ association, actor: req.user, requestMeta: { requestId: req.get('x-request-id'), ip: req.ip } });
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

associationsRouter.get('/:associationId', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(400).json({ error: 'invalid_association_id' });
    const association = await NeighborhoodAssociation.findById(req.params.associationId).lean();
    if (!association) return res.status(404).json({ error: 'association_not_found' });
    const membership = await AssociationMembership.findOne({ association: req.params.associationId, user: req.user._id, status: 'active' });
    const isApplicant = String(association.requestedBy) === String(req.user._id);
    if ((!membership && !req.user.isAdmin && !isApplicant) || (association.deletedAt && !req.user.isAdmin)) return res.status(404).json({ error: 'association_not_found' });
    await req.auditPersonalData?.({ category: 'registration', resource: 'api-association-detail', data: { association, membership } });
    return res.json({ association: associationResponse(association), membership });
  } catch (error) {
    return next(error);
  }
});

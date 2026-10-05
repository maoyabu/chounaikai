import express from 'express';
import mongoose from 'mongoose';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { requireLogin } from '../middleware/auth.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { AssociationEvent } from '../models/associationEvent.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { AssociationGroup, AssociationGroupMembership } from '../models/associationGroup.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { loadQuestionBoxAccess } from '../services/questionBoxService.js';
import { isCurrentDistrictLeader } from '../services/officerAnnouncementService.js';
import { attachmentContext } from '../services/messageAttachmentService.js';
import { assertDriveItem, driveId, FOLDER_MIME } from '../services/driveService.js';
export const messageAttachmentsRouter = express.Router();
const fail = (status = 403) => Object.assign(new Error('添付ファイルを確認できません。'), { status });
const wrap = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
const validAssociation = async req => {
  if (!mongoose.isValidObjectId(req.params.associationId)) throw fail(404);
  const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
  if (!association) throw fail(404);
};
export const canReadMessageAttachment = async (announcement, user) => {
  const membership = await AssociationMembership.findOne({ association: announcement.association, user: user._id, status: 'active' }).lean();
  if (!membership && !user.isAdmin) return false;
  const channel = announcement.channel || 'resident';
  if (user.isAdmin) return true;
  if (channel === 'association_group' && !await AssociationGroupMembership.exists({ association: announcement.association, group: announcement.associationGroup, user: user._id, status: 'active' })) return false;
  if (channel === 'district' && announcement.districtGroup && String(membership?.districtGroup) !== String(announcement.districtGroup)) return false;
  if (channel === 'officer') {
    const access = await loadQuestionBoxAccess({ associationId: announcement.association, userId: user._id });
    if (!access.canAnswer) return false;
  }
  if (String(announcement.sender) === String(user._id)) return true;
  const receipt = await OfficerAnnouncementReceipt.exists({ announcement: announcement._id, recipient: user._id });
  if (receipt) return true;
  if (['resident', 'officer'].includes(channel)) {
    const access = await loadQuestionBoxAccess({ associationId: announcement.association, userId: user._id });
    if (access.canAnswer) return true;
  }
  // 班長メニューで閲覧できる全住人宛て連絡と同じ条件。
  if (channel === 'resident' && announcement.audience === 'all' && membership?.districtGroup &&
      (!announcement.resolvedDistrictGroups?.length || announcement.resolvedDistrictGroups.some(id => String(id) === String(membership.districtGroup)))) {
    return isCurrentDistrictLeader(announcement.association, membership.districtGroup, user._id);
  }
  return false;
};
const streamFile = async (req, res, file, inline = true) => {
  const ctx = await attachmentContext(req.params.associationId);
  const item = await assertDriveItem(ctx.client, ctx.root, file.fileId, { allowRoot: false });
  if (item.mimeType === FOLDER_MIME || item.capabilities?.canDownload === false) throw fail();
  const safeImage = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(item.mimeType);
  const response = await ctx.client.request(`drive/v3/files/${driveId(file.fileId)}?alt=media&supportsAllDrives=true`);
  await req.auditPersonalData?.({ category: 'documents', resource: 'message-or-event-attachment', action: inline && safeImage ? 'view' : 'download', targets: [`file:${file.fileId}`] });
  res.set({ 'Content-Type': inline && safeImage ? item.mimeType : 'application/octet-stream', 'Content-Disposition': `${inline && safeImage ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.originalName || item.name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  await pipeline(Readable.fromWeb(response.body), res);
};
messageAttachmentsRouter.get('/:associationId/message-attachments/:fileId', requireLogin, wrap(async (req, res) => {
  await validAssociation(req);
  const id = driveId(req.params.fileId);
  const announcement = await OfficerAnnouncement.findOne({ association: req.params.associationId, 'attachments.fileId': id }).lean();
  if (!announcement) throw fail(404);
  const file = announcement.attachments.find(file => file.fileId === id);
  if (file.expiresAt && new Date(file.expiresAt) <= new Date()) throw fail(404);
  if (!await canReadMessageAttachment(announcement, req.user)) throw fail();
  await streamFile(req, res, file);
}));
messageAttachmentsRouter.get('/:associationId/event-images/:fileId', wrap(async (req, res) => {
  await validAssociation(req);
  const event = await AssociationEvent.findOne({ association: req.params.associationId, 'image.fileId': driveId(req.params.fileId) }).lean();
  if (!event) throw fail(404);
  let allowed = event.visible && event.open;
  const membership = req.user ? await AssociationMembership.findOne({ association: event.association, user: req.user._id, status: 'active' }).lean() : null;
  if (event.visible && membership) allowed = true;
  if (event.group) {
    const group = await AssociationGroup.findOne({ _id: event.group, association: event.association, status: 'active' }).lean();
    allowed = Boolean(group && event.visible && (group.publicVisibility === 'open' || membership));
    if (req.user && await AssociationGroupMembership.exists({ association: event.association, group: event.group, user: req.user._id, role: 'manager', status: 'active' })) allowed = true;
  }
  if (req.user?.isAdmin) allowed = true;
  if (!allowed && membership) {
    const access = await loadQuestionBoxAccess({ associationId: event.association, userId: req.user._id });
    allowed = access.canAnswer;
  }
  if (!allowed) throw fail();
  await streamFile(req, res, event.image);
}));

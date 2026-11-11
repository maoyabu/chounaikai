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
import { AnnualOfficer } from '../models/annualOfficer.js';
import { OfficerContactGroup } from '../models/officerContactGroup.js';
import { annualRoleYearFilter } from '../lib/annualRoleAccess.js';
import { requireAnnouncementOfficer, publishAnnouncement } from '../services/officerAnnouncementService.js';
import { saveOfficerContactGroup, deleteOfficerContactGroup } from '../services/officerContactGroupService.js';
import { acceptAnnouncementAttachments, uploadAnnouncementAttachment } from '../services/announcementAttachmentService.js';
import { createNotifications } from '../services/notificationService.js';

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

const chatFail = (message, status = 400) => Object.assign(new Error(message), { status });
const chatOptions = body => {
  const mode = ['single', 'multiple'].includes(body.pollMode) ? body.pollMode : 'none';
  let options = [];
  try { options = JSON.parse(body.pollOptions || '[]'); } catch { options = []; }
  options = (Array.isArray(options) ? options : []).map(value => String(value || '').trim()).filter(Boolean);
  if (mode !== 'none' && (options.length < 2 || options.length > 5 || new Set(options).size !== options.length || options.some(value => value.length > 100))) throw chatFail('アンケートの選択肢は重複しない2〜5件で入力してください。');
  return { mode, options: mode === 'none' ? [] : options };
};
const chatMember = async (associationId, topicId, userId) => {
  if (!mongoose.isValidObjectId(topicId)) throw chatFail('トピックを確認できません。', 404);
  await requireAnnouncementOfficer(associationId, userId);
  const topic = await OfficerAnnouncement.findOne({ _id: topicId, association: associationId, channel: 'officer', mutedAt: { $exists: false } });
  if (!topic) throw chatFail('トピックを確認できません。', 404);
  const recipient = await OfficerAnnouncementReceipt.exists({ announcement: topic._id, association: associationId, recipient: userId });
  if (String(topic.sender) !== String(userId) && !recipient) throw chatFail('このトピックの参加者ではありません。', 403);
  return topic;
};
const pollSummary = (options, responses, currentUserId) => ({
  options: options.map((label, index) => ({ label, index, count: responses.filter(response => (response.selectedOptions || []).includes(index)).length })),
  responseCount: responses.length,
  selectedOptions: responses.find(response => String(response.user?._id || response.user) === String(currentUserId))?.selectedOptions || []
});
const mobileChatMessage = (message, currentUserId) => ({
  id: String(message._id), sender: { id: String(message.sender?._id || message.sender), name: message.sender?.displayname || message.sender?.username || '役員' },
  body: message.body || '', createdAt: message.createdAt, isMine: String(message.sender?._id || message.sender) === String(currentUserId),
  attachments: (message.attachments || []).map(file => ({ name: file.originalName, mimeType: file.mimeType, url: file.url })),
  pollMode: message.pollMode || 'none', poll: pollSummary(message.pollOptions || [], message.pollResponses || [], currentUserId)
});

associationsRouter.get('/:associationId/officer-chat', provideCsrfToken, async (req, res, next) => {
  try {
    const association = await requireAnnouncementOfficer(req.params.associationId, req.user._id);
    const assignments = await AnnualOfficer.find({ association: association._id, fiscalYear: annualRoleYearFilter(), cancelledAt: null }).populate('user', 'displayname username').populate('department', 'name').lean();
    const activeIds = new Set((await AssociationMembership.find({ association: association._id, status: 'active' }).distinct('user')).map(String));
    const officersById = new Map();
    for (const assignment of assignments) if (assignment.user && activeIds.has(String(assignment.user._id))) officersById.set(String(assignment.user._id), { id: String(assignment.user._id), name: assignment.user.displayname || assignment.user.username, role: assignment.department?.name || '役員' });
    const [groups, receipts, sent] = await Promise.all([
      OfficerContactGroup.find({ association: association._id }).populate('members', 'displayname username').sort('name').lean(),
      OfficerAnnouncementReceipt.find({ association: association._id, recipient: req.user._id }).populate({ path: 'announcement', match: { channel: 'officer', mutedAt: { $exists: false } }, populate: { path: 'sender', select: 'displayname username' } }).lean(),
      OfficerAnnouncement.find({ association: association._id, channel: 'officer', sender: req.user._id, mutedAt: { $exists: false } }).populate('sender', 'displayname username').lean()
    ]);
    const receiptByTopic = new Map(receipts.filter(item => item.announcement).map(item => [String(item.announcement._id), item]));
    const sameMembers = (first, second) => first.size === second.size && [...first].every(id => second.has(id));
    const allOfficerIds = new Set(officersById.keys());
    const topics = [...new Map([...receipts.filter(item => item.announcement).map(item => [String(item.announcement._id), item.announcement]), ...sent.map(item => [String(item._id), item])]).values()]
      .map(topic => {
        const targetIds = new Set((topic.targetOfficers || []).map(String));
        const participantIds = new Set([...targetIds, String(topic.sender?._id || topic.sender)]);
        const matchingGroup = groups.find(group => sameMembers(targetIds, new Set(group.members.map(member => String(member._id)))));
        const isAll = sameMembers(participantIds, allOfficerIds);
        const ownReceipt = receiptByTopic.get(String(topic._id));
        return {
        id: String(topic._id),
        title: topic.title,
        preview: topic.conversationMessages?.at(-1)?.body || topic.body,
        senderName: topic.sender?.displayname || topic.sender?.username || '役員',
        updatedAt: topic.conversationMessages?.at(-1)?.createdAt || topic.createdAt,
        unread: Boolean(ownReceipt && !ownReceipt.readAt),
        hidden: Boolean(ownReceipt?.chatHiddenAt),
        audienceLabel: isAll ? '全員' : matchingGroup?.name || '選択メンバー',
        isAll,
        canDelete: String(topic.sender?._id || topic.sender) === String(req.user._id),
        participantCount: participantIds.size
      };
      })
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return res.json({ association: { id: String(association._id), name: association.name }, officers: [...officersById.values()], groups: groups.map(group => ({ id: String(group._id), name: group.name, members: group.members.map(member => ({ id: String(member._id), name: member.displayname || member.username })) })), topics, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

associationsRouter.post('/:associationId/officer-chat/topics', provideCsrfToken, acceptAnnouncementAttachments, verifyCsrfToken, async (req, res, next) => {
  try {
    let participantIds = [];
    try { participantIds = JSON.parse(req.body.participantIds || '[]'); } catch { participantIds = []; }
    const poll = chatOptions(req.body);
    const result = await publishAnnouncement({ files: req.files, attachmentRetentionDays: 365, associationId: req.params.associationId, userId: req.user._id, channel: 'officer', audience: 'officer_individual', targetOfficerIds: participantIds, urgency: 1, title: req.body.title, body: req.body.body, responseMode: poll.mode, options: poll.options });
    await OfficerAnnouncementReceipt.updateOne(
      { announcement: result.announcement._id, association: req.params.associationId, recipient: req.user._id },
      { $set: { readAt: new Date() } },
      { upsert: true }
    );
    return res.status(201).json({ id: String(result.announcement._id), csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

associationsRouter.get('/:associationId/officer-chat/topics/:topicId', provideCsrfToken, async (req, res, next) => {
  try {
    const topic = await chatMember(req.params.associationId, req.params.topicId, req.user._id);
    const populated = await OfficerAnnouncement.findById(topic._id).populate('sender', 'displayname username').populate('conversationMessages.sender', 'displayname username').lean();
    const receipts = await OfficerAnnouncementReceipt.find({ announcement: topic._id }).populate('recipient', 'displayname username').lean();
    const ownReceipt = receipts.find(item => String(item.recipient?._id || item.recipient) === String(req.user._id));
    if (ownReceipt && !ownReceipt.readAt) await OfficerAnnouncementReceipt.updateOne({ _id: ownReceipt._id }, { $set: { readAt: new Date() } });
    const initial = { _id: populated._id, sender: populated.sender, body: populated.body, attachments: populated.attachments, createdAt: populated.createdAt, pollMode: populated.responseMode, pollOptions: populated.options, pollResponses: receipts.filter(item => item.respondedAt).map(item => ({ user: item.recipient, selectedOptions: item.selectedOptions, respondedAt: item.respondedAt })) };
    const participants = [...new Map([populated.sender, ...receipts.map(item => item.recipient)].filter(Boolean).map(user => [String(user._id), { id: String(user._id), name: user.displayname || user.username }])).values()];
    return res.json({ topic: { id: String(populated._id), title: populated.title, participants, messages: [mobileChatMessage(initial, req.user._id), ...(populated.conversationMessages || []).map(message => mobileChatMessage(message, req.user._id))] }, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

associationsRouter.post('/:associationId/officer-chat/topics/:topicId/messages', provideCsrfToken, acceptAnnouncementAttachments, verifyCsrfToken, async (req, res, next) => {
  try {
    const topic = await chatMember(req.params.associationId, req.params.topicId, req.user._id);
    const body = String(req.body.body || '').trim();
    const poll = chatOptions(req.body);
    if (!body && !req.files?.length && poll.mode === 'none') throw chatFail('メッセージ、添付ファイル、またはアンケートを入力してください。');
    const expiresAt = new Date(Date.now() + 365 * 86400000), attachments = [];
    for (const file of req.files || []) attachments.push({ ...(await uploadAnnouncementAttachment(file, req.params.associationId)), expiresAt });
    topic.conversationMessages.push({ sender: req.user._id, body, attachments, pollMode: poll.mode, pollOptions: poll.options });
    await topic.save();
    await OfficerAnnouncementReceipt.updateMany({ announcement: topic._id, recipient: { $ne: req.user._id } }, { $set: { readAt: null } });
    const recipients = await OfficerAnnouncementReceipt.find({ announcement: topic._id, recipient: { $ne: req.user._id } }).distinct('recipient');
    try {
      await createNotifications(recipients.map(recipient => ({ association: req.params.associationId, recipient, type: 'officer_network', title: `役員間の会話：${topic.title}`, body: `${req.user.displayname || req.user.username}さんから新しいメッセージが届きました。`, relatedType: 'OfficerAnnouncement', relatedId: topic._id })));
    } catch (notificationError) {
      console.error('Failed to create officer chat notifications:', notificationError);
    }
    return res.status(201).json({ ok: true, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

associationsRouter.post('/:associationId/officer-chat/topics/:topicId/messages/:messageId/poll', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    const topic = await chatMember(req.params.associationId, req.params.topicId, req.user._id);
    const selected = (Array.isArray(req.body.selectedOptions) ? req.body.selectedOptions : []).map(Number);
    if (req.params.messageId === String(topic._id)) {
      await confirmAnnouncement({ associationId: req.params.associationId, announcementId: topic._id, userId: req.user._id, selectedOptions: selected, channel: 'officer' });
    } else {
      const message = topic.conversationMessages.id(req.params.messageId);
      if (!message || message.pollMode === 'none' || !selected.length || (message.pollMode === 'single' && selected.length !== 1) || selected.some(index => !Number.isInteger(index) || index < 0 || index >= message.pollOptions.length)) throw chatFail('アンケートの回答を確認してください。');
      message.pollResponses = (message.pollResponses || []).filter(response => String(response.user) !== String(req.user._id));
      message.pollResponses.push({ user: req.user._id, selectedOptions: [...new Set(selected)], respondedAt: new Date() });
      await topic.save();
    }
    return res.json({ ok: true, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

associationsRouter.post('/:associationId/officer-chat/topics/:topicId/visibility', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    const topic = await chatMember(req.params.associationId, req.params.topicId, req.user._id);
    const hidden = req.body.hidden === true;
    const result = await OfficerAnnouncementReceipt.updateOne(
      { announcement: topic._id, association: req.params.associationId, recipient: req.user._id },
      hidden ? { $set: { chatHiddenAt: new Date() } } : { $unset: { chatHiddenAt: 1 } },
      { upsert: String(topic.sender) === String(req.user._id) }
    );
    if (!result.matchedCount && !result.upsertedCount) throw chatFail('トピックの表示状態を変更できません。', 403);
    return res.json({ ok: true, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

associationsRouter.delete('/:associationId/officer-chat/topics/:topicId', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    const topic = await chatMember(req.params.associationId, req.params.topicId, req.user._id);
    if (String(topic.sender) !== String(req.user._id)) throw chatFail('トピックを削除できるのは作成者だけです。', 403);
    topic.mutedAt = new Date();
    topic.mutedBy = req.user._id;
    await topic.save();
    return res.status(204).end();
  } catch (error) { return next(error); }
});

associationsRouter.post('/:associationId/officer-chat/groups', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try { const group = await saveOfficerContactGroup({ associationId: req.params.associationId, userId: req.user._id, name: req.body.name, members: req.body.members }); return res.status(201).json({ id: String(group._id), csrfToken: req.session.csrfToken }); } catch (error) { return next(error); }
});
associationsRouter.post('/:associationId/officer-chat/groups/:groupId', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try { await saveOfficerContactGroup({ associationId: req.params.associationId, userId: req.user._id, groupId: req.params.groupId, name: req.body.name, members: req.body.members }); return res.json({ ok: true, csrfToken: req.session.csrfToken }); } catch (error) { return next(error); }
});
associationsRouter.delete('/:associationId/officer-chat/groups/:groupId', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try { await deleteOfficerContactGroup({ associationId: req.params.associationId, userId: req.user._id, groupId: req.params.groupId }); return res.status(204).end(); } catch (error) { return next(error); }
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

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
import { DistrictGroup } from '../models/organization.js';
import { AssociationGroupMembership } from '../models/associationGroup.js';
import { ConversationContactGroup } from '../models/conversationContactGroup.js';
import { RoleAssignment, RoleDefinition } from '../models/role.js';

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
    const managerRoles = await RoleDefinition.find({ association: association._id, active: true, permissions: 'association.manage' }).distinct('_id');
    const now = new Date();
    const managers = managerRoles.length ? await RoleAssignment.find({ association: association._id, role: { $in: managerRoles }, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] }).populate('user', 'displayname username').lean() : [];
    const activeIds = new Set((await AssociationMembership.find({ association: association._id, status: 'active' }).distinct('user')).map(String));
    const officersById = new Map();
    for (const assignment of assignments) if (assignment.user && activeIds.has(String(assignment.user._id))) officersById.set(String(assignment.user._id), { id: String(assignment.user._id), name: assignment.user.displayname || assignment.user.username, role: assignment.department?.name || '役員' });
    for (const manager of managers) if (manager.user && activeIds.has(String(manager.user._id)) && !officersById.has(String(manager.user._id))) officersById.set(String(manager.user._id), { id: String(manager.user._id), name: manager.user.displayname || manager.user.username, role: '町内会管理者' });
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
        const lastReadAt = ownReceipt?.chatLastReadAt || ownReceipt?.readAt;
        const unreadMessageCount = [
          { sender: topic.sender, createdAt: topic.createdAt },
          ...(topic.conversationMessages || [])
        ].filter(message => String(message.sender?._id || message.sender) !== String(req.user._id)
          && (!lastReadAt || new Date(message.createdAt) > new Date(lastReadAt))).length;
        return {
        id: String(topic._id),
        title: topic.title,
        preview: topic.conversationMessages?.at(-1)?.body || topic.body,
        senderName: topic.sender?.displayname || topic.sender?.username || '役員',
        updatedAt: topic.conversationMessages?.at(-1)?.createdAt || topic.createdAt,
        unread: unreadMessageCount > 0,
        unreadCount: unreadMessageCount,
        hidden: Boolean(ownReceipt?.chatHiddenAt),
        audienceLabel: isAll ? '全員' : matchingGroup?.name || '選択メンバー',
        isAll,
        canDelete: String(topic.sender?._id || topic.sender) === String(req.user._id),
        participantCount: participantIds.size
      };
      })
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return res.json({ association: { id: String(association._id), name: association.name }, officers: [...officersById.values()], groups: groups.map(group => ({ id: String(group._id), name: group.name, members: group.members.map(member => ({ id: String(member._id), name: member.displayname || member.username })) })), topics, unreadCount: topics.reduce((sum, topic) => sum + topic.unreadCount, 0), csrfToken: req.session.csrfToken });
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
      { $set: { readAt: new Date(), chatLastReadAt: new Date() } },
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
    const readAt = new Date();
    if (ownReceipt) await OfficerAnnouncementReceipt.updateOne({ _id: ownReceipt._id }, { $set: { readAt, chatLastReadAt: readAt } });
    else if (String(topic.sender) === String(req.user._id)) await OfficerAnnouncementReceipt.updateOne(
      { announcement: topic._id, association: req.params.associationId, recipient: req.user._id },
      { $set: { readAt, chatLastReadAt: readAt } },
      { upsert: true }
    );
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
    await OfficerAnnouncementReceipt.updateMany(
      { announcement: topic._id, recipient: { $ne: req.user._id } },
      { $set: { readAt: null }, $unset: { chatHiddenAt: 1 } }
    );
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

const memberChatAccess = async (associationId, scope, userId, requestedContextId) => {
  const membership = await AssociationMembership.findOne({ association: associationId, user: userId, status: 'active' }).lean();
  if (!membership) throw chatFail('参加中の町内会を確認できません。', 403);
  if (scope === 'district') {
    if (!membership.districtGroup) throw chatFail('所属している班を確認できません。', 403);
    const space = await DistrictGroup.findOne({ _id: membership.districtGroup, association: associationId, active: true }).lean();
    if (!space) throw chatFail('所属している班を確認できません。', 403);
    return { channel: 'district', contextId: space._id, spaces: [{ id: String(space._id), name: space.name }] };
  }
  if (scope !== 'group') throw chatFail('コミュニケーションの種類を確認できません。', 404);
  const memberships = await AssociationGroupMembership.find({ association: associationId, user: userId, status: 'active' }).populate({ path: 'group', match: { status: 'active' }, select: 'name' }).lean();
  const spaces = memberships.filter(item => item.group).map(item => ({ id: String(item.group._id), name: item.group.name }));
  if (!spaces.length) throw chatFail('参加中のグループを確認できません。', 403);
  const selected = requestedContextId
    ? spaces.find(space => space.id === String(requestedContextId))
    : spaces[0];
  if (!selected) throw chatFail('参加中のグループを確認できません。', 403);
  return { channel: 'association_group', contextId: selected.id, spaces };
};

const memberChatDirectory = async (associationId, access) => {
  if (access.channel === 'district') {
    const memberships = await AssociationMembership.find({ association: associationId, districtGroup: access.contextId, status: 'active' }).populate('user', 'displayname username').lean();
    return memberships.filter(item => item.user).map(item => ({ id: String(item.user._id), name: item.user.displayname || item.user.username, role: '班員' }));
  }
  const memberships = await AssociationGroupMembership.find({ association: associationId, group: access.contextId, status: 'active' }).populate('user', 'displayname username').lean();
  return memberships.filter(item => item.user).map(item => ({ id: String(item.user._id), name: item.user.displayname || item.user.username, role: item.role === 'manager' ? '管理者' : 'メンバー' }));
};

const memberChatTopic = async (associationId, scope, topicId, userId) => {
  const access = await memberChatAccess(associationId, scope, userId);
  if (!mongoose.isValidObjectId(topicId)) throw chatFail('トピックを確認できません。', 404);
  const contextFilter = access.channel === 'district' ? { districtGroup: access.contextId } : { associationGroup: { $in: access.spaces.map(space => space.id) } };
  const topic = await OfficerAnnouncement.findOne({ _id: topicId, association: associationId, channel: access.channel, ...contextFilter, mutedAt: { $exists: false } });
  if (!topic) throw chatFail('トピックを確認できません。', 404);
  const receipt = await OfficerAnnouncementReceipt.exists({ announcement: topic._id, association: associationId, recipient: userId });
  if (String(topic.sender) !== String(userId) && !receipt) throw chatFail('このトピックの参加者ではありません。', 403);
  return topic;
};

associationsRouter.get('/:associationId/member-chat/:scope', provideCsrfToken, async (req, res, next) => {
  try {
    const access = await memberChatAccess(req.params.associationId, req.params.scope, req.user._id, req.query.contextId);
    const members = await memberChatDirectory(req.params.associationId, access);
    const contextFilter = access.channel === 'district' ? { districtGroup: access.contextId } : { associationGroup: access.contextId };
    const [groups, receipts, sent] = await Promise.all([
      ConversationContactGroup.find({ association: req.params.associationId, channel: access.channel, context: access.contextId }).populate('members', 'displayname username').sort('name').lean(),
      OfficerAnnouncementReceipt.find({ association: req.params.associationId, recipient: req.user._id }).populate({ path: 'announcement', match: { channel: access.channel, ...contextFilter, mutedAt: { $exists: false } }, populate: { path: 'sender', select: 'displayname username' } }).lean(),
      OfficerAnnouncement.find({ association: req.params.associationId, channel: access.channel, ...contextFilter, sender: req.user._id, mutedAt: { $exists: false } }).populate('sender', 'displayname username').lean()
    ]);
    const receiptByTopic = new Map(receipts.filter(item => item.announcement).map(item => [String(item.announcement._id), item]));
    const allMemberIds = new Set(members.map(member => member.id));
    const same = (a, b) => a.size === b.size && [...a].every(id => b.has(id));
    const topics = [...new Map([...receipts.filter(item => item.announcement).map(item => [String(item.announcement._id), item.announcement]), ...sent.map(item => [String(item._id), item])]).values()].map(topic => {
      const targetIds = new Set((topic.targetOfficers || []).map(String));
      const participantIds = new Set([...targetIds, String(topic.sender?._id || topic.sender)]);
      const ownReceipt = receiptByTopic.get(String(topic._id));
      const lastReadAt = ownReceipt?.chatLastReadAt || ownReceipt?.readAt;
      const unreadCount = [{ sender: topic.sender, createdAt: topic.createdAt }, ...(topic.conversationMessages || [])].filter(message => String(message.sender?._id || message.sender) !== String(req.user._id) && (!lastReadAt || new Date(message.createdAt) > new Date(lastReadAt))).length;
      const matched = groups.find(group => same(targetIds, new Set(group.members.map(member => String(member._id)))));
      const isAll = same(participantIds, allMemberIds);
      return { id: String(topic._id), title: topic.title, preview: topic.conversationMessages?.at(-1)?.body || topic.body, senderName: topic.sender?.displayname || topic.sender?.username || 'メンバー', updatedAt: topic.conversationMessages?.at(-1)?.createdAt || topic.createdAt, unread: unreadCount > 0, unreadCount, hidden: Boolean(ownReceipt?.chatHiddenAt), audienceLabel: isAll ? '全員' : matched?.name || '選択メンバー', isAll, canDelete: String(topic.sender?._id || topic.sender) === String(req.user._id), participantCount: participantIds.size };
    }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return res.json({ association: { id: req.params.associationId, name: access.spaces.find(space => space.id === String(access.contextId))?.name || '' }, officers: members, groups: groups.map(group => ({ id: String(group._id), name: group.name, members: group.members.map(member => ({ id: String(member._id), name: member.displayname || member.username })) })), topics, unreadCount: topics.reduce((sum, topic) => sum + topic.unreadCount, 0), spaces: access.spaces, currentSpaceId: String(access.contextId), csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

associationsRouter.post('/:associationId/member-chat/:scope/topics', provideCsrfToken, acceptAnnouncementAttachments, verifyCsrfToken, async (req, res, next) => {
  try {
    const access = await memberChatAccess(req.params.associationId, req.params.scope, req.user._id, req.body.contextId);
    let participantIds = []; try { participantIds = JSON.parse(req.body.participantIds || '[]'); } catch { participantIds = []; }
    const poll = chatOptions(req.body);
    const result = await publishAnnouncement({ files: req.files, attachmentRetentionDays: 365, associationId: req.params.associationId, associationGroupId: access.channel === 'association_group' ? access.contextId : undefined, userId: req.user._id, channel: access.channel, audience: access.channel === 'district' ? 'district_individual' : 'group_individual', targetOfficerIds: participantIds, urgency: 1, title: req.body.title, body: req.body.body, responseMode: poll.mode, options: poll.options });
    const now = new Date();
    await OfficerAnnouncementReceipt.updateOne({ announcement: result.announcement._id, association: req.params.associationId, recipient: req.user._id }, { $set: { readAt: now, chatLastReadAt: now } }, { upsert: true });
    return res.status(201).json({ id: String(result.announcement._id), csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

associationsRouter.get('/:associationId/member-chat/:scope/topics/:topicId', provideCsrfToken, async (req, res, next) => {
  try {
    const topic = await memberChatTopic(req.params.associationId, req.params.scope, req.params.topicId, req.user._id);
    const populated = await OfficerAnnouncement.findById(topic._id).populate('sender', 'displayname username').populate('conversationMessages.sender', 'displayname username').lean();
    const receipts = await OfficerAnnouncementReceipt.find({ announcement: topic._id }).populate('recipient', 'displayname username').lean();
    const now = new Date();
    await OfficerAnnouncementReceipt.updateOne({ announcement: topic._id, association: req.params.associationId, recipient: req.user._id }, { $set: { readAt: now, chatLastReadAt: now } }, { upsert: String(topic.sender) === String(req.user._id) });
    const initial = { _id: populated._id, sender: populated.sender, body: populated.body, attachments: populated.attachments, createdAt: populated.createdAt, pollMode: populated.responseMode, pollOptions: populated.options, pollResponses: receipts.filter(item => item.respondedAt).map(item => ({ user: item.recipient, selectedOptions: item.selectedOptions, respondedAt: item.respondedAt })) };
    const participants = [...new Map([populated.sender, ...receipts.map(item => item.recipient)].filter(Boolean).map(user => [String(user._id), { id: String(user._id), name: user.displayname || user.username }])).values()];
    return res.json({ topic: { id: String(populated._id), title: populated.title, participants, messages: [mobileChatMessage(initial, req.user._id), ...(populated.conversationMessages || []).map(message => mobileChatMessage(message, req.user._id))] }, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

associationsRouter.post('/:associationId/member-chat/:scope/topics/:topicId/messages', provideCsrfToken, acceptAnnouncementAttachments, verifyCsrfToken, async (req, res, next) => {
  try {
    const topic = await memberChatTopic(req.params.associationId, req.params.scope, req.params.topicId, req.user._id);
    const body = String(req.body.body || '').trim(), poll = chatOptions(req.body);
    if (!body && !req.files?.length && poll.mode === 'none') throw chatFail('メッセージ、添付ファイル、またはアンケートを入力してください。');
    const expiresAt = new Date(Date.now() + 365 * 86400000), attachments = [];
    for (const file of req.files || []) attachments.push({ ...(await uploadAnnouncementAttachment(file, req.params.associationId)), expiresAt });
    topic.conversationMessages.push({ sender: req.user._id, body, attachments, pollMode: poll.mode, pollOptions: poll.options });
    await topic.save();
    await OfficerAnnouncementReceipt.updateMany({ announcement: topic._id, recipient: { $ne: req.user._id } }, { $set: { readAt: null }, $unset: { chatHiddenAt: 1 } });
    const recipients = await OfficerAnnouncementReceipt.find({ announcement: topic._id, recipient: { $ne: req.user._id } }).distinct('recipient');
    try { await createNotifications(recipients.map(recipient => ({ association: req.params.associationId, recipient, type: topic.channel === 'district' ? 'district_message' : 'group_message', title: `${topic.channel === 'district' ? '班内' : 'グループ内'}の会話：${topic.title}`, body: `${req.user.displayname || req.user.username}さんから新しいメッセージが届きました。`, relatedType: 'OfficerAnnouncement', relatedId: topic._id }))); } catch (error) { console.error('Member chat notification failed:', error); }
    return res.status(201).json({ ok: true, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

associationsRouter.post('/:associationId/member-chat/:scope/topics/:topicId/messages/:messageId/poll', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    const topic = await memberChatTopic(req.params.associationId, req.params.scope, req.params.topicId, req.user._id);
    const selected = (Array.isArray(req.body.selectedOptions) ? req.body.selectedOptions : []).map(Number);
    if (req.params.messageId === String(topic._id)) await confirmAnnouncement({ associationId: req.params.associationId, announcementId: topic._id, userId: req.user._id, selectedOptions: selected, channel: topic.channel });
    else {
      const message = topic.conversationMessages.id(req.params.messageId);
      if (!message || message.pollMode === 'none' || !selected.length || (message.pollMode === 'single' && selected.length !== 1) || selected.some(index => !Number.isInteger(index) || index < 0 || index >= message.pollOptions.length)) throw chatFail('アンケートの回答を確認してください。');
      message.pollResponses = (message.pollResponses || []).filter(response => String(response.user) !== String(req.user._id));
      message.pollResponses.push({ user: req.user._id, selectedOptions: [...new Set(selected)], respondedAt: new Date() });
      await topic.save();
    }
    return res.json({ ok: true, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

associationsRouter.post('/:associationId/member-chat/:scope/topics/:topicId/visibility', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    const topic = await memberChatTopic(req.params.associationId, req.params.scope, req.params.topicId, req.user._id);
    await OfficerAnnouncementReceipt.updateOne({ announcement: topic._id, association: req.params.associationId, recipient: req.user._id }, req.body.hidden === true ? { $set: { chatHiddenAt: new Date() } } : { $unset: { chatHiddenAt: 1 } }, { upsert: String(topic.sender) === String(req.user._id) });
    return res.json({ ok: true, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

associationsRouter.delete('/:associationId/member-chat/:scope/topics/:topicId', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try {
    const topic = await memberChatTopic(req.params.associationId, req.params.scope, req.params.topicId, req.user._id);
    if (String(topic.sender) !== String(req.user._id)) throw chatFail('トピックを削除できるのは作成者だけです。', 403);
    topic.mutedAt = new Date(); topic.mutedBy = req.user._id; await topic.save();
    return res.status(204).end();
  } catch (error) { return next(error); }
});

const saveMemberChatGroup = async (req, groupId) => {
  const access = await memberChatAccess(req.params.associationId, req.params.scope, req.user._id, req.body.contextId);
  const name = String(req.body.name || '').trim(), memberIds = [...new Set((Array.isArray(req.body.members) ? req.body.members : []).map(String))];
  if (!name || name.length > 80 || !memberIds.length) throw chatFail('グループ名とメンバーを入力してください。');
  const eligible = new Set((await memberChatDirectory(req.params.associationId, access)).map(member => member.id));
  if (memberIds.some(id => !mongoose.isValidObjectId(id) || !eligible.has(id))) throw chatFail('同じ所属のメンバーだけを選択してください。');
  if (groupId) {
    const group = await ConversationContactGroup.findOneAndUpdate({ _id: groupId, association: req.params.associationId, channel: access.channel, context: access.contextId }, { $set: { name, members: memberIds } }, { new: true });
    if (!group) throw chatFail('グループを確認できません。', 404);
    return group;
  }
  return ConversationContactGroup.create({ association: req.params.associationId, channel: access.channel, context: access.contextId, name, members: memberIds, createdBy: req.user._id });
};

associationsRouter.post('/:associationId/member-chat/:scope/groups', provideCsrfToken, verifyCsrfToken, async (req, res, next) => { try { const group = await saveMemberChatGroup(req); return res.status(201).json({ id: String(group._id), csrfToken: req.session.csrfToken }); } catch (error) { return next(error); } });
associationsRouter.post('/:associationId/member-chat/:scope/groups/:groupId', provideCsrfToken, verifyCsrfToken, async (req, res, next) => { try { await saveMemberChatGroup(req, req.params.groupId); return res.json({ ok: true, csrfToken: req.session.csrfToken }); } catch (error) { return next(error); } });
associationsRouter.delete('/:associationId/member-chat/:scope/groups/:groupId', provideCsrfToken, verifyCsrfToken, async (req, res, next) => {
  try { const access = await memberChatAccess(req.params.associationId, req.params.scope, req.user._id, req.body.contextId); const result = await ConversationContactGroup.deleteOne({ _id: req.params.groupId, association: req.params.associationId, channel: access.channel, context: access.contextId }); if (!result.deletedCount) throw chatFail('グループを確認できません。', 404); return res.status(204).end(); } catch (error) { return next(error); }
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

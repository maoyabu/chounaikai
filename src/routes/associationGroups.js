import { persistEventImage, deleteEventImage } from '../services/eventAttachmentService.js';
import { acceptAnnouncementAttachments } from '../services/announcementAttachmentService.js';
import express from 'express';
import { queueNotice, notifyResponsible, notifyEvent } from '../services/notificationRecipients.js';
import mongoose from 'mongoose';
import { requireLogin, requirePermission } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { AssociationGroupRequest, AssociationGroup, AssociationGroupMembership, AssociationGroupJoinRequest } from '../models/associationGroup.js';
import { AssociationEvent } from '../models/associationEvent.js';
import { acceptPublicPhotos, acceptEventImage, uploadPublicPhoto, deletePublicPhoto } from '../services/publicPageImageService.js';
import { eventValues, calendarWindow, expandRecurringEvents } from '../services/associationEventService.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { loadRecipientAnnouncement, confirmAnnouncement, publishAnnouncement } from '../services/officerAnnouncementService.js';

export const associationGroupsRouter = express.Router();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const valid = value => mongoose.isValidObjectId(value);
const groupAccess = async (groupId, associationId, userId) => await AssociationGroup.exists({ _id: groupId, association: associationId, status: { $in: ['active', 'suspended'] } }) && AssociationGroupMembership.findOne({ group: groupId, association: associationId, user: userId, role: 'manager', status: 'active' });

associationGroupsRouter.get('/:associationId/groups/:groupId', async (req, res, next) => {
  if (req.params.groupId === 'request') return next();
  try {
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: { $in: ['active', 'suspended'] } }).lean();
    const association = await NeighborhoodAssociation.findById(req.params.associationId).select('name').lean();
    if (!group || !association) throw fail('グループを確認できません。', 404);
    const membership = req.user ? await AssociationMembership.findOne({ association: group.association, user: req.user._id, status: 'active' }) : null;
    if (group.publicVisibility !== 'open' && !membership) throw fail('町内会住人だけが閲覧できます。', 403);
    const [members, allEvents] = await Promise.all([AssociationGroupMembership.find({ group: group._id, status: 'active' }).populate('user', 'displayname username email avatar').sort({ createdAt: 1 }).lean(), AssociationEvent.find({ association: group.association, group: group._id, visible: true }).sort({ startDate: 1, startTime: 1 }).lean()]);
    const joinRequest = membership ? await AssociationGroupJoinRequest.findOne({ association: group.association, group: group._id, applicant: req.user._id, status: 'pending' }).lean() : null;
    const calendar = calendarWindow(req.query.month), start = `${calendar.first.getFullYear()}-${String(calendar.first.getMonth() + 1).padStart(2, '0')}-01`, endDate = new Date(calendar.first.getFullYear(), calendar.first.getMonth() + 3, 1), end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-01`, events = expandRecurringEvents(allEvents, start, end).filter(event => event.startDate < end && event.endDate >= start);
    return res.render('association-group-public', { title: group.name, association, group, members: members.filter(item => item.user), events, ...calendar, calendarWindow: calendar, joinRequest, isResident: Boolean(membership), isManager: Boolean(req.user && await groupAccess(group._id, group.association, req.user._id)) });
  } catch (error) { return next(error); }
});

associationGroupsRouter.use(requireLogin);

associationGroupsRouter.get('/:associationId/groups/:groupId/messages', async (req, res, next) => {
  try {
    const membership = await AssociationGroupMembership.findOne({ association: req.params.associationId, group: req.params.groupId, user: req.user._id, status: 'active' });
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: 'active' }).lean();
    if (!membership || !group) throw fail('グループの参加者だけが利用できます。', 403);
    const [announcements, groupEvents] = await Promise.all([OfficerAnnouncement.find({ association: group.association, associationGroup: group._id, channel: 'association_group', sender: req.user._id }).sort({ createdAt: -1 }).limit(50).lean(), AssociationEvent.find({ association: group.association, group: group._id, visible: true }).sort({ startDate: 1, startTime: 1 }).lean()]);
    const calendar = calendarWindow(req.query.month);
    const start = calendar.months[0].cells.find(Boolean);
    const after = new Date(calendar.first.getFullYear(), calendar.first.getMonth() + 1, 1);
    const end = `${after.getFullYear()}-${String(after.getMonth() + 1).padStart(2, '0')}-01`;
    const expandedEvents = expandRecurringEvents(groupEvents, start, end).filter(event => event.startDate < end && event.endDate >= start);
    const allIds = await OfficerAnnouncement.find({ association: group.association, associationGroup: group._id, channel: 'association_group' }).select('_id').lean();
    const unreadCount = await OfficerAnnouncementReceipt.countDocuments({ association: group.association, recipient: req.user._id, readAt: null, announcement: { $in: allIds.map(item => item._id) } });
    return res.render('association-group-messages', { title: `${group.name}の連絡`, group, announcements, unreadCount, events: expandedEvents, months: calendar.months.slice(0, 1), calendarWindow: calendar });
  } catch (error) { return next(error); }
});

associationGroupsRouter.get('/:associationId/groups/:groupId/messages/new', async (req, res, next) => {
  try { const membership = await AssociationGroupMembership.findOne({ association: req.params.associationId, group: req.params.groupId, user: req.user._id, status: 'active' }); const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: 'active' }).lean(); if (!membership || !group) throw fail('グループの参加者だけが利用できます。', 403); return res.render('association-group-messages-new', { title: `${group.name}の連絡を送る`, group }); } catch (error) { return next(error); }
});

associationGroupsRouter.get('/:associationId/groups/:groupId/messages/inbox', async (req, res, next) => {
  try { const membership = await AssociationGroupMembership.findOne({ association: req.params.associationId, group: req.params.groupId, user: req.user._id, status: 'active' }); const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: 'active' }).lean(); if (!membership || !group) throw fail('グループの参加者だけが利用できます。', 403); const receipts = await OfficerAnnouncementReceipt.find({ association: group.association, recipient: req.user._id }).populate({ path: 'announcement', match: { associationGroup: group._id, channel: 'association_group', mutedAt: { $exists: false } } }).sort({ createdAt: -1 }).lean(); return res.render('association-group-messages-inbox', { title: `${group.name} 届いた連絡`, group, receipts: receipts.filter(item => item.announcement) }); } catch (error) { return next(error); }
});

const recipientGroupMessage = async req => {
  const membership = await AssociationGroupMembership.exists({ association: req.params.associationId, group: req.params.groupId, user: req.user._id, status: 'active' });
  if (!membership) throw fail('グループの参加者だけが利用できます。', 403);
  const result = await loadRecipientAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, channel: 'association_group' });
  if (String(result.announcement.associationGroup) !== req.params.groupId) throw fail('連絡を確認できません。', 404);
  return result;
};

associationGroupsRouter.get('/:associationId/groups/:groupId/messages/inbox/:announcementId', async (req, res, next) => {
  try {
    const { announcement, receipt } = await recipientGroupMessage(req);
    return res.render('resident-announcement-detail', { title: announcement.title, associationId: req.params.associationId, announcement, receipt, messageGroupId: req.params.groupId });
  } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/messages/inbox/:announcementId/confirm', verifyCsrfToken, async (req, res, next) => {
  try {
    await recipientGroupMessage(req);
    await confirmAnnouncement({ associationId: req.params.associationId, announcementId: req.params.announcementId, userId: req.user._id, selectedOptions: req.body.selectedOptions, channel: 'association_group' });
    req.session.notice = '連絡を確認・回答しました。';
    return res.redirect('/dashboard');
  } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/messages', acceptAnnouncementAttachments, verifyCsrfToken, async (req, res, next) => {
  try {
    const membership = await AssociationGroupMembership.findOne({ association: req.params.associationId, group: req.params.groupId, user: req.user._id, status: 'active' });
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: 'active' }).lean();
    if (!membership || !group) throw fail('グループの参加者だけが利用できます。', 403);
    await publishAnnouncement({ files: req.files, attachmentRetentionDays: req.body.attachmentRetentionDays || 30, associationId: group.association, associationGroupId: group._id, userId: req.user._id, channel: 'association_group', audience: 'group_all', urgency: req.body.urgency || 1, title: req.body.title, body: req.body.body, responseMode: req.body.responseMode || 'none', options: [req.body.option1, req.body.option2, req.body.option3, req.body.option4, req.body.option5] });
    req.session.notice = 'グループ内に連絡を送信しました。'; return res.redirect(`/associations/${group.association}/groups/${group._id}/messages`);
  } catch (error) { return next(error); }
});

associationGroupsRouter.get('/:associationId/groups/:groupId/manage/pr', async (req, res, next) => {
  try { const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: { $in: ['active', 'suspended'] } }).lean(); if (!group || !await groupAccess(group._id, group.association, req.user._id)) throw fail('操作権限がありません。', 403); const events = await AssociationEvent.find({ association: group.association, group: group._id }).sort({ startDate: -1 }).lean(); return res.render('association-group-pr-edit', { title: `${group.name} PR編集`, group, events }); } catch (error) { return next(error); }
});

associationGroupsRouter.get('/:associationId/groups/:groupId/manage/events', async (req, res, next) => {
  try { const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: { $in: ['active', 'suspended'] } }).lean(); if (!group || !await groupAccess(group._id, group.association, req.user._id)) throw fail('操作権限がありません。', 403); const events = await AssociationEvent.find({ association: group.association, group: group._id }).sort({ startDate: -1, startTime: -1 }).lean(); const categories = [...new Set(events.map(event => event.category))].sort((a, b) => a.localeCompare(b, 'ja')); return res.render('association-group-events-manage', { title: `${group.name} 行事管理`, group, events, categories }); } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/manage/pr', acceptPublicPhotos, verifyCsrfToken, async (req, res, next) => {
  const uploaded = [];
  try {
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: { $in: ['active', 'suspended'] } }); if (!group || !await groupAccess(group._id, group.association, req.user._id)) throw fail('操作権限がありません。', 403);
    const photos = Array.from({ length: 3 }, (_, slot) => group.publicPhotos?.[slot] || null), replaced = [];
    for (let slot = 0; slot < 3; slot++) { const file = req.files?.[`photo${slot}`]?.[0]; if (file) { const photo = await uploadPublicPhoto(file, group._id, `group_${slot}`); uploaded.push(photo); if (photos[slot]?.publicId) replaced.push(photos[slot].publicId); photos[slot] = photo; } else if (req.body[`remove${slot}`] === 'on') { if (photos[slot]?.publicId) replaced.push(photos[slot].publicId); photos[slot] = null; } }
    group.name = String(req.body.name || '').trim(); group.publicDescription = String(req.body.publicDescription || '').trim(); group.publicVisibility = req.body.publicVisibility === 'open' ? 'open' : 'members'; group.publicPhotos = photos; if (!group.name) throw fail('グループ名を入力してください。'); await group.save(); await Promise.allSettled(replaced.map(deletePublicPhoto)); req.session.notice = 'グループPRページを更新しました。'; return res.redirect(`/associations/${group.association}/groups/${group._id}/manage`);
  } catch (error) { await Promise.allSettled(uploaded.map(photo => deletePublicPhoto(photo.publicId))); return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/manage/events', acceptEventImage, verifyCsrfToken, async (req, res, next) => {
  try { const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: { $in: ['active', 'suspended'] } }); if (!group || !await groupAccess(group._id, group.association, req.user._id)) throw fail('操作権限がありません。', 403); const values = eventValues(req.body); const createdEvent = await persistEventImage({ file: req.file, association: group.association, persist: image => AssociationEvent.create({ ...values, association: group.association, group: group._id, ...(image ? { image } : {}) }) }); await notifyEvent(createdEvent, '登録'); req.session.notice = 'グループ行事を登録しました。'; return res.redirect(`/associations/${group.association}/groups/${group._id}/manage/events`); } catch (error) { return next(error); }
});

for (const action of ['update', 'delete']) associationGroupsRouter.post(`/:associationId/groups/:groupId/manage/events/:eventId${action === 'update' ? '' : '/delete'}`, acceptEventImage, verifyCsrfToken, async (req, res, next) => {
  try { const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: { $in: ['active', 'suspended'] } }); if (!group || !await groupAccess(group._id, group.association, req.user._id)) throw fail('操作権限がありません。', 403); const previous = await AssociationEvent.findOne({ _id: req.params.eventId, group: group._id, association: group.association }).lean(); if (!previous) throw fail('行事を確認できません。', 404); if (action === 'delete') { const deleted = await AssociationEvent.deleteOne({ _id: req.params.eventId, group: group._id }); if (!deleted.deletedCount) throw fail('行事を確認できません。', 404); await deleteEventImage(previous.image, group.association).catch(() => {}); } else { const values = eventValues(req.body); await persistEventImage({ file: req.file, association: group.association, previousImage: previous.image, persist: async image => { const result = await AssociationEvent.updateOne({ _id: req.params.eventId, group: group._id }, { $set: { ...values, ...(image ? { image } : {}) } }); if (!result.matchedCount) throw fail('行事を確認できません。', 404); return result; } }); } const current = action === 'delete' ? previous : await AssociationEvent.findById(req.params.eventId).lean(); await notifyEvent({ ...current, visible: previous.visible || current.visible }, action === 'delete' ? '削除' : '変更'); req.session.notice = action === 'delete' ? '行事を削除しました。' : '行事を更新しました。'; return res.redirect(`/associations/${group.association}/groups/${group._id}/manage/events`); } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/manage/events/:eventId/complete', verifyCsrfToken, async (req, res, next) => {
  try { const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: { $in: ['active', 'suspended'] } }); if (!group || !await groupAccess(group._id, group.association, req.user._id)) throw fail('操作権限がありません。', 403); const completed = req.body.completed === 'on'; const update = { completed }; if (completed) update.implementationReport = String(req.body.implementationReport || '').trim(); const event = await AssociationEvent.findOne({ _id: req.params.eventId, association: group.association, group: group._id }).select('_id'); if (!event) throw fail('行事を確認できません。', 404); await AssociationEvent.collection.updateOne({ _id: event._id, association: group.association, group: group._id }, { $set: update }); return res.redirect(`/associations/${group.association}/groups/${group._id}/manage/events`); } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId', verifyCsrfToken, async (req, res, next) => {
  if (req.params.groupId === 'request') return next();
  try {
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: 'active' });
    if (!group || !await AssociationMembership.exists({ association: req.params.associationId, user: req.user._id, status: 'active' })) throw fail('参加できるグループを確認できません。', 403);
    if (await AssociationGroupMembership.exists({ group: group._id, user: req.user._id, status: { $in: ['active', 'pending'] } })) throw fail('すでに参加中、または申請済みです。', 409);
    await AssociationGroupJoinRequest.findOneAndUpdate({ association: group.association, group: group._id, applicant: req.user._id, status: { $ne: 'pending' } }, { $set: { status: 'pending' }, $unset: { decidedBy: 1, decidedAt: 1, rejectionReason: 1 } }, { upsert: true, new: true, setDefaultsOnInsert: true }).catch(error => { if (error.code === 11000) throw fail('すでに申請済みです。', 409); throw error; });
    await queueNotice({ association: group.association, recipients: await AssociationGroupMembership.find({ association: group.association, group: group._id, role: 'manager', status: 'active' }).distinct('user'), type: 'group_request', title: 'グループへの参加申請が届きました', relatedId: group._id });
    req.session.notice = 'グループへの参加申請を送信しました。'; return res.redirect(`/associations/${group.association}/groups/${group._id}`);
  } catch (error) { return next(error); }
});


associationGroupsRouter.post('/:associationId/groups/:groupId/withdrawal', verifyCsrfToken, async (req, res, next) => {
  try {
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: { $in: ['active', 'suspended'] } }).lean();
    if (!group) throw fail('グループを確認できません。', 404);
    const member = await AssociationGroupMembership.findOneAndUpdate({ association: group.association, group: group._id, user: req.user._id, status: 'active', withdrawalRequestedAt: null }, { $set: { withdrawalRequestedAt: new Date() } });
    if (!member) throw fail('参加中のメンバーでないか、すでに退会申請済みです。', 409);
    await queueNotice({ association: group.association, recipients: await AssociationGroupMembership.find({ association: group.association, group: group._id, role: 'manager', status: 'active' }).distinct('user'), type: 'group_request', title: 'グループへの退会申請が届きました', relatedId: group._id });
    req.session.notice = '退会申請を送信しました。責任者の承認をお待ちください。';
    return res.redirect(`/associations/${group.association}/groups/${group._id}`);
  } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/manage/withdrawals/:userId/:decision', verifyCsrfToken, async (req, res, next) => {
  try {
    if (!['approve', 'reject'].includes(req.params.decision) || !await groupAccess(req.params.groupId, req.params.associationId, req.user._id)) throw fail('操作権限がありません。', 403);
    const filter = { association: req.params.associationId, group: req.params.groupId, user: req.params.userId, status: 'active', withdrawalRequestedAt: { $ne: null } };
    const target = await AssociationGroupMembership.findOne(filter);
    if (!target) throw fail('退会申請を確認できません。', 404);
    if (req.params.decision === 'approve' && target.role === 'manager' && await AssociationGroupMembership.countDocuments({ association: req.params.associationId, group: req.params.groupId, role: 'manager', status: 'active' }) <= 1) throw fail('最後の責任者は退会できません。先に別のメンバーを責任者に指定してください。');
    const approved = req.params.decision === 'approve';
    const updated = await AssociationGroupMembership.findOneAndUpdate(filter, { ...(approved ? { $set: { status: 'rejected', role: 'member' } } : {}), $unset: { withdrawalRequestedAt: 1 } });
    if (!updated) throw fail('退会申請を確認できません。', 404);
    await queueNotice({ association: req.params.associationId, recipients: [target.user], type: 'group_request', title: approved ? 'グループからの退会が承認されました' : 'グループからの退会申請が却下されました', relatedId: req.params.groupId });
    req.session.notice = approved ? '退会を承認しました。' : '退会申請を却下しました。';
    return res.redirect(`/associations/${req.params.associationId}/groups/${req.params.groupId}/manage`);
  } catch (error) { return next(error); }
});

associationGroupsRouter.get('/:associationId/groups/:groupId/manage', async (req, res, next) => {
  try {
    const manager = await groupAccess(req.params.groupId, req.params.associationId, req.user._id);
    if (!manager) throw fail('グループ責任者だけが管理できます。', 403);
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: { $in: ['active', 'suspended'] } }).lean();
    if (!group) throw fail('グループを確認できません。', 404);
    const [requests, members] = await Promise.all([
      AssociationGroupJoinRequest.find({ group: group._id, status: 'pending' }).populate('applicant', 'displayname username email').sort({ createdAt: 1 }).lean(),
      AssociationGroupMembership.find({ group: group._id, status: 'active' }).populate('user', 'displayname username email avatar').sort({ createdAt: 1 }).lean()
    ]);
    return res.render('association-group-manage', { title: `${group.name} 管理`, group, requests, members: members.filter(item => item.user) });
  } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/manage/requests/:requestId/:decision', verifyCsrfToken, async (req, res, next) => {
  try {
    if (!['approve', 'reject'].includes(req.params.decision) || !await groupAccess(req.params.groupId, req.params.associationId, req.user._id)) throw fail('操作権限がありません。', 403);
    const request = await AssociationGroupJoinRequest.findOne({ _id: req.params.requestId, group: req.params.groupId, status: 'pending' });
    if (!request) throw fail('参加申請を確認できません。', 404);
    if (req.params.decision === 'approve') await AssociationGroupMembership.findOneAndUpdate({ association: request.association, group: request.group, user: request.applicant }, { $set: { status: 'active', role: 'member', approvedBy: req.user._id, joinedAt: new Date() }, $unset: { withdrawalRequestedAt: 1 } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    request.status = req.params.decision === 'approve' ? 'approved' : 'rejected'; request.decidedBy = req.user._id; request.decidedAt = new Date(); await request.save();
    await queueNotice({ association: request.association, recipients: [request.applicant], type: 'group_request', title: request.status === 'approved' ? 'グループ参加が承認されました' : 'グループ参加申請が承認されませんでした', relatedId: request.group });
    return res.redirect(`/associations/${req.params.associationId}/groups/${req.params.groupId}/manage`);
  } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/manage/members/:userId/remove', verifyCsrfToken, async (req, res, next) => {
  try {
    if (!await groupAccess(req.params.groupId, req.params.associationId, req.user._id)) throw fail('操作権限がありません。', 403);
    const target = await AssociationGroupMembership.findOne({ group: req.params.groupId, user: req.params.userId, status: 'active' });
    if (!target) throw fail('グループメンバーを確認できません。', 404);
    if (target.role === 'manager') throw fail('グループ責任者は強制退会できません。');
    target.status = 'rejected'; await target.save(); req.session.notice = 'グループのメンバー情報を更新しました。'; return res.redirect(`/associations/${req.params.associationId}/groups/${req.params.groupId}`);
  } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/manage/members/:userId/promote', verifyCsrfToken, async (req, res, next) => {
  try {
    if (!await groupAccess(req.params.groupId, req.params.associationId, req.user._id)) throw fail('操作権限がありません。', 403);
    const target = await AssociationGroupMembership.findOne({ group: req.params.groupId, user: req.params.userId, status: 'active' });
    if (!target) throw fail('グループメンバーを確認できません。', 404);
    target.role = 'manager'; await target.save();
    req.session.notice = 'グループ管理者を設定しました。';
    return res.redirect(`/associations/${req.params.associationId}/groups/${req.params.groupId}`);
  } catch (error) { return next(error); }
});

associationGroupsRouter.get('/:associationId/groups/request', async (req, res, next) => {
  try {
    const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
    const membership = await AssociationMembership.findOne({ association: req.params.associationId, user: req.user._id, status: 'active' });
    if (!association || !membership) throw fail('参加中の町内会を確認できません。', 403);
    return res.render('association-group-request', { title: `${association.name} グループ作成申請`, association });
  } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/request', verifyCsrfToken, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim(), purpose = String(req.body.purpose || '').trim();
    if (!name) throw fail('グループ名を入力してください。');
    if (!await AssociationMembership.exists({ association: req.params.associationId, user: req.user._id, status: 'active' })) throw fail('参加中の住人だけが申請できます。', 403);
    await AssociationGroupRequest.create({ association: req.params.associationId, requestedBy: req.user._id, name, purpose });
    await notifyResponsible({ association: req.params.associationId, type: 'group_request', title: 'グループ作成申請が届きました' });
    req.session.notice = 'グループ作成を申請しました。町内会管理者の承認をお待ちください。';
    return res.redirect('/dashboard');
  } catch (error) { return next(error); }
});

associationGroupsRouter.get('/:associationId/manage/groups', requirePermission('association.manage'), async (req, res, next) => {
  try {
    const association = await NeighborhoodAssociation.findById(req.params.associationId).lean();
    if (!association) throw fail('町内会を確認できません。', 404);
    const [requests, groups, members] = await Promise.all([
      AssociationGroupRequest.find({ association: association._id, status: 'pending' }).populate('requestedBy', 'displayname username email').sort({ createdAt: 1 }).lean(),
      AssociationGroup.find({ association: association._id, status: { $in: ['active', 'suspended'] } }).sort({ name: 1 }).lean(),
      AssociationMembership.find({ association: association._id, status: 'active' }).populate('user', 'displayname username email').sort({ startedAt: 1 }).lean()
    ]);
    const groupIds = groups.map(group => group._id);
    const assignments = groupIds.length ? await AssociationGroupMembership.find({ association: association._id, group: { $in: groupIds }, status: 'active', role: 'manager' }).populate('user', 'displayname username email').lean() : [];
    const managersByGroup = new Map(); assignments.forEach(item => { const key = String(item.group); if (!managersByGroup.has(key)) managersByGroup.set(key, []); if (item.user) managersByGroup.get(key).push(item.user); });
    return res.render('association-groups-manage', { title: `${association.name} グループ管理`, association, requests, groups: groups.map(group => ({ ...group, managers: managersByGroup.get(String(group._id)) || [] })), members: members.filter(item => item.user) });
  } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/manage/groups/:requestId/approve', requirePermission('association.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!valid(req.params.requestId)) throw fail('申請を確認できません。');
    const request = await AssociationGroupRequest.findOne({ _id: req.params.requestId, association: req.params.associationId, status: 'pending' });
    if (!request) throw fail('承認待ちの申請がありません。', 404);
    const managerIds = [String(request.requestedBy)];
    const validMembers = await AssociationMembership.countDocuments({ association: req.params.associationId, user: { $in: managerIds }, status: 'active' });
    if (validMembers !== managerIds.length) throw fail('責任者には参加中の住人だけを指定できます。');
    const group = await AssociationGroup.create({ association: req.params.associationId, name: request.name, purpose: request.purpose, createdBy: req.user._id });
    await AssociationGroupMembership.create(managerIds.map(user => ({ association: req.params.associationId, group: group._id, user, role: 'manager', status: 'active', approvedBy: req.user._id, joinedAt: new Date() })));
    request.status = 'approved'; request.decidedBy = req.user._id; request.decidedAt = new Date(); await request.save();
    await queueNotice({ association: request.association, recipients: [request.requestedBy], type: 'group_request', title: 'グループ作成が承認されました', relatedId: group._id });
    req.session.notice = `「${group.name}」を作成しました。`;
    return res.redirect(`/associations/${req.params.associationId}/manage/groups`);
  } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/manage/groups/:requestId/reject', requirePermission('association.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const request = await AssociationGroupRequest.findOneAndUpdate({ _id: req.params.requestId, association: req.params.associationId, status: 'pending' }, { $set: { status: 'rejected', decidedBy: req.user._id, decidedAt: new Date(), rejectionReason: String(req.body.reason || '').trim() } });
    if (!request) throw fail('承認待ちの申請がありません。', 404);
    await queueNotice({ association: request.association, recipients: [request.requestedBy], type: 'group_request', title: 'グループ作成申請が承認されませんでした' });
    req.session.notice = 'グループ作成申請を却下しました。'; return res.redirect(`/associations/${req.params.associationId}/manage/groups`);
  } catch (error) { return next(error); }
});

// Keep related records for history while removing deleted groups from all group pages.
for (const [action, status, notice] of [
  ['suspend', 'suspended', 'グループを活動停止にしました。'],
  ['resume', 'active', 'グループの活動を再開しました。'],
  ['delete', 'deleted', 'グループを削除しました。']
]) associationGroupsRouter.post(`/:associationId/manage/groups/:groupId/${action}`, requirePermission('association.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!valid(req.params.groupId)) throw fail('グループを確認できません。', 404);
    const group = await AssociationGroup.findOneAndUpdate({
      _id: req.params.groupId, association: req.params.associationId,
      status: { $in: ['active', 'suspended'] }
    }, { $set: { status } });
    if (!group) throw fail('グループを確認できません。', 404);
    req.session.notice = notice;
    return res.redirect(`/associations/${req.params.associationId}/manage/groups`);
  } catch (error) { return next(error); }
});

import express from 'express';
import mongoose from 'mongoose';
import { requireLogin, requirePermission } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { AssociationGroupRequest, AssociationGroup, AssociationGroupMembership, AssociationGroupJoinRequest } from '../models/associationGroup.js';
import { AssociationEvent } from '../models/associationEvent.js';
import { acceptPublicPhotos, acceptEventImage, uploadPublicPhoto, deletePublicPhoto } from '../services/publicPageImageService.js';
import { eventValues, calendarWindow } from '../services/associationEventService.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { publishAnnouncement } from '../services/officerAnnouncementService.js';

export const associationGroupsRouter = express.Router();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const valid = value => mongoose.isValidObjectId(value);
const groupAccess = async (groupId, associationId, userId) => AssociationGroupMembership.findOne({ group: groupId, association: associationId, user: userId, role: 'manager', status: 'active' });

associationGroupsRouter.get('/:associationId/groups/:groupId', async (req, res, next) => {
  if (req.params.groupId === 'request') return next();
  try {
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: 'active' }).lean();
    const association = await NeighborhoodAssociation.findById(req.params.associationId).select('name').lean();
    if (!group || !association) throw fail('グループを確認できません。', 404);
    const membership = req.user ? await AssociationMembership.findOne({ association: group.association, user: req.user._id, status: 'active' }) : null;
    if (group.publicVisibility !== 'open' && !membership) throw fail('町内会住人だけが閲覧できます。', 403);
    const [members, allEvents] = await Promise.all([AssociationGroupMembership.find({ group: group._id, status: 'active' }).populate('user', 'displayname username email avatar').sort({ createdAt: 1 }).lean(), AssociationEvent.find({ association: group.association, group: group._id, visible: true }).sort({ startDate: 1, startTime: 1 }).lean()]);
    const calendar = calendarWindow(req.query.month), start = `${calendar.first.getFullYear()}-${String(calendar.first.getMonth() + 1).padStart(2, '0')}-01`, endDate = new Date(calendar.first.getFullYear(), calendar.first.getMonth() + 3, 1), end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-01`, events = allEvents.filter(event => event.startDate < end && event.endDate >= start);
    return res.render('association-group-public', { title: group.name, association, group, members: members.filter(item => item.user), events, ...calendar, calendarWindow: calendar, isResident: Boolean(membership), isManager: Boolean(req.user && await groupAccess(group._id, group.association, req.user._id)) });
  } catch (error) { return next(error); }
});

associationGroupsRouter.use(requireLogin);

associationGroupsRouter.get('/:associationId/groups/:groupId/messages', async (req, res, next) => {
  try {
    const membership = await AssociationGroupMembership.findOne({ association: req.params.associationId, group: req.params.groupId, user: req.user._id, status: 'active' });
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: 'active' }).lean();
    if (!membership || !group) throw fail('グループの参加者だけが利用できます。', 403);
    const today = new Date().toISOString().slice(0, 10);
    const [announcements, groupEvents] = await Promise.all([OfficerAnnouncement.find({ association: group.association, associationGroup: group._id, channel: 'association_group', sender: req.user._id }).sort({ createdAt: -1 }).limit(50).lean(), AssociationEvent.find({ association: group.association, group: group._id, visible: true, endDate: { $gte: today } }).sort({ startDate: 1, startTime: 1 }).lean()]);
    const calendar = calendarWindow(req.query.month);
    const allIds = await OfficerAnnouncement.find({ association: group.association, associationGroup: group._id, channel: 'association_group' }).select('_id').lean();
    const unreadCount = await OfficerAnnouncementReceipt.countDocuments({ association: group.association, recipient: req.user._id, readAt: null, announcement: { $in: allIds.map(item => item._id) } });
    return res.render('association-group-messages', { title: `${group.name}の連絡`, group, announcements, unreadCount, events: groupEvents, months: calendar.months.slice(0, 1), calendarWindow: calendar });
  } catch (error) { return next(error); }
});

associationGroupsRouter.get('/:associationId/groups/:groupId/messages/new', async (req, res, next) => {
  try { const membership = await AssociationGroupMembership.findOne({ association: req.params.associationId, group: req.params.groupId, user: req.user._id, status: 'active' }); const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: 'active' }).lean(); if (!membership || !group) throw fail('グループの参加者だけが利用できます。', 403); return res.render('association-group-messages-new', { title: `${group.name}の連絡を送る`, group }); } catch (error) { return next(error); }
});

associationGroupsRouter.get('/:associationId/groups/:groupId/messages/inbox', async (req, res, next) => {
  try { const membership = await AssociationGroupMembership.findOne({ association: req.params.associationId, group: req.params.groupId, user: req.user._id, status: 'active' }); const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: 'active' }).lean(); if (!membership || !group) throw fail('グループの参加者だけが利用できます。', 403); const receipts = await OfficerAnnouncementReceipt.find({ association: group.association, recipient: req.user._id }).populate({ path: 'announcement', match: { associationGroup: group._id, channel: 'association_group' } }).sort({ createdAt: -1 }).lean(); return res.render('association-group-messages-inbox', { title: `${group.name} 届いた連絡`, group, receipts: receipts.filter(item => item.announcement) }); } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/messages', verifyCsrfToken, async (req, res, next) => {
  try {
    const membership = await AssociationGroupMembership.findOne({ association: req.params.associationId, group: req.params.groupId, user: req.user._id, status: 'active' });
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: 'active' }).lean();
    if (!membership || !group) throw fail('グループの参加者だけが利用できます。', 403);
    await publishAnnouncement({ associationId: group.association, associationGroupId: group._id, userId: req.user._id, channel: 'association_group', audience: 'group_all', urgency: req.body.urgency || 1, title: req.body.title, body: req.body.body, responseMode: req.body.responseMode || 'none', options: [req.body.option1, req.body.option2, req.body.option3, req.body.option4, req.body.option5] });
    req.session.notice = 'グループ内に連絡を送信しました。'; return res.redirect(`/associations/${group.association}/groups/${group._id}/messages`);
  } catch (error) { return next(error); }
});

associationGroupsRouter.get('/:associationId/groups/:groupId/manage/pr', async (req, res, next) => {
  try { const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId }).lean(); if (!group || !await groupAccess(group._id, group.association, req.user._id)) throw fail('操作権限がありません。', 403); const events = await AssociationEvent.find({ association: group.association, group: group._id }).sort({ startDate: -1 }).lean(); return res.render('association-group-pr-edit', { title: `${group.name} PR編集`, group, events }); } catch (error) { return next(error); }
});

associationGroupsRouter.get('/:associationId/groups/:groupId/manage/events', async (req, res, next) => {
  try { const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId }).lean(); if (!group || !await groupAccess(group._id, group.association, req.user._id)) throw fail('操作権限がありません。', 403); const events = await AssociationEvent.find({ association: group.association, group: group._id }).sort({ startDate: -1, startTime: -1 }).lean(); const categories = [...new Set(events.map(event => event.category))].sort((a, b) => a.localeCompare(b, 'ja')); return res.render('association-group-events-manage', { title: `${group.name} 行事管理`, group, events, categories }); } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/manage/pr', acceptPublicPhotos, verifyCsrfToken, async (req, res, next) => {
  const uploaded = [];
  try {
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId }); if (!group || !await groupAccess(group._id, group.association, req.user._id)) throw fail('操作権限がありません。', 403);
    const photos = Array.from({ length: 3 }, (_, slot) => group.publicPhotos?.[slot] || null), replaced = [];
    for (let slot = 0; slot < 3; slot++) { const file = req.files?.[`photo${slot}`]?.[0]; if (file) { const photo = await uploadPublicPhoto(file, group._id, `group_${slot}`); uploaded.push(photo); if (photos[slot]?.publicId) replaced.push(photos[slot].publicId); photos[slot] = photo; } else if (req.body[`remove${slot}`] === 'on') { if (photos[slot]?.publicId) replaced.push(photos[slot].publicId); photos[slot] = null; } }
    group.name = String(req.body.name || '').trim(); group.publicDescription = String(req.body.publicDescription || '').trim(); group.publicVisibility = req.body.publicVisibility === 'open' ? 'open' : 'members'; group.publicPhotos = photos; if (!group.name) throw fail('グループ名を入力してください。'); await group.save(); await Promise.allSettled(replaced.map(deletePublicPhoto)); req.session.notice = 'グループPRページを更新しました。'; return res.redirect(`/associations/${group.association}/groups/${group._id}/manage/pr`);
  } catch (error) { await Promise.allSettled(uploaded.map(photo => deletePublicPhoto(photo.publicId))); return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/manage/events', acceptEventImage, verifyCsrfToken, async (req, res, next) => {
  try { const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId }); if (!group || !await groupAccess(group._id, group.association, req.user._id)) throw fail('操作権限がありません。', 403); const values = eventValues(req.body); if (req.file) values.image = await uploadPublicPhoto(req.file, group._id, `group-event-${Date.now()}`); await AssociationEvent.create({ ...values, association: group.association, group: group._id }); req.session.notice = 'グループ行事を登録しました。'; return res.redirect(`/associations/${group.association}/groups/${group._id}/manage/events`); } catch (error) { return next(error); }
});

for (const action of ['update', 'delete']) associationGroupsRouter.post(`/:associationId/groups/:groupId/manage/events/:eventId${action === 'update' ? '' : '/delete'}`, acceptEventImage, verifyCsrfToken, async (req, res, next) => {
  try { const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId }); if (!group || !await groupAccess(group._id, group.association, req.user._id)) throw fail('操作権限がありません。', 403); if (action === 'delete') await AssociationEvent.deleteOne({ _id: req.params.eventId, group: group._id }); else { const values = eventValues(req.body); if (req.file) values.image = await uploadPublicPhoto(req.file, group._id, `group-event-${req.params.eventId}`); await AssociationEvent.updateOne({ _id: req.params.eventId, group: group._id }, { $set: values }); } req.session.notice = action === 'delete' ? '行事を削除しました。' : '行事を更新しました。'; return res.redirect(`/associations/${group.association}/groups/${group._id}/manage/events`); } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/manage/events/:eventId/complete', verifyCsrfToken, async (req, res, next) => {
  try { const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId }); if (!group || !await groupAccess(group._id, group.association, req.user._id)) throw fail('操作権限がありません。', 403); await AssociationEvent.updateOne({ _id: req.params.eventId, group: group._id }, { $set: { completed: req.body.completed === 'on' } }); return res.redirect(`/associations/${group.association}/groups/${group._id}/manage/events`); } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId', verifyCsrfToken, async (req, res, next) => {
  try {
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId, status: 'active' });
    if (!group || !await AssociationMembership.exists({ association: req.params.associationId, user: req.user._id, status: 'active' })) throw fail('参加できるグループを確認できません。', 403);
    if (await AssociationGroupMembership.exists({ group: group._id, user: req.user._id, status: { $in: ['active', 'pending'] } })) throw fail('すでに参加中、または申請済みです。', 409);
    await AssociationGroupJoinRequest.create({ association: group.association, group: group._id, applicant: req.user._id });
    req.session.notice = 'グループへの参加申請を送信しました。'; return res.redirect(`/associations/${group.association}/groups/${group._id}`);
  } catch (error) { return next(error); }
});

associationGroupsRouter.get('/:associationId/groups/:groupId/manage', async (req, res, next) => {
  try {
    const manager = await groupAccess(req.params.groupId, req.params.associationId, req.user._id);
    if (!manager) throw fail('グループ責任者だけが管理できます。', 403);
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: req.params.associationId }).lean();
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
    if (req.params.decision === 'approve') await AssociationGroupMembership.findOneAndUpdate({ association: request.association, group: request.group, user: request.applicant }, { $set: { status: 'active', approvedBy: req.user._id, joinedAt: new Date() } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    request.status = req.params.decision === 'approve' ? 'approved' : 'rejected'; request.decidedBy = req.user._id; request.decidedAt = new Date(); await request.save();
    return res.redirect(`/associations/${req.params.associationId}/groups/${req.params.groupId}/manage`);
  } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/manage/members/:userId/remove', verifyCsrfToken, async (req, res, next) => {
  try {
    if (!await groupAccess(req.params.groupId, req.params.associationId, req.user._id)) throw fail('操作権限がありません。', 403);
    const target = await AssociationGroupMembership.findOne({ group: req.params.groupId, user: req.params.userId, status: 'active' });
    if (!target) throw fail('グループメンバーを確認できません。', 404);
    if (target.role === 'manager') throw fail('グループ責任者は強制退会できません。');
    target.status = 'rejected'; await target.save(); return res.redirect(`/associations/${req.params.associationId}/groups/${req.params.groupId}/manage`);
  } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/groups/:groupId/manage/members/:userId/promote', verifyCsrfToken, async (req, res, next) => {
  try {
    if (!await groupAccess(req.params.groupId, req.params.associationId, req.user._id)) throw fail('操作権限がありません。', 403);
    const target = await AssociationGroupMembership.findOne({ group: req.params.groupId, user: req.params.userId, status: 'active' });
    if (!target) throw fail('グループメンバーを確認できません。', 404);
    target.role = 'manager'; await target.save();
    return res.redirect(`/associations/${req.params.associationId}/groups/${req.params.groupId}/manage`);
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
      AssociationGroup.find({ association: association._id, status: 'active' }).sort({ name: 1 }).lean(),
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
    req.session.notice = `「${group.name}」を作成しました。`;
    return res.redirect(`/associations/${req.params.associationId}/manage/groups`);
  } catch (error) { return next(error); }
});

associationGroupsRouter.post('/:associationId/manage/groups/:requestId/reject', requirePermission('association.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const request = await AssociationGroupRequest.findOneAndUpdate({ _id: req.params.requestId, association: req.params.associationId, status: 'pending' }, { $set: { status: 'rejected', decidedBy: req.user._id, decidedAt: new Date(), rejectionReason: String(req.body.reason || '').trim() } });
    if (!request) throw fail('承認待ちの申請がありません。', 404);
    req.session.notice = 'グループ作成申請を却下しました。'; return res.redirect(`/associations/${req.params.associationId}/manage/groups`);
  } catch (error) { return next(error); }
});

import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { AssociationEvent } from '../models/associationEvent.js';
import {
  AssociationGroup,
  AssociationGroupJoinRequest,
  AssociationGroupMembership
} from '../models/associationGroup.js';
import { associationFeatureEnabled } from '../services/associationFeatureService.js';
import { calendarWindow, expandRecurringEvents } from '../services/associationEventService.js';
import { dangerAccess } from '../services/dangerReportService.js';
import { queueNotice } from '../services/notificationRecipients.js';
import { mobileCalendarEvent } from './mobileEvents.js';

export const mobileGroupsRouter = express.Router({ mergeParams: true });
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const activeStatus = { $in: ['active', 'suspended'] };

export const mobileGroup = (group, { memberCount = 0, isMember = false, applicationStatus = null } = {}) => ({
  id: String(group._id),
  name: group.name,
  description: group.publicDescription || group.purpose || '',
  photoURL: group.publicPhotos?.find(photo => photo?.url)?.url || null,
  memberCount,
  isMember,
  applicationStatus
});

mobileGroupsRouter.use(requireLogin, async (req, res, next) => {
  try {
    const association = await dangerAccess(req.params.associationId, req.user._id);
    if (!associationFeatureEnabled(association, 'groups')) {
      throw fail('この町内会では現在グループ活動を利用していません。', 404);
    }
    res.locals.mobileGroupsAssociation = association;
    res.set('Cache-Control', 'private, no-store');
    next();
  } catch (error) { next(error); }
}, provideCsrfToken);

mobileGroupsRouter.get('/', async (req, res, next) => {
  try {
    const association = res.locals.mobileGroupsAssociation;
    const groups = await AssociationGroup.find({ association: association._id, status: activeStatus })
      .sort({ name: 1 })
      .lean();
    const groupIds = groups.map(group => group._id);
    const [counts, memberships, requests] = groupIds.length ? await Promise.all([
      AssociationGroupMembership.aggregate([
        { $match: { association: association._id, group: { $in: groupIds }, status: 'active' } },
        { $group: { _id: '$group', count: { $sum: 1 } } }
      ]),
      AssociationGroupMembership.find({ association: association._id, group: { $in: groupIds }, user: req.user._id, status: 'active' }).select('group').lean(),
      AssociationGroupJoinRequest.find({ association: association._id, group: { $in: groupIds }, applicant: req.user._id, status: 'pending' }).select('group status').lean()
    ]) : [[], [], []];
    const countByGroup = new Map(counts.map(item => [String(item._id), item.count]));
    const memberGroups = new Set(memberships.map(item => String(item.group)));
    const requestByGroup = new Map(requests.map(item => [String(item.group), item.status]));
    return res.json({
      associationName: association.name,
      groups: groups.map(group => mobileGroup(group, {
        memberCount: countByGroup.get(String(group._id)) || 0,
        isMember: memberGroups.has(String(group._id)),
        applicationStatus: requestByGroup.get(String(group._id)) || null
      }))
    });
  } catch (error) { return next(error); }
});

mobileGroupsRouter.get('/:groupId', async (req, res, next) => {
  try {
    const association = res.locals.mobileGroupsAssociation;
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: association._id, status: activeStatus }).lean();
    if (!group) throw fail('グループを確認できません。', 404);
    const [memberships, allEvents, joinRequest] = await Promise.all([
      AssociationGroupMembership.find({ association: association._id, group: group._id, status: 'active' })
        .populate('user', 'displayname username avatar')
        .sort({ createdAt: 1 })
        .lean(),
      AssociationEvent.find({ association: association._id, group: group._id, visible: true })
        .sort({ startDate: 1, startTime: 1 })
        .lean(),
      AssociationGroupJoinRequest.findOne({ association: association._id, group: group._id, applicant: req.user._id, status: 'pending' }).lean()
    ]);
    const calendar = calendarWindow(req.query.month);
    const start = `${calendar.first.getFullYear()}-${String(calendar.first.getMonth() + 1).padStart(2, '0')}-01`;
    const endDate = new Date(calendar.first.getFullYear(), calendar.first.getMonth() + 3, 1);
    const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-01`;
    const events = expandRecurringEvents(allEvents, start, end)
      .filter(event => event.startDate < end && event.endDate >= start)
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.startTime.localeCompare(b.startTime));
    const activeMembers = memberships.filter(item => item.user);
    const isMember = activeMembers.some(item => String(item.user._id) === String(req.user._id));
    return res.json({
      group: mobileGroup(group, {
        memberCount: activeMembers.length,
        isMember,
        applicationStatus: joinRequest?.status || null
      }),
      members: activeMembers.map(item => ({
        id: String(item.user._id),
        name: item.user.displayname || item.user.username,
        avatar: item.user.avatar || ''
      })),
      currentMonth: calendar.currentMonth,
      previousMonth: calendar.previousMonth,
      nextMonth: calendar.nextMonth,
      months: calendar.months,
      events: events.map(mobileCalendarEvent),
      csrfToken: req.session.csrfToken
    });
  } catch (error) { return next(error); }
});

mobileGroupsRouter.post('/:groupId/join-requests', verifyCsrfToken, async (req, res, next) => {
  try {
    const association = res.locals.mobileGroupsAssociation;
    const group = await AssociationGroup.findOne({ _id: req.params.groupId, association: association._id, status: 'active' });
    if (!group) throw fail('参加できるグループを確認できません。', 404);
    if (await AssociationGroupMembership.exists({ group: group._id, user: req.user._id, status: { $in: ['active', 'pending'] } })) {
      throw fail('すでに参加中、または申請済みです。', 409);
    }
    const request = await AssociationGroupJoinRequest.findOneAndUpdate(
      { association: association._id, group: group._id, applicant: req.user._id, status: { $ne: 'pending' } },
      { $set: { status: 'pending' }, $unset: { decidedBy: 1, decidedAt: 1, rejectionReason: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).catch(error => {
      if (error.code === 11000) throw fail('すでに申請済みです。', 409);
      throw error;
    });
    const recipients = await AssociationGroupMembership.find({ association: association._id, group: group._id, role: 'manager', status: 'active' }).distinct('user');
    await queueNotice({ association: association._id, recipients, type: 'group_request', title: 'グループへの参加申請が届きました', relatedId: group._id, relatedRequest: request._id });
    return res.status(201).json({ ok: true, csrfToken: req.session.csrfToken });
  } catch (error) { return next(error); }
});

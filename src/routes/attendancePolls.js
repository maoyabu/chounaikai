import officeCrypto from 'officecrypto-tool';
import { surveyExportView } from '../services/surveyExportService.js';
import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { AttendancePoll, AttendanceResponse } from '../models/attendancePoll.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { AssociationGroupMembership } from '../models/associationGroup.js';
import { Notification } from '../models/notification.js';
import { createNotifications } from '../services/notificationService.js';
import { attendanceContext, attendanceError, attendanceId, pollValues, responseValues, resolveAttendanceRecipients, attendanceSummary, attendanceWorkbook } from '../services/attendancePollService.js';
export const attendancePollsRouter = express.Router();
attendancePollsRouter.use(requireLogin);
const root = id => `/associations/${id}/attendance`;
const scopeFilter = context => ({ scope: context.scope, ...(context.group ? { group: context.group._id } : {}), ...(context.districtGroup ? { districtGroup: context.districtGroup } : {}) });
const scopeQuery = context => new URLSearchParams({ scope: context.scope, ...(context.group ? { group: String(context.group._id) } : {}), ...(context.districtGroup ? { districtGroup: String(context.districtGroup) } : {}) }).toString();
const exportPassword = (req, poll) => surveyExportView(req, { ...poll, sender: poll.creator, responseMode: 'single' }).surveyExportPassword;
const loadPoll = async req => {
  if (![req.params.associationId, req.params.pollId].every(mongoose.isValidObjectId)) throw attendanceError('イベントを確認できません。', 404);
  const poll = await AttendancePoll.findOne({ _id: req.params.pollId, association: req.params.associationId }).lean();
  if (!poll) throw attendanceError('イベントを確認できません。', 404);
  const membership = await AssociationMembership.findOne({ association: poll.association, user: req.user._id, status: 'active' }).lean();
  if (!membership) throw attendanceError('所属する町内会のイベントのみ利用できます。', 403);
  const creator = attendanceId(poll.creator) === attendanceId(req.user);
  if (creator) await attendanceContext(req, { scope: poll.scope, group: poll.group, districtGroup: poll.districtGroup });
  else {
    if (!poll.recipients.some(id => attendanceId(id) === attendanceId(req.user))) throw attendanceError('対象者のみ回答できます。', 403);
    if (poll.scope === 'district' && attendanceId(membership.districtGroup) !== attendanceId(poll.districtGroup)) throw attendanceError('この班には所属していません。', 403);
    if (poll.scope === 'group' && !await AssociationGroupMembership.exists({ association: poll.association, group: poll.group, user: req.user._id, status: 'active' })) throw attendanceError('このグループには所属していません。', 403);
  }
  return { poll, creator };
};
attendancePollsRouter.get('/:associationId/attendance', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    const context = await attendanceContext(req);
    const polls = await AttendancePoll.find({ association: context.association._id, creator: req.user._id, ...scopeFilter(context) }).sort({ createdAt: -1 }).lean();
    const { scope: pollScope, ...viewContext } = context;
    return res.render('attendance-manage', { title: 'イベント出欠管理', ...viewContext, pollScope, polls, base: root(req.params.associationId), scopeQuery: scopeQuery(context) });
  } catch (error) { return next(error); }
});
attendancePollsRouter.post('/:associationId/attendance', verifyCsrfToken, async (req, res, next) => {
  try {
    const context = await attendanceContext(req, req.body);
    context.userId = req.user._id;
    const values = pollValues(req.body);
    const recipients = resolveAttendanceRecipients(req.body, context);
    const poll = await AttendancePoll.create({ association: context.association._id, creator: req.user._id, ...scopeFilter(context), ...values, recipients });
    const records = recipients.map(recipient => ({ association: poll.association, recipient, type: 'attendance_poll', title: `出欠確認：${poll.title}`, body: `日程候補ごとの出欠を回答してください。締め切り：${String(req.body.deadline)}。回答ページ：${root(poll.association)}/${poll._id}`, relatedType: 'AttendancePoll', relatedId: poll._id }));
    // Notification records are persisted before delivery; delivery failures never remove the poll.
    await createNotifications(records);
    req.session.notice = 'イベントを作成し、対象者へ出欠確認を通知しました。';
    return res.redirect(`${root(poll.association)}/${poll._id}`);
  } catch (error) { return next(error); }
});
attendancePollsRouter.get('/:associationId/attendance/:pollId', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    const { poll, creator } = await loadPoll(req);
    const responses = await AttendanceResponse.find({ association: poll.association, poll: poll._id }).lean();
    const ownResponse = responses.find(r => attendanceId(r.user) === attendanceId(req.user));
    const members = creator ? await AssociationMembership.find({ association: poll.association, user: { $in: poll.recipients } }).populate('user', 'displayname username').lean() : [];
    return res.render('attendance-detail', { title: poll.title, poll, creator, ownResponse, summary: attendanceSummary(poll, responses), responseCount: responses.length, responses: creator ? responses : [], members, canRespond: poll.recipients.some(id => attendanceId(id) === attendanceId(req.user)), closed: new Date(poll.deadline) <= new Date(), base: root(poll.association), exportPassword: creator ? exportPassword(req, poll) : null, scopeQuery: scopeQuery({ ...poll, group: poll.group ? { _id: poll.group } : null }) });
  } catch (error) { return next(error); }
});
attendancePollsRouter.post('/:associationId/attendance/:pollId/respond', verifyCsrfToken, async (req, res, next) => {
  try {
    const { poll } = await loadPoll(req);
    if (!poll.recipients.some(id => attendanceId(id) === attendanceId(req.user))) throw attendanceError('対象者のみ回答できます。', 403);
    const values = responseValues(req.body, poll);
    await AttendanceResponse.updateOne({ association: poll.association, poll: poll._id, user: req.user._id }, { $set: values }, { upsert: true, runValidators: true });
    await Notification.updateMany({ association: poll.association, recipient: req.user._id, type: 'attendance_poll', relatedId: poll._id, readAt: null }, { $set: { readAt: new Date() } });
    req.session.notice = '出欠を送りました。締め切りまでは変更できます。';
    return res.redirect(`${root(poll.association)}/${poll._id}`);
  } catch (error) { return next(error); }
});
attendancePollsRouter.get('/:associationId/attendance/:pollId/responses.xlsx', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    const { poll, creator } = await loadPoll(req);
    if (!creator) throw attendanceError('作成者のみ出欠表をダウンロードできます。', 403);
    const [responses, members] = await Promise.all([
      AttendanceResponse.find({ association: poll.association, poll: poll._id }).lean(),
      AssociationMembership.find({ association: poll.association, user: { $in: poll.recipients } }).populate('user', 'displayname username').lean()
    ]);
    const byId = new Map(members.filter(m => m.user).map(m => [attendanceId(m.user), m.user]));
    const users = poll.recipients.map(id => byId.get(attendanceId(id)) || { _id: id, displayname: '退会済み会員' });
    if (!req.session.surveyExportSecret) throw attendanceError('集計画面で開封パスワードを確認してください。', 409);
    const plain = await attendanceWorkbook(poll, responses, users);
    const buffer = await officeCrypto.encrypt(Buffer.from(plain), { password: exportPassword(req, poll) });
    res.attachment(`attendance-${poll._id}.xlsx`);
    return res.send(buffer);
  } catch (error) { return next(error); }
});

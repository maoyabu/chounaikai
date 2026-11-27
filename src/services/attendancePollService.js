import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import { loadQuestionBoxAccess } from './questionBoxService.js';
import { annualRoleYearFilter } from '../lib/annualRoleAccess.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { AssociationGroup, AssociationGroupMembership } from '../models/associationGroup.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { Department, DistrictGroup } from '../models/organization.js';
export const attendanceError = (message, status = 400) => Object.assign(new Error(message), { status });
export const attendanceId = value => String(value?._id || value || '');
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const validId = value => mongoose.isValidObjectId(value);
export const pollValues = (body, now = new Date()) => {
  const title = String(body.title || '').trim(), memo = String(body.memo || '').trim();
  if (!title || title.length > 150 || memo.length > 3000) throw attendanceError('イベント名は150文字以内、メモは3000文字以内で入力してください。');
  const dates = array(body.candidateDate), times = array(body.candidateTime);
  if (!dates.length || dates.length > 60 || dates.length !== times.length) throw attendanceError('日程候補は1〜60件で指定してください。');
  const today = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const candidates = dates.map((date, i) => {
    const time = times[i];
    if (typeof date !== 'string' || typeof time !== 'string' || !validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw attendanceError('候補の日付と時間を正しく入力してください。');
    if (Number(time.slice(3)) % 10 !== 0) throw attendanceError('候補の時間は10分単位で指定してください。');
    if (date < today) throw attendanceError('過去の日付は日程候補に登録できません。');
    return { date, time };
  });
  if (new Set(candidates.map(c => `${c.date} ${c.time}`)).size !== candidates.length) throw attendanceError('同じ日時の候補が重複しています。');
  const deadlineDate = String(body.deadline || '');
  if (!validDate(deadlineDate)) throw attendanceError('回答の締め切り日を正しく入力してください。');
  const deadline = new Date(`${deadlineDate}T23:59:59.999+09:00`);
  if (deadline <= now) throw attendanceError('回答の締め切り日は本日以降を指定してください。');
  return { title, memo, candidates, deadline };
};
export const responseValues = (body, poll, now = new Date()) => {
  if (new Date(poll.deadline) <= now) throw attendanceError('回答の締め切りを過ぎています。', 409);
  const answers = poll.candidates.map((_, i) => body[`answer${i}`]);
  if (answers.some(v => !['○', '△', '×'].includes(v))) throw attendanceError('すべての日程候補で○・△・×を選択してください。');
  const comment = String(body.comment || '').trim();
  if (comment.length > 1000) throw attendanceError('コメントは1000文字以内で入力してください。');
  return { answers, comment };
};
export const attendanceSummary = (poll, responses) => poll.candidates.map((candidate, i) => ({ ...candidate, counts: Object.fromEntries(['○', '△', '×'].map(mark => [mark, responses.filter(r => r.answers[i] === mark).length])) }));

// Re-evaluate current roles and eligible members on every request, including POST/export.
export const attendanceContext = async (req, input = req.query) => {
  const associationId = req.params.associationId, userId = req.user._id;
  const { association, membership, canAnswer } = await loadQuestionBoxAccess({ associationId, userId });
  const scope = input.scope || 'officer';
  let group, districtGroup, members;
  let districtGroups = [];
  let officers = [], leaders = [], departments = [];
  if (scope === 'group') {
    if (!validId(input.group)) throw attendanceError('グループを指定してください。');
    group = await AssociationGroup.findOne({ _id: input.group, association: associationId, status: 'active' }).lean();
    const manager = group && await AssociationGroupMembership.exists({ association: associationId, group: group._id, user: userId, status: 'active', role: 'manager' });
    if (!manager) throw attendanceError('グループ管理者のみ利用できます。', 403);
    const rows = await AssociationGroupMembership.find({ association: associationId, group: group._id, status: 'active' }).select('user').lean();
    members = await AssociationMembership.find({ association: associationId, status: 'active', user: { $in: rows.map(r => r.user) } }).populate('user', 'displayname username').lean();
  } else if (scope === 'district') {
    const assignments = await AnnualLeaderAssignment.find({ association: associationId, representative: userId, fiscalYear: annualRoleYearFilter(), cancelledAt: null }).select('districtGroup').lean();
    districtGroups = await DistrictGroup.find({ association: associationId, _id: { $in: assignments.map(a => a.districtGroup) }, active: true }).sort({ sortOrder: 1, name: 1 }).lean();
    districtGroup = input.districtGroup || districtGroups[0]?._id;
    if (!districtGroups.some(d => attendanceId(d) === attendanceId(districtGroup))) throw attendanceError('担当する班を指定してください。', 403);
    if (!validId(districtGroup) || !await AnnualLeaderAssignment.exists({ association: associationId, districtGroup, representative: userId, fiscalYear: annualRoleYearFilter(), cancelledAt: null })) throw attendanceError('担当する班の班長のみ利用できます。', 403);
    members = await AssociationMembership.find({ association: associationId, status: 'active', districtGroup }).populate('user', 'displayname username').lean();
  } else if (scope === 'officer') {
    if (!canAnswer) throw attendanceError('役員のみ利用できます。', 403);
    [members, officers, leaders, departments] = await Promise.all([
      AssociationMembership.find({ association: associationId, status: 'active' }).populate('user', 'displayname username').lean(),
      AnnualOfficer.find({ association: associationId, fiscalYear: annualRoleYearFilter(), cancelledAt: null }).select('user department').lean(),
      AnnualLeaderAssignment.find({ association: associationId, fiscalYear: annualRoleYearFilter(), cancelledAt: null }).select('representative').lean(),
      Department.find({ association: associationId, active: true }).sort({ sortOrder: 1, name: 1 }).lean()
    ]);
  } else throw attendanceError('作成メニューを確認してください。');
  return { association, userId, scope, group, districtGroup, districtGroups, members: members.filter(m => m.user), officers, leaders, departments };
};
export const resolveAttendanceRecipients = (body, context) => {
  const { scope, members, officers, leaders } = context;
  const eligible = new Set(members.map(m => attendanceId(m.user)));
  const leaderIds = leaders.map(l => attendanceId(l.representative));
  let ids;
  if (body.audience === 'selected') {
    ids = array(body.recipients).map(attendanceId);
    if (ids.some(id => !eligible.has(id))) throw attendanceError('対象外のメンバーが含まれています。', 403);
  } else if (body.audience === 'all') ids = [...eligible];
  else if (scope === 'officer' && ['officers', 'department', 'officer-selected'].includes(body.audience)) {
    let rows = officers;
    if (body.audience === 'department') {
      const departments = [...new Set(array(body.department).map(attendanceId))];
      if (!departments.length) throw attendanceError('部会を1つ以上選択してください。');
      if (departments.some(id => !context.departments.some(d => attendanceId(d) === id))) throw attendanceError('対象外の部会が含まれています。', 403);
      rows = rows.filter(o => departments.includes(attendanceId(o.department)));
    }
    const officerIds = new Set(rows.map(o => attendanceId(o.user)));
    ids = body.audience === 'officer-selected' ? array(body.recipients).map(attendanceId) : [...officerIds];
    if (ids.some(id => !officerIds.has(id))) throw attendanceError('役員以外のメンバーが含まれています。', 403);
    if (body.includeLeaders === 'on') ids.push(...leaderIds);
    else ids = ids.filter(id => !leaderIds.includes(id));
  } else throw attendanceError('対象者の選択方法を確認してください。');
  ids = [...new Set(ids)].filter(id => eligible.has(id));
  if (!ids.length) throw attendanceError('対象者を1人以上選択してください。');
  return ids;
};
export const attendanceWorkbook = async (poll, responses, users) => {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet('日程集計');
  summary.addRow([poll.title]); summary.addRow(['日程候補', '○', '△', '×']);
  for (const row of attendanceSummary(poll, responses)) summary.addRow([`${row.date} ${row.time}`, row.counts['○'], row.counts['△'], row.counts['×']]);
  summary.addRow(['未回答', poll.recipients.length - responses.length]);
  const sheet = workbook.addWorksheet('出欠表');
  sheet.addRow(['氏名', ...poll.candidates.map(c => `${c.date} ${c.time}`), 'コメント']);
  for (const user of users) {
    const response = responses.find(r => attendanceId(r.user) === attendanceId(user));
    sheet.addRow([user.displayname || user.username || '退会済み会員', ...poll.candidates.map((_, i) => response?.answers[i] || '未回答'), response?.comment || '']);
  }
  for (const tab of workbook.worksheets) { tab.columns.forEach(c => { c.width = 24; }); tab.getRow(1).font = { bold: true }; }
  return workbook.xlsx.writeBuffer();
};

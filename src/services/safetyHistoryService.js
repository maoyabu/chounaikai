import { AlertEvent } from '../models/alertEvent.js';
import { SafetyReport } from '../models/safetyReport.js';
import { Household, HouseholdMember } from '../models/organization.js';
import { loadQuestionBoxAccess } from './questionBoxService.js';
import { summarizeSafety } from '../lib/safetyStatus.js';
import mongoose from 'mongoose';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const validEventKey = key => typeof key === 'string' && /^(?:initial|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(key);

export async function readSafetySnapshot(associationId, eventKey, session) {
  const options = session ? { session } : {};
  const households = await Household.find({ association: associationId, active: true, deletedAt: { $exists: false } }, null, options).populate('districtGroup', 'name').sort({ displayName: 1, _id: 1 }).lean();
  const ids = households.map(h => h._id);
  const [members, reports] = await Promise.all([
    HouseholdMember.find({ association: associationId, household: { $in: ids }, endsAt: null }, null, options).populate('user', 'displayname username').lean(),
    SafetyReport.find({ association: associationId, eventKey, household: { $in: ids } }, null, options).lean()
  ]);
  return {
    households: households.map(h => ({ _id: String(h._id), displayName: h.displayName, districtGroup: h.districtGroup ? { name: h.districtGroup.name } : null, address: h.address })),
    members: members.map(m => ({ _id: String(m._id), household: String(m.household), name: m.user?.displayname || m.name, supportRequired: m.supportRequired, supportPriority: m.supportPriority })),
    reports: reports.map(r => ({ household: String(r.household), memberStatuses: r.memberStatuses instanceof Map ? Object.fromEntries(r.memberStatuses) : r.memberStatuses, buildingStatus: r.buildingStatus, updatedAt: r.updatedAt }))
  };
}

const requireHistoryOfficer = async (associationId, userId) => {
  const access = await loadQuestionBoxAccess({ associationId, userId });
  if (!access.canAnswer) throw fail('役員・町内会管理者のみ履歴を確認できます。', 403);
  return access.association;
};

export async function listAlertHistory(associationId, userId) {
  const association = await requireHistoryOfficer(associationId, userId);
  const events = await AlertEvent.find({ association: associationId }).select('-safetySnapshot').populate('changes.by', 'displayname username').sort({ startedAt: -1, _id: -1 }).lean();
  return { association, events };
}

export async function loadAlertHistory(associationId, userId, eventKey) {
  const association = await requireHistoryOfficer(associationId, userId);
  if (!validEventKey(eventKey)) throw fail('警戒情報を確認できません。', 404);
  const event = await AlertEvent.findOne({ association: associationId, eventKey }).populate('changes.by', 'displayname username').lean();
  if (!event) throw fail('警戒情報を確認できません。', 404);
  event.changes.sort((a, b) => new Date(a.at) - new Date(b.at));
  return { association, event };
}

export async function loadSafetyHistory(associationId, userId, eventKey) {
  const association = await requireHistoryOfficer(associationId, userId);
  if (!validEventKey(eventKey)) throw fail('安否情報を確認できません。', 404);
  const event = await AlertEvent.findOne({ association: associationId, eventKey }).select('-changes').lean();
  if (!event) {
    if (association.alertLevel && (association.safetyEventKey || 'initial') === eventKey) throw fail('発令中の安否情報は現在の安否確認ページで確認してください。', 409);
    return loadLegacySafety(association, eventKey);
  }
  if (!event.endedAt) throw fail('発令中の安否情報は現在の安否確認ページで確認してください。', 409);
  if (!event.safetySnapshot) throw fail('この警戒情報には解除時点の安否記録がありません。', 404);
  const snapshot = JSON.parse(event.safetySnapshot);
  return { association, event, historyMode: true, summary: summarizeSafety(snapshot.households, snapshot.members, snapshot.reports) };
}

export async function listSafetyHistory(associationId, userId) {
  const context = await listAlertHistory(associationId, userId);
  const oldReports = await SafetyReport.aggregate([
    { $match: { association: new mongoose.Types.ObjectId(String(associationId)) } },
    { $group: { _id: '$eventKey', firstReportAt: { $min: '$createdAt' }, lastReportAt: { $max: '$updatedAt' } } }
  ]);
  const keys = new Set(context.events.map(event => event.eventKey));
  for (const report of oldReports) {
    if (keys.has(report._id) || !validEventKey(report._id)) continue;
    context.events.push({ eventKey: report._id, legacy: true, firstReportAt: report.firstReportAt, lastReportAt: report.lastReportAt, changes: [] });
  }
  context.events.sort((a, b) => new Date(b.startedAt || b.firstReportAt || 0) - new Date(a.startedAt || a.firstReportAt || 0));
  return context;
}

async function loadLegacySafety(association, eventKey) {
  const reports = await SafetyReport.find({ association: association._id, eventKey }).lean();
  if (!reports.length) throw fail('安否情報を確認できません。', 404);
  const householdIds = reports.map(report => report.household);
  const [households, members] = await Promise.all([
    Household.find({ association: association._id, _id: { $in: householdIds } }).select('_id displayName').lean(),
    HouseholdMember.find({ association: association._id, household: { $in: householdIds } }).select('_id household name').lean()
  ]);
  const people = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const legacyReports = reports.map(report => {
    const statuses = report.memberStatuses instanceof Map ? Object.fromEntries(report.memberStatuses) : report.memberStatuses || {};
    const family = Object.entries(statuses).filter(([, status]) => [1, 2, 3, 4].includes(status)).map(([id, status]) => {
      people[status]++;
      return { name: members.find(m => String(m._id) === id && String(m.household) === String(report.household))?.name || '削除済みの家族', status };
    });
    return { ...report, householdName: households.find(h => String(h._id) === String(report.household))?.displayName || '削除済みの世帯', family };
  });
  return { association, event: { eventKey }, legacyHistory: true, legacyReports, people };
}

import { runWithOptionalTransaction } from './associationService.js';
import mongoose from 'mongoose';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { Household, HouseholdMember } from '../models/organization.js';
import { SafetyReport } from '../models/safetyReport.js';
import { loadQuestionBoxAccess } from './questionBoxService.js';
import { householdSafetyState, safetyEventKey, summarizeSafety, summarizeSafetyRoster } from '../lib/safetyStatus.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const activeHouseholds = association => ({ association, active: true, deletedAt: { $exists: false } });

export function parseSafetyReport(body, members) {
  const selected = body.memberIds === undefined ? [] : typeof body.memberIds === 'string' ? [body.memberIds] : body.memberIds;
  if (!Array.isArray(selected) || selected.length > members.length || new Set(selected).size !== selected.length) throw fail('登録する家族を確認してください。');
  const allowed = new Set(members.map(m => String(m._id)));
  const memberStatuses = {};
  for (const id of selected) {
    if (typeof id !== 'string' || !allowed.has(id)) throw fail('この世帯の家族だけを登録できます。', 403);
    const status = body[`status_${id}`];
    if (!['1', '2', '3', '4'].includes(status)) throw fail('家族の安否情報を選択してください。');
    memberStatuses[id] = Number(status);
  }
  const building = body.buildingStatus === undefined || body.buildingStatus === '' ? '1' : body.buildingStatus;
  if (!['1', '2', '3', '4'].includes(building)) throw fail('建物の状態を選択してください。');
  return { memberStatuses, buildingStatus: Number(building) };
}

export async function loadResidentSafety(associationId, userId) {
  if (!mongoose.isValidObjectId(associationId)) throw fail('町内会を確認してください。', 404);
  const [association, membership] = await Promise.all([
    NeighborhoodAssociation.findOne({ _id: associationId, status: 'active', deletedAt: { $exists: false } }).lean(),
    AssociationMembership.findOne({ association: associationId, user: userId, status: 'active' }).lean()
  ]);
  if (!association || !membership) throw fail('参加中の町内会でのみ安否を登録できます。', 403);
  const household = membership.household && await Household.findOne({ ...activeHouseholds(associationId), _id: membership.household }).lean();
  if (!household) return { association, household: null, members: [], report: null };
  const [members, report] = await Promise.all([
    HouseholdMember.find({ association: associationId, household: household._id, endsAt: null }).populate('user', 'displayname username').sort({ isRepresentative: -1, createdAt: 1 }).lean(),
    SafetyReport.findOne({ association: associationId, eventKey: safetyEventKey(association), household: household._id }).lean()
  ]);
  return { association, household, members, report };
}

export async function saveResidentSafety({ associationId, userId, body }) {
  const context = await loadResidentSafety(associationId, userId);
  const { association, household, members } = context;
  if (!association.alertLevel) throw fail('現在、警戒レベルは登録されていません。', 409);
  if (!household) throw fail('世帯情報を登録してから安否を登録してください。');
  if (body.eventKey !== safetyEventKey(association)) throw fail('警戒情報が更新されています。画面を開き直してください。', 409);
  const values = parseSafetyReport(body, members);
  const filter = { association: associationId, eventKey: safetyEventKey(association), household: household._id };
  const set = { buildingStatus: values.buildingStatus, updatedBy: userId };
  for (const [id, status] of Object.entries(values.memberStatuses)) set[`memberStatuses.${id}`] = status;
  await runWithOptionalTransaction(async session => {
    const options = session ? { session } : {};
    // Touch the same association as alert changes so a release and a submission
    // cannot cross within a MongoDB transaction.
    const result = await NeighborhoodAssociation.updateOne({ _id: associationId, status: 'active', deletedAt: { $exists: false }, alertLevel: { $gt: 0 }, safetyEventKey: association.safetyEventKey ?? null }, { $inc: { safetyRevision: 1 } }, options);
    if (!result.matchedCount) throw fail('警戒情報が更新されています。画面を開き直してください。', 409);
    // Update only checked members, preserving reports submitted by other family members.
    try {
      await SafetyReport.updateOne(filter, { $set: set }, { ...options, upsert: true, runValidators: true });
    } catch (error) {
      if (error.code !== 11000 || session) throw error;
      await SafetyReport.updateOne(filter, { $set: set }, { runValidators: true });
    }
  });
  return context;
}

export async function attachDashboardSafety(memberships) {
  const targets = memberships.filter(m => m.association.alertLevel && m.household);
  if (!targets.length) return;
  const householdIds = targets.map(m => m.household);
  const associationIds = targets.map(m => m.association._id);
  const [households, members, reports] = await Promise.all([
    Household.find({ _id: { $in: householdIds }, association: { $in: associationIds }, active: true, deletedAt: { $exists: false } }).select('_id association').lean(),
    HouseholdMember.find({ association: { $in: associationIds }, household: { $in: householdIds }, endsAt: null }).select('_id household association').lean(),
    SafetyReport.find({ $or: targets.map(m => ({ association: m.association._id, household: m.household, eventKey: safetyEventKey(m.association) })) }).lean()
  ]);
  for (const membership of targets) {
    const household = households.find(h => String(h._id) === String(membership.household) && String(h.association) === String(membership.association._id));
    if (!household) continue;
    const family = members.filter(m => String(m.household) === String(household._id) && String(m.association) === String(membership.association._id));
    const report = reports.find(r => String(r.household) === String(household._id) && String(r.association) === String(membership.association._id) && r.eventKey === safetyEventKey(membership.association));
    membership.safetyState = householdSafetyState(family, report);
  }
}

export async function loadOfficerSafety(associationId, userId) {
  const { association, canAnswer } = await loadQuestionBoxAccess({ associationId, userId });
  if (!canAnswer) throw fail('役員・町内会管理者のみ安否情報を確認できます。', 403);
  const households = await Household.find(activeHouseholds(associationId)).populate('districtGroup', 'name').sort({ displayName: 1, _id: 1 }).lean();
  const [members, reports] = await Promise.all([
    HouseholdMember.find({ association: associationId, household: { $in: households.map(h => h._id) }, endsAt: null }).populate('user', 'displayname username').lean(),
    association.alertLevel ? SafetyReport.find({ association: associationId, eventKey: safetyEventKey(association), household: { $in: households.map(h => h._id) } }).lean() : Promise.resolve([])
  ]);
  return { association, summary: association.alertLevel ? summarizeSafety(households, members, reports) : summarizeSafetyRoster(households, members) };
}

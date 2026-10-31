import mongoose from 'mongoose';
import { Household, HouseholdMember } from '../models/organization.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function parseMemberSupport(values) {
  if (!['yes', 'no', 'unregistered'].includes(values.supportRequired)) throw fail('支援要否を選択してください。');
  if (values.supportRequired === 'unregistered') return { $unset: { supportRequired: 1, supportPriority: 1 } };
  if (values.supportRequired === 'no') return { $set: { supportRequired: false }, $unset: { supportPriority: 1 } };
  if (!['1', '2', '3'].includes(values.supportPriority)) throw fail('優先度を1〜3から選択してください。');
  return { $set: { supportRequired: true, supportPriority: Number(values.supportPriority) } };
}

export async function saveMemberSupport({ associationId, householdId, memberId, actorId, values }) {
  if (![associationId, householdId, memberId].every(mongoose.isValidObjectId)) throw fail('家族を確認してください。');
  const change = parseMemberSupport(values);
  const household = await Household.findOne({ _id: householdId, association: associationId, active: true });
  const member = household && await HouseholdMember.findOne({ _id: memberId, household: householdId, association: associationId, endsAt: null });
  if (!member || !await NeighborhoodAssociation.exists({ _id: associationId, status: 'active', deletedAt: { $exists: false } })) throw fail('家族を確認できません。', 404);
  if (!await AssociationMembership.exists({ association: associationId, household: householdId, user: actorId, status: 'active' })) throw fail('参加中の世帯を確認できません。', 403);
  const own = String(member.user || '') === String(actorId);
  const managed = !member.user && String(household.representative) === String(actorId);
  if (!own && !managed) throw fail('本人または世帯主が管理する未紐付けの家族のみ登録できます。', 403);
  return HouseholdMember.updateOne({ _id: memberId, household: householdId, association: associationId, endsAt: null }, change);
}

import { annualRoleYearFilter } from '../lib/annualRoleAccess.js';
import mongoose from 'mongoose';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { OfficerContactGroup } from '../models/officerContactGroup.js';
import { RoleAssignment, RoleDefinition } from '../models/role.js';
import { requireAnnouncementOfficer } from './officerAnnouncementService.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export const currentOfficerIds = async associationId => {
  const officers = await AnnualOfficer.find({ association: associationId, fiscalYear: annualRoleYearFilter(), cancelledAt: null }).select('user').lean();
  const managerRoles = await RoleDefinition.find({ association: associationId, active: true, permissions: 'association.manage' }).distinct('_id');
  const now = new Date();
  const managers = managerRoles.length ? await RoleAssignment.find({ association: associationId, role: { $in: managerRoles }, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] }).select('user').lean() : [];
  const memberships = await AssociationMembership.find({ association: associationId, status: 'active', user: { $in: [...officers, ...managers].map(item => item.user) } }).select('user').lean();
  return new Set(memberships.map(item => String(item.user)));
};

export const saveOfficerContactGroup = async ({ associationId, userId, groupId, name, members }) => {
  await requireAnnouncementOfficer(associationId, userId);
  const title = String(name ?? '').trim();
  if (!title || title.length > 80) throw fail('グループ名は1〜80文字で入力してください。');
  const values = (Array.isArray(members) ? members : members ? [members] : []).map(String);
  if (!values.length || values.some(value => !mongoose.isValidObjectId(value))) throw fail('役員を1人以上選んでください。');
  const uniqueIds = [...new Set(values)];
  const eligibleIds = await currentOfficerIds(associationId);
  if (uniqueIds.some(value => !eligibleIds.has(value))) throw fail('現年度の役員だけをグループに追加できます。');
  if (groupId) {
    if (!mongoose.isValidObjectId(groupId)) throw fail('グループを確認できません。', 404);
    const updated = await OfficerContactGroup.findOneAndUpdate({ _id: groupId, association: associationId }, { $set: { name: title, members: uniqueIds } }, { new: true });
    if (!updated) throw fail('グループを確認できません。', 404);
    return updated;
  }
  return OfficerContactGroup.create({ association: associationId, name: title, members: uniqueIds, createdBy: userId });
};

export const deleteOfficerContactGroup = async ({ associationId, userId, groupId }) => {
  await requireAnnouncementOfficer(associationId, userId);
  if (!mongoose.isValidObjectId(groupId)) throw fail('グループを確認できません。', 404);
  const result = await OfficerContactGroup.deleteOne({ _id: groupId, association: associationId });
  if (!result.deletedCount) throw fail('グループを確認できません。', 404);
};

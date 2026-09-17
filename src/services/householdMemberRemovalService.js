import mongoose from 'mongoose';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { Household, HouseholdMember } from '../models/organization.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { RoleAssignment } from '../models/role.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { Invitation, JoinApplication, WithdrawalApplication } from '../models/workflow.js';
import { Group } from '../models/group.js';
import { User } from '../models/user.js';
import { AuditLog } from '../models/auditLog.js';
import { Notification } from '../models/notification.js';
import { runWithOptionalTransaction } from './associationService.js';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const fiscalYear = now => now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
const same = (left, right) => String(left) === String(right);

export const removeLinkedHouseholdMember = async ({ associationId, householdId, memberId, actorId, now = new Date() }) => {
  if (![associationId, householdId, memberId, actorId].every(mongoose.isValidObjectId)) throw fail('世帯メンバーを確認してください。', 400);
  const journal = [];
  let groupRestore, userRestore, groupId, memberUserId, notificationId, auditId;
  return runWithOptionalTransaction(async session => {
    const options = session ? { session } : {};
    const household = await Household.findOne({ _id: householdId, association: associationId, representative: actorId, active: true }).session(session).lean();
    if (!household || !await AssociationMembership.exists({ association: associationId, household: householdId, user: actorId, status: 'active' }).session(session)) throw fail('参加中の世帯主だけがメンバーを削除できます。', 403);
    const member = await HouseholdMember.findOne({ _id: memberId, association: associationId, household: householdId, isRepresentative: false, endsAt: null }).session(session).lean();
    if (!member?.user || same(member.user, actorId)) throw fail('削除できるアカウント紐付け済みメンバーを確認できません。', 404);
    const association = await NeighborhoodAssociation.findOne({ _id: associationId, status: 'active', deletedAt: { $exists: false } }).session(session).lean();
    const group = association?.group && await Group.findById(association.group).select('members').session(session).lean();
    const user = await User.findById(member.user).select('groups defaultGroup').session(session).lean();
    if (!association || !group) throw fail('町内会を確認できません。');
    if (await WithdrawalApplication.exists({ association: associationId, household: householdId, requestedBy: member.user, status: 'processing' }).session(session)) throw fail('退会処理中のメンバーは削除できません。処理完了後に再度お試しください。');
    groupId = association.group;
    memberUserId = member.user;

    const update = async (Model, filter, change, fields) => {
      const before = await Model.find(filter).session(session).lean();
      if (!before.length) return 0;
      const result = await Model.updateMany({ ...filter, _id: { $in: before.map(item => item._id) } }, change, options);
      if (result.modifiedCount) journal.push({ Model, before, fields });
      return result.modifiedCount;
    };
    if (await update(HouseholdMember, { _id: member._id, user: member.user, endsAt: null }, { $set: { endsAt: now } }, ['endsAt']) !== 1) throw fail('世帯メンバーの状態が変更されました。画面を開き直してください。');
    await update(AssociationMembership, { association: associationId, household: householdId, user: member.user, status: { $in: ['active', 'pending', 'withdrawal_pending'] } }, { $set: { status: 'inactive', endedAt: now } }, ['status', 'endedAt']);
    await update(RoleAssignment, { association: associationId, user: member.user, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] }, { $set: { endsAt: new Date(now.getTime() - 1) } }, ['endsAt']);
    await update(AnnualOfficer, { association: associationId, user: member.user, fiscalYear: { $gte: fiscalYear(now) }, cancelledAt: null }, { $set: { cancelledAt: now } }, ['cancelledAt']);
    await update(AnnualLeaderAssignment, { association: associationId, representative: member.user, fiscalYear: { $gte: fiscalYear(now) }, cancelledAt: null }, { $set: { cancelledAt: now } }, ['cancelledAt']);
    await update(Invitation, { association: associationId, household: householdId, householdMember: member._id, status: 'pending' }, { $set: { status: 'cancelled', cancelledAt: now } }, ['status', 'cancelledAt']);
    await update(JoinApplication, { association: associationId, household: householdId, applicant: member.user, status: { $in: ['pending', 'awaiting_household'] } }, { $set: { status: 'cancelled', cancelledAt: now } }, ['status', 'cancelledAt']);
    await update(WithdrawalApplication, { association: associationId, household: householdId, requestedBy: member.user, status: { $in: ['pending', 'awaiting_household'] } }, { $set: { status: 'cancelled' } }, ['status']);

    groupRestore = (group.members || []).some(id => same(id, member.user));
    userRestore = user ? { group: (user.groups || []).some(id => same(id, association.group)), defaultGroup: same(user.defaultGroup, association.group) } : null;
    await Group.updateOne({ _id: association.group }, { $pull: { members: member.user } }, options);
    if (user) {
      await User.updateOne({ _id: member.user }, { $pull: { groups: association.group } }, options);
      await User.updateOne({ _id: member.user, defaultGroup: association.group }, { $unset: { defaultGroup: '' } }, options);
      const [notification] = await Notification.create([{ association: associationId, recipient: member.user, type: 'household_removed', title: '世帯から削除されました', body: '世帯主により世帯から削除され、町内会への参加が終了しました。共通アカウントは削除されていません。', relatedType: 'Household', relatedId: householdId }], options);
      notificationId = notification._id;
    }
    const [audit] = await AuditLog.create([{ association: associationId, actor: actorId, action: 'household.member.removed_by_head', targetType: 'HouseholdMember', targetId: member._id, before: { user: member.user, household: householdId }, after: { endsAt: now, sharedAccountPreserved: true } }], options);
    auditId = audit._id;
    return { member, accountExists: Boolean(user) };
  }, async () => {
    for (const { Model, before, fields } of journal.reverse()) for (const document of before) {
      const set = {}, unset = {};
      for (const field of fields) if (document[field] === undefined) unset[field] = ''; else set[field] = document[field];
      await Model.updateOne({ _id: document._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    }
    if (groupRestore) await Group.updateOne({ _id: groupId }, { $addToSet: { members: memberUserId } });
    if (userRestore?.group) await User.updateOne({ _id: memberUserId }, { $addToSet: { groups: groupId } });
    if (userRestore?.defaultGroup) await User.updateOne({ _id: memberUserId, defaultGroup: { $exists: false } }, { $set: { defaultGroup: groupId } });
    if (notificationId) await Notification.deleteOne({ _id: notificationId });
    if (auditId) await AuditLog.deleteOne({ _id: auditId });
  });
};

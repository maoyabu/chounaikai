import mongoose from 'mongoose';
import { WithdrawalApplication, Invitation, JoinApplication } from '../models/workflow.js';
import { Household, HouseholdMember, DistrictGroup } from '../models/organization.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { RoleAssignment } from '../models/role.js';
import { User } from '../models/user.js';
import { Group } from '../models/group.js';
import { Notification } from '../models/notification.js';
import { AuditLog } from '../models/auditLog.js';
import { runWithOptionalTransaction } from './associationService.js';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const year = (now = new Date()) => now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
const same = (a, b) => String(a) === String(b);
const ids = documents => documents.map(document => document._id);
const validIds = (...values) => { if (!values.every(mongoose.isValidObjectId)) throw fail('申請情報を確認してください。', 400); };

const context = async (associationId, householdId, session = null) => {
  const association = await NeighborhoodAssociation.findOne({ _id: associationId, status: 'active', deletedAt: { $exists: false } }).session(session).lean();
  const household = await Household.findOne({ _id: householdId, association: associationId, active: true }).session(session).lean();
  if (!association || !household || !await DistrictGroup.exists({ _id: household.districtGroup, association: associationId, active: true }).session(session)) throw fail('参加中の町内会・世帯・班を確認できません。');
  if (!await AssociationMembership.exists({ association: associationId, household: householdId, user: household.representative, status: 'active' }).session(session)) throw fail('現在の世帯主を確認できません。');
  return { association, household };
};

const notify = async (application, type, recipients) => {
  try {
    for (const recipient of new Set(recipients.map(String))) await Notification.create({ association: application.association, recipient, type,
      title: type === 'withdrawal_head_requested' ? '世帯メンバーから退会申請が届きました' : type === 'withdrawal_leader_requested' ? '班・世帯から退会申請が届きました' : type === 'withdrawal_approved' ? '町内会の退会が完了しました' : '退会申請が承認されませんでした',
      body: type === 'withdrawal_head_requested' ? 'プロフィールの「退会申請」から確認してください。' : type === 'withdrawal_leader_requested' ? '班長メニューの「退会申請」から確認してください。' : 'プロフィールの「退会申請」から申請状況を確認できます。共通アカウントは削除されません。', relatedType: 'WithdrawalApplication', relatedId: application._id });
  } catch (error) { console.error('Withdrawal notification failed', error.message); }
};
const notifyLeaders = async application => {
  const leaders = await AnnualLeaderAssignment.find({ association: application.association, districtGroup: application.districtGroup, fiscalYear: year(), cancelledAt: null }).select('representative').lean();
  await notify(application, 'withdrawal_leader_requested', leaders.map(leader => leader.representative));
};
const safelyNotifyLeaders = async application => { try { await notifyLeaders(application); } catch (error) { console.error('Withdrawal leader notification failed', error.message); } };

export const requestWithdrawal = async ({ associationId, userId, scope, successorId, reason, confirmed }) => {
  validIds(associationId, userId);
  if (!confirmed) throw fail('退会の内容を確認してチェックしてください。', 400);
  const membership = await AssociationMembership.findOne({ association: associationId, user: userId, status: 'active' }).lean();
  if (!membership?.household) throw fail('参加中の世帯を確認できません。', 403);
  const { household } = await context(associationId, membership.household);
  if (!same(membership.districtGroup, household.districtGroup)) throw fail('所属班が変更されています。管理者にご確認ください。');
  const isHead = same(household.representative, userId);
  if (isHead ? !['household', 'representative'].includes(scope) : scope !== 'individual') throw fail('退会方法を選択してください。', 400);
  if (scope === 'representative') {
    validIds(successorId);
    if (same(successorId, userId) || !await AssociationMembership.exists({ association: associationId, household: household._id, districtGroup: household.districtGroup, user: successorId, status: 'active' }) || !await HouseholdMember.exists({ association: associationId, household: household._id, user: successorId, endsAt: null })) throw fail('同じ世帯の参加中の会員から新しい世帯主を選んでください。', 400);
  }
  const members = scope === 'household' ? await AssociationMembership.find({ association: associationId, household: household._id, status: 'active' }).lean() : [membership];
  const application = await WithdrawalApplication.create({ association: associationId, membership: membership._id, requestedBy: userId, household: household._id, districtGroup: household.districtGroup, originalRepresentative: household.representative, scope,
    successor: scope === 'representative' ? successorId : undefined, membershipIds: ids(members), reason: String(reason || '').trim().slice(0, 1000), status: isHead ? 'pending' : 'awaiting_household', householdConfirmedBy: isHead ? userId : undefined, householdConfirmedAt: isHead ? new Date() : undefined });
  if (isHead) await safelyNotifyLeaders(application); else await notify(application, 'withdrawal_head_requested', [household.representative]);
  return application;
};

export const confirmWithdrawal = async ({ associationId, applicationId, actorId, approve }) => {
  validIds(associationId, applicationId, actorId);
  const application = await WithdrawalApplication.findOne({ _id: applicationId, association: associationId, status: 'awaiting_household', scope: 'individual' }).lean();
  if (!application) throw fail('確認待ちの退会申請がありません。', 404);
  const { household } = await context(associationId, application.household);
  if (!same(household.representative, actorId) || !same(household.representative, application.originalRepresentative)) throw fail('現在の世帯主だけが承認できます。', 403);
  if (!await AssociationMembership.exists({ _id: application.membership, association: associationId, household: household._id, user: application.requestedBy, status: 'active' })) throw fail('申請者の所属が変更されています。');
  const result = await WithdrawalApplication.updateOne({ _id: applicationId, status: 'awaiting_household' }, { $set: approve ? { status: 'pending', householdConfirmedBy: actorId, householdConfirmedAt: new Date() } : { status: 'rejected', decidedBy: actorId, decidedAt: new Date() } });
  if (result.modifiedCount !== 1) throw fail('この申請は既に確認されています。');
  if (approve) await safelyNotifyLeaders(application); else await notify(application, 'withdrawal_rejected', [application.requestedBy]);
};

export const decideWithdrawal = async ({ associationId, applicationId, actorId, approve }) => {
  validIds(associationId, applicationId, actorId);
  const now = new Date(), journal = [], groupUndo = [];
  let application, notificationRecipients = [], auditId;
  await runWithOptionalTransaction(async session => {
    journal.length = 0;
    groupUndo.length = 0;
    auditId = undefined;
    const options = session ? { session } : {};
    application = await WithdrawalApplication.findOne({ _id: applicationId, association: associationId, status: 'pending' }).session(session).lean();
    if (!application) throw fail('班長の承認待ちの申請がありません。', 404);
    const { association, household } = await context(associationId, application.household, session);
    if (!same(household.districtGroup, application.districtGroup) || !same(household.representative, application.originalRepresentative) || !application.householdConfirmedBy || !same(application.householdConfirmedBy, household.representative)) throw fail('世帯主・班が変更されています。申請を取り消して再申請してください。');
    if (!await AssociationMembership.exists({ association: associationId, user: actorId, status: 'active' }).session(session) || !await AnnualLeaderAssignment.exists({ association: associationId, representative: actorId, districtGroup: household.districtGroup, fiscalYear: year(now), cancelledAt: null }).session(session)) throw fail('担当班の現在年度の班長だけが承認できます。', 403);
    const mutate = async (Model, filter, update, fields) => {
      const before = await Model.find(filter).session(session).lean();
      journal.push({ Model, before, fields });
      return Model.updateMany({ _id: { $in: ids(before) }, ...filter }, update, options);
    };
    const claim = await WithdrawalApplication.updateOne({ _id: applicationId, status: 'pending' }, { $set: { status: 'processing' } }, options);
    if (claim.modifiedCount !== 1) throw fail('この申請は既に処理されています。');
    journal.push({ Model: WithdrawalApplication, before: [application], fields: ['status', 'decidedBy', 'decidedAt'] });
    const memberships = await AssociationMembership.find({ association: associationId, household: household._id, _id: { $in: application.membershipIds }, status: 'active' }).session(session).lean();
    if (!memberships.length || memberships.length !== application.membershipIds.length || memberships.some(member => !same(member.districtGroup, household.districtGroup)) || !memberships.some(member => same(member._id, application.membership) && same(member.user, application.requestedBy))) throw fail('申請後に所属情報が変更されています。再申請してください。');
    if (application.scope !== 'household' && (memberships.length !== 1 || (application.scope === 'individual' && same(application.requestedBy, household.representative)))) throw fail('退会対象を確認できません。');
    notificationRecipients = memberships.map(member => member.user);
    if (approve) {
      if (application.scope === 'household') {
        const current = await AssociationMembership.find({ association: associationId, household: household._id, status: 'active' }).session(session).lean();
        if (current.length !== memberships.length) throw fail('申請後に世帯メンバーが増えています。再申請してください。');
        const change = await mutate(Household, { _id: household._id, active: true, representative: household.representative, districtGroup: household.districtGroup, updatedAt: household.updatedAt }, { $set: { active: false } }, ['active']);
        if (change.matchedCount !== 1) throw fail('世帯情報が変更されました。再申請してください。');
      } else if (application.scope === 'representative') {
        if (!same(application.requestedBy, household.representative) || !await AssociationMembership.exists({ association: associationId, household: household._id, districtGroup: household.districtGroup, user: application.successor, status: 'active' }).session(session) || !await HouseholdMember.exists({ association: associationId, household: household._id, user: application.successor, endsAt: null }).session(session)) throw fail('新しい世帯主が参加中ではありません。再申請してください。');
        const change = await mutate(Household, { _id: household._id, active: true, representative: household.representative, districtGroup: household.districtGroup, updatedAt: household.updatedAt }, { $set: { representative: application.successor } }, ['representative']);
        if (change.matchedCount !== 1) throw fail('世帯情報が変更されました。再申請してください。');
        await mutate(HouseholdMember, { association: associationId, household: household._id, isRepresentative: true }, { $set: { isRepresentative: false } }, ['isRepresentative']);
        await mutate(HouseholdMember, { association: associationId, household: household._id, user: application.successor }, { $set: { isRepresentative: true } }, ['isRepresentative']);
      }
      const users = memberships.map(member => member.user);
      const withdrawn = await mutate(AssociationMembership, { _id: { $in: ids(memberships) }, association: associationId, household: household._id, districtGroup: household.districtGroup, status: 'active' }, { $set: { status: 'inactive', endedAt: now } }, ['status', 'endedAt']);
      if (withdrawn.matchedCount !== memberships.length) throw fail('退会対象の所属が変更されました。再申請してください。');
      await mutate(HouseholdMember, { association: associationId, household: household._id, ...(application.scope === 'household' ? {} : { user: { $in: users } }), endsAt: null }, { $set: { endsAt: now } }, ['endsAt']);
      await mutate(RoleAssignment, { association: associationId, user: { $in: users }, $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }, { $set: { endsAt: new Date(now.getTime() - 1) } }, ['endsAt']);
      await mutate(AnnualOfficer, { association: associationId, user: { $in: users }, fiscalYear: { $gte: year(now) }, cancelledAt: null }, { $set: { cancelledAt: now } }, ['cancelledAt']);
      await mutate(AnnualLeaderAssignment, { association: associationId, representative: { $in: users }, fiscalYear: { $gte: year(now) }, cancelledAt: null }, { $set: { cancelledAt: now } }, ['cancelledAt']);
      await mutate(Invitation, { association: associationId, household: household._id, status: 'pending', ...(application.scope === 'household' ? {} : { invitedBy: { $in: users } }) }, { $set: { status: 'cancelled', cancelledAt: now } }, ['status', 'cancelledAt']);
      if (application.scope === 'household') await mutate(JoinApplication, { association: associationId, household: household._id, status: { $in: ['pending', 'awaiting_household'] } }, { $set: { status: 'cancelled', cancelledAt: now } }, ['status', 'cancelledAt']);
      const group = await Group.findById(association.group).session(session).lean();
      if (!group) throw fail('町内会の共通グループがありません。');
      const sharedUsers = await User.find({ _id: { $in: users } }).select('_id groups defaultGroup').session(session).lean();
      groupUndo.push({ group: association.group, users: sharedUsers, members: users.filter(user => group.members.some(member => same(member, user))) });
      await Group.updateOne({ _id: association.group }, { $pull: { members: { $in: users } } }, options);
      await User.updateMany({ _id: { $in: users } }, { $pull: { groups: association.group } }, options);
      await User.updateMany({ _id: { $in: users }, defaultGroup: association.group }, { $unset: { defaultGroup: '' } }, options);
    }
    const completed = await WithdrawalApplication.updateOne({ _id: applicationId, status: 'processing' }, { $set: { status: approve ? 'approved' : 'rejected', decidedBy: actorId, decidedAt: now } }, options);
    if (completed.modifiedCount !== 1) throw fail('申請の状態が変更されています。');
    const [audit] = await AuditLog.create([{ association: associationId, actor: actorId, action: approve ? 'withdrawal.approved' : 'withdrawal.rejected', targetType: 'WithdrawalApplication', targetId: applicationId, before: { scope: application.scope, membershipIds: application.membershipIds, representative: household.representative }, after: { status: approve ? 'approved' : 'rejected', successor: application.successor } }], options);
    auditId = audit._id;
  }, async () => {
    for (const item of groupUndo) {
      await Group.updateOne({ _id: item.group }, { $addToSet: { members: { $each: item.members } } });
      for (const user of item.users) {
        if (user.groups?.some(group => same(group, item.group))) await User.updateOne({ _id: user._id }, { $addToSet: { groups: item.group } });
        if (same(user.defaultGroup, item.group)) await User.updateOne({ _id: user._id, defaultGroup: { $exists: false } }, { $set: { defaultGroup: item.group } });
      }
    }
    for (const { Model, before, fields } of journal.reverse()) for (const document of before) {
      const set = {}, unset = {};
      for (const field of fields) { if (document[field] === undefined) unset[field] = ''; else set[field] = document[field]; }
      await Model.updateOne({ _id: document._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    }
    if (auditId) await AuditLog.deleteOne({ _id: auditId });
  });
  await notify(application, approve ? 'withdrawal_approved' : 'withdrawal_rejected', notificationRecipients);
};

export const cancelWithdrawal = async ({ applicationId, actorId }) => {
  validIds(applicationId, actorId);
  const result = await WithdrawalApplication.updateOne({ _id: applicationId, requestedBy: actorId, status: { $in: ['pending', 'awaiting_household'] } }, { $set: { status: 'cancelled' } });
  if (result.modifiedCount !== 1) throw fail('取り消せる申請がありません。', 404);
};

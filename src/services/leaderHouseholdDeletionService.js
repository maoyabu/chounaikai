import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { Household, HouseholdMember, DistrictGroup } from '../models/organization.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { RoleAssignment } from '../models/role.js';
import { Invitation, JoinApplication } from '../models/workflow.js';
import { User } from '../models/user.js';
import { Group } from '../models/group.js';
import { AuditLog } from '../models/auditLog.js';
import { Notification } from '../models/notification.js';
import { runWithOptionalTransaction } from './associationService.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const fiscalYear = (date) => date.getMonth() < 3 ? date.getFullYear() - 1 : date.getFullYear();
const objectId = (value) => value?._id || value;
const scopedIds = (documents) => documents.map(document => document._id);
const uniqueIds = (values) => [...new Map(values.filter(Boolean).map(value => [String(value), value])).values()];

export const householdDeletionFingerprint = (details) => {
  const version = (document) => [String(document._id), document.updatedAt || null, document.status || null, document.endsAt || null, document.cancelledAt || null, document.user ? String(objectId(document.user)) : null];
  const versions = (documents) => documents.map(version).sort((a, b) => a[0].localeCompare(b[0]));
  return crypto.createHash('sha256').update(JSON.stringify({
    household: details.household,
    members: details.members,
    memberships: versions(details.memberships),
    invitations: versions(details.invitations),
    applications: versions(details.applications),
    roles: versions(details.roles), officers: versions(details.officers), leaders: versions(details.leaders)
  })).digest('hex');
};

export const loadLeaderHouseholdDeletion = async ({ associationId, householdId, actorId, now = new Date(), session = null }) => {
  if (![associationId, householdId, actorId].every(mongoose.isValidObjectId)) throw fail('町内会と世帯を確認してください。');
  const association = await NeighborhoodAssociation.findOne({ _id: associationId, status: 'active', deletedAt: { $exists: false } }).session(session).lean();
  if (!association) throw fail('町内会を確認できません。', 404);
  const actorMembership = await AssociationMembership.findOne({ association: associationId, user: actorId, status: 'active' }).session(session).lean();
  const districtIds = await AnnualLeaderAssignment.find({ association: associationId, representative: actorId, fiscalYear: fiscalYear(now), cancelledAt: null }).session(session).distinct('districtGroup');
  if (!actorMembership || !districtIds.length) throw fail('現在年度の担当班の班長だけが世帯を削除できます。', 403);
  const districts = await DistrictGroup.find({ _id: { $in: districtIds }, association: associationId, active: true }).session(session).lean();
  const household = await Household.findOne({ _id: householdId, association: associationId, districtGroup: { $in: scopedIds(districts) }, active: true }).populate('representative', 'displayname username').populate('districtGroup', 'name').session(session).lean();
  if (!household) throw fail('担当班に属する世帯を確認できません。削除済み、または所属班が変更されています。', 404);
  const members = await HouseholdMember.find({ association: associationId, household: householdId }).sort({ isRepresentative: -1, _id: 1 }).session(session).lean();
  const memberships = await AssociationMembership.find({ association: associationId, household: householdId }).session(session).lean();
  if (!memberships.some(membership => membership.status === 'active' && String(membership.districtGroup) === String(objectId(household.districtGroup)))) throw fail('班に所属する世帯を確認できません。', 404);
  // Only withdraw memberships actually attached to this household. A stale member
  // account reference must never revoke membership in a different household.
  const userIds = uniqueIds(memberships.map(membership => membership.user));
  const invitations = await Invitation.find({ association: associationId, household: householdId, status: { $in: ['pending', 'accepted'] } }).session(session).lean();
  const applications = await JoinApplication.find({ association: associationId, household: householdId, status: { $in: ['pending', 'awaiting_household'] } }).session(session).lean();
  const roles = await RoleAssignment.find({ association: associationId, user: { $in: userIds }, $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }).session(session).lean();
  const officers = await AnnualOfficer.find({ association: associationId, user: { $in: userIds }, fiscalYear: { $gte: fiscalYear(now) }, cancelledAt: null }).session(session).lean();
  const leaders = await AnnualLeaderAssignment.find({ association: associationId, $or: [{ household: householdId }, { representative: { $in: userIds } }], fiscalYear: { $gte: fiscalYear(now) }, cancelledAt: null }).session(session).lean();
  const details = { association, household, members, memberships, userIds, invitations, applications, roles, officers, leaders };
  return { ...details, fingerprint: householdDeletionFingerprint(details) };
};

const restoreFields = async (Model, documents, fields, filter) => {
  for (const document of documents) {
    const set = {}, unset = {};
    for (const field of fields) {
      if (document[field] === undefined) unset[field] = ''; else set[field] = document[field];
    }
    await Model.updateOne({ _id: document._id, ...filter }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  }
};

export const deleteLeaderHousehold = async ({ associationId, householdId, actor, expectedFingerprint, now = new Date() }) => {
  let details;
  const changed = {};
  const roleEndsAt = new Date(now.getTime() - 1);
  return runWithOptionalTransaction(async (session) => {
    const options = session ? { session } : {};
    details = await loadLeaderHouseholdDeletion({ associationId, householdId, actorId: actor._id, now, session });
    if (!expectedFingerprint || details.fingerprint !== expectedFingerprint) throw fail('確認画面の表示後に世帯情報が変更されています。確認画面を開き直してください。', 409);
    const group = await Group.findById(details.association.group).select('members').session(session).lean();
    if (!group) throw fail('町内会の共通グループを確認できません。', 409);
    const users = await User.find({ _id: { $in: details.userIds } }).select('_id groups defaultGroup').session(session).lean();
    changed.groupMembers = details.userIds.filter(userId => (group.members || []).some(memberId => String(memberId) === String(userId)));
    changed.userGroups = scopedIds(users.filter(user => (user.groups || []).some(groupId => String(groupId) === String(details.association.group))));
    changed.defaultGroups = scopedIds(users.filter(user => String(user.defaultGroup || '') === String(details.association.group)));
    const claim = await Household.updateOne({ _id: householdId, association: associationId, districtGroup: objectId(details.household.districtGroup), active: true, updatedAt: details.household.updatedAt }, { $set: { active: false, deletedAt: now, deletedBy: actor._id } }, options);
    if (claim.modifiedCount !== 1) throw fail('世帯情報が変更されたか、既に削除されています。', 409);
    changed.claimed = true;
    await AssociationMembership.updateMany({ _id: { $in: scopedIds(details.memberships) }, association: associationId, household: householdId, status: { $in: ['active', 'pending', 'withdrawal_pending'] } }, { $set: { status: 'inactive', endedAt: now } }, options);
    await RoleAssignment.updateMany({ _id: { $in: scopedIds(details.roles) }, association: associationId }, { $set: { endsAt: roleEndsAt } }, options);
    await AnnualOfficer.updateMany({ _id: { $in: scopedIds(details.officers) }, association: associationId, cancelledAt: null }, { $set: { cancelledAt: now } }, options);
    await AnnualLeaderAssignment.updateMany({ _id: { $in: scopedIds(details.leaders) }, association: associationId, cancelledAt: null }, { $set: { cancelledAt: now } }, options);
    await Invitation.updateMany({ _id: { $in: scopedIds(details.invitations) }, association: associationId, household: householdId, status: { $in: ['pending', 'accepted'] } }, { $set: { status: 'cancelled', cancelledAt: now } }, options);
    await JoinApplication.updateMany({ _id: { $in: scopedIds(details.applications) }, association: associationId, household: householdId, status: { $in: ['pending', 'awaiting_household'] } }, { $set: { status: 'cancelled', cancelledAt: now } }, options);
    // Preserve shared accounts and unrelated group memberships.
    await Group.updateOne({ _id: details.association.group }, { $pull: { members: { $in: details.userIds } } }, options);
    await User.updateMany({ _id: { $in: details.userIds } }, { $pull: { groups: details.association.group } }, options);
    await User.updateMany({ _id: { $in: changed.defaultGroups }, defaultGroup: details.association.group }, { $unset: { defaultGroup: '' } }, options);
    const recipients = uniqueIds(details.memberships.filter(membership => ['active', 'pending', 'withdrawal_pending'].includes(membership.status)).map(membership => membership.user));
    changed.notificationIds = [];
    for (const recipient of recipients) {
      const [notification] = await Notification.create([{ association: associationId, recipient, type: 'household_removed', title: '世帯が班の一覧から削除されました', body: '班長により世帯が削除され、町内会の利用が停止されました。アカウントは削除されていません。詳細は町内会管理者にご確認ください。', relatedType: 'Household', relatedId: details.household._id }], options);
      changed.notificationIds.push(notification._id);
    }
    const [audit] = await AuditLog.create([{ association: associationId, actor: actor._id, action: 'household.deleted_by_leader', targetType: 'Household', targetId: details.household._id,
      before: { active: true, districtGroup: objectId(details.household.districtGroup), membershipIds: scopedIds(details.memberships), roleIds: scopedIds(details.roles), officerIds: scopedIds(details.officers), leaderIds: scopedIds(details.leaders),
        memberships: details.memberships.map(membership => ({ _id: membership._id, user: membership.user, status: membership.status, endedAt: membership.endedAt })),
        roles: details.roles.map(role => ({ _id: role._id, user: role.user, endsAt: role.endsAt })),
        invitations: details.invitations.map(invitation => ({ _id: invitation._id, status: invitation.status })),
        applications: details.applications.map(application => ({ _id: application._id, status: application.status }))
      },
      after: { active: false, deletedAt: now, deletedBy: actor._id, retainedMemberCount: details.members.length, sharedAccountsPreserved: true }
    }], options);
    changed.auditId = audit._id;
    return { household: details.household, removedOwnMembership: details.userIds.some(userId => String(userId) === String(actor._id)) };
  }, async () => {
    if (!changed.claimed) return;
    // Standalone MongoDB: restore only the exact records changed by this removal.
    await restoreFields(AssociationMembership, details.memberships, ['status', 'endedAt'], { status: 'inactive', endedAt: now });
    await restoreFields(RoleAssignment, details.roles, ['endsAt'], { endsAt: roleEndsAt });
    await restoreFields(AnnualOfficer, details.officers, ['cancelledAt'], { cancelledAt: now });
    await restoreFields(AnnualLeaderAssignment, details.leaders, ['cancelledAt'], { cancelledAt: now });
    await restoreFields(Invitation, details.invitations, ['status', 'cancelledAt'], { status: 'cancelled', cancelledAt: now });
    await restoreFields(JoinApplication, details.applications, ['status', 'cancelledAt'], { status: 'cancelled', cancelledAt: now });
    if (changed.groupMembers.length) await Group.updateOne({ _id: details.association.group }, { $addToSet: { members: { $each: changed.groupMembers } } });
    if (changed.userGroups.length) await User.updateMany({ _id: { $in: changed.userGroups } }, { $addToSet: { groups: details.association.group } });
    if (changed.defaultGroups.length) await User.updateMany({ _id: { $in: changed.defaultGroups }, defaultGroup: { $exists: false } }, { $set: { defaultGroup: details.association.group } });
    if (changed.notificationIds?.length) await Notification.deleteMany({ _id: { $in: changed.notificationIds } });
    if (changed.auditId) await AuditLog.deleteOne({ _id: changed.auditId });
    await restoreFields(Household, [details.household], ['active', 'deletedAt', 'deletedBy'], { active: false, deletedAt: now, deletedBy: actor._id });
  });
};

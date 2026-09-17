import mongoose from 'mongoose';
import { Group } from '../models/group.js';
import { User } from '../models/user.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { RoleAssignment, RoleDefinition } from '../models/role.js';
import { AuditLog } from '../models/auditLog.js';
import { Announcement } from '../models/announcement.js';
import { Department, DistrictGroup, Household, HouseholdMember } from '../models/organization.js';
import { Invitation, JoinApplication, WithdrawalApplication } from '../models/workflow.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { Notification } from '../models/notification.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { QuestionThread } from '../models/questionThread.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { OfficerContactGroup } from '../models/officerContactGroup.js';
import { AssociationEvent } from '../models/associationEvent.js';

let transactionSupport;

const supportsTransactions = async () => {
  if (typeof transactionSupport === 'boolean') return transactionSupport;
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  transactionSupport = Boolean(hello.setName || hello.msg === 'isdbgrid');
  return transactionSupport;
};

export const runWithOptionalTransaction = async (work, compensate) => {
  if (!(await supportsTransactions())) {
    try { return await work(null); } catch (error) {
      try { await compensate?.(); } catch (rollbackError) { console.error('Compensating rollback failed', rollbackError); }
      throw error;
    }
  }
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally { await session.endSession(); }
};

const options = (session) => session ? { session } : {};
const cleanMeta = (meta) => ({ requestId: meta.requestId, ip: meta.ip });

export const requestAssociation = async ({ actor, input, requestMeta = {} }) => {
  const normalizedName = String(input.name || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ja');
  const candidates = await NeighborhoodAssociation.find({ status: { $in: ['pending', 'active'] }, deletedAt: { $exists: false } }).select('name').lean();
  if (candidates.some((item) => String(item.name || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ja') === normalizedName)) {
    throw Object.assign(new Error('同じ名前の町内会が申請済み、または公開中です。町内会一覧を確認してください。'), { status: 409 });
  }
  const association = await NeighborhoodAssociation.create({
    publicSlug: input.publicSlug, name: input.name, requestedGroupName: input.groupName,
    status: 'pending', requestedBy: actor._id, address: input.address,
    serviceArea: input.serviceArea, contact: input.contact, introduction: input.introduction
  });
  try {
    await AuditLog.create({
      association: association._id, actor: actor._id, action: 'association.requested',
      targetType: 'NeighborhoodAssociation', targetId: association._id,
      after: { name: association.name, status: association.status }, ...cleanMeta(requestMeta)
    });
  } catch (error) {
    await NeighborhoodAssociation.deleteOne({ _id: association._id, status: 'pending' });
    throw error;
  }
  return { association };
};

// Compatibility for existing imports: creation now means an application.
export const createAssociation = requestAssociation;

export const approveAssociation = async ({ association, actor, requestMeta = {} }) => {
  const created = {};
  return runWithOptionalTransaction(async (session) => {
    const applicant = await User.findById(association.requestedBy).select('isAdmin').session(session);
    if (!applicant || applicant.isAdmin) throw Object.assign(new Error('applicant_must_be_non_system_admin'), { status: 409 });
    const approvedAt = new Date();
    const claimed = await NeighborhoodAssociation.updateOne(
      { _id: association._id, status: 'pending', deletedAt: { $exists: false } },
      { $set: { status: 'active', approvedBy: actor._id, approvedAt } }, options(session)
    );
    if (claimed.modifiedCount !== 1) throw Object.assign(new Error('association_not_pending'), { status: 409 });
    const [group] = await Group.create([{ group_name: association.requestedGroupName, createdBy: association.requestedBy, members: [association.requestedBy], invitedUsers: [] }], options(session));
    created.group = group._id;
    await NeighborhoodAssociation.updateOne({ _id: association._id }, { $set: { group: group._id } }, options(session));
    const [membership] = await AssociationMembership.create([{ association: association._id, user: association.requestedBy, status: 'active', startedAt: approvedAt, joinedBy: 'application', approvedBy: actor._id }], options(session));
    created.membership = membership._id;
    const [role] = await RoleDefinition.create([{ association: association._id, name: '町内会管理者', sortOrder: 0, permissions: ['association.manage', 'organization.manage', 'role.manage', 'announcement.manage', 'audit.read'] }], options(session));
    created.role = role._id;
    const [assignment] = await RoleAssignment.create([{ association: association._id, user: association.requestedBy, role: role._id, startsAt: approvedAt }], options(session));
    created.assignment = assignment._id;
    await User.updateOne({ _id: association.requestedBy }, { $addToSet: { groups: group._id } }, options(session));
    const [audit] = await AuditLog.create([{ association: association._id, actor: actor._id, action: 'association.approved', targetType: 'NeighborhoodAssociation', targetId: association._id, before: { status: 'pending' }, after: { status: 'active', approvedAt }, ...cleanMeta(requestMeta) }], options(session));
    created.audit = audit._id;
    return { association: await NeighborhoodAssociation.findById(association._id).session(session), group, membership };
  }, async () => {
    if (created.group) await User.updateOne({ _id: association.requestedBy }, { $pull: { groups: created.group } });
    if (created.audit) await AuditLog.deleteOne({ _id: created.audit });
    if (created.assignment) await RoleAssignment.deleteOne({ _id: created.assignment });
    if (created.role) await RoleDefinition.deleteOne({ _id: created.role });
    if (created.membership) await AssociationMembership.deleteOne({ _id: created.membership });
    if (created.group) await Group.deleteOne({ _id: created.group, createdBy: association.requestedBy });
    await NeighborhoodAssociation.updateOne({ _id: association._id, approvedBy: actor._id }, { $set: { status: 'pending' }, $unset: { group: '', approvedBy: '', approvedAt: '' } });
  });
};

export const hideAssociation = async ({ association, actor, requestMeta = {} }) => {
  if (association.deletedAt) throw Object.assign(new Error('association_already_hidden'), { status: 409 });
  const deletedAt = new Date();
  const result = await NeighborhoodAssociation.updateOne(
    { _id: association._id, deletedAt: { $exists: false } },
    { $set: { status: 'inactive', statusBeforeDeletion: association.status, deletedAt, deletedBy: actor._id } }
  );
  if (result.modifiedCount !== 1) throw Object.assign(new Error('association_already_hidden'), { status: 409 });
  await AuditLog.create({ association: association._id, actor: actor._id, action: 'association.hidden', targetType: 'NeighborhoodAssociation', targetId: association._id, before: { status: association.status }, after: { status: 'inactive', deletedAt }, ...cleanMeta(requestMeta) });
};

export const restoreAssociation = async ({ association, actor, requestMeta = {} }) => {
  if (!association.deletedAt) throw Object.assign(new Error('association_not_hidden'), { status: 409 });
  // Older hidden records do not have statusBeforeDeletion. A group means they
  // had already been approved; otherwise they return to the approval queue.
  const restoredStatus = association.statusBeforeDeletion || (association.group ? 'active' : 'pending');
  const result = await NeighborhoodAssociation.updateOne(
    { _id: association._id, deletedAt: { $exists: true } },
    { $set: { status: restoredStatus }, $unset: { deletedAt: '', deletedBy: '', statusBeforeDeletion: '' } }
  );
  if (result.modifiedCount !== 1) throw Object.assign(new Error('association_not_hidden'), { status: 409 });
  await AuditLog.create({
    association: association._id, actor: actor._id, action: 'association.restored',
    targetType: 'NeighborhoodAssociation', targetId: association._id,
    before: { status: association.status, deletedAt: association.deletedAt },
    after: { status: restoredStatus }, ...cleanMeta(requestMeta)
  });
};

export const permanentlyDeleteAssociation = async ({ association }) => {
  const associationId = association._id;
  const groupId = association.group;
  const membershipUsers = await AssociationMembership.find({ association: associationId }).distinct('user');
  await Promise.all([
    Announcement.deleteMany({ association: associationId }), Department.deleteMany({ association: associationId }),
    DistrictGroup.deleteMany({ association: associationId }), HouseholdMember.deleteMany({ association: associationId }),
    Household.deleteMany({ association: associationId }), JoinApplication.deleteMany({ association: associationId }),
    Invitation.deleteMany({ association: associationId }), WithdrawalApplication.deleteMany({ association: associationId }),
    RoleAssignment.deleteMany({ association: associationId }), RoleDefinition.deleteMany({ association: associationId }),
    AssociationMembership.deleteMany({ association: associationId }), AnnualLeaderAssignment.deleteMany({ association: associationId }),
    Notification.deleteMany({ association: associationId }), AnnualOfficer.deleteMany({ association: associationId }),
    QuestionThread.deleteMany({ association: associationId }), OfficerAnnouncement.deleteMany({ association: associationId }),
    OfficerAnnouncementReceipt.deleteMany({ association: associationId }),
    OfficerContactGroup.deleteMany({ association: associationId }), AssociationEvent.deleteMany({ association: associationId }),
    AuditLog.deleteMany({ association: associationId })
  ]);
  if (groupId) {
    await User.updateMany({ _id: { $in: membershipUsers } }, { $pull: { groups: groupId } });
    await User.updateMany({ defaultGroup: groupId }, { $unset: { defaultGroup: '' } });
    await Group.deleteOne({ _id: groupId });
  }
  await NeighborhoodAssociation.deleteOne({ _id: associationId });
};

import crypto from 'node:crypto';
import { Invitation, JoinApplication } from '../models/workflow.js';
import { Household, HouseholdMember, DistrictGroup } from '../models/organization.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { User } from '../models/user.js';
import { Group } from '../models/group.js';
import { Notification } from '../models/notification.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { AuditLog } from '../models/auditLog.js';
import { ResidentRegistration } from '../models/residentRegistration.js';
import { runWithOptionalTransaction } from './associationService.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const notifyDistrictLeaders = async ({ application, household, applicantName }) => {
  try {
    const now = new Date();
    const fiscalYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
    const leaders = await AnnualLeaderAssignment.find({ association: application.association, districtGroup: application.districtGroup, fiscalYear, cancelledAt: null }).select('representative').lean();
    for (const recipient of new Set(leaders.map(leader => String(leader.representative)))) {
      if (!await AssociationMembership.exists({ association: application.association, user: recipient, status: 'active' })) continue;
      await Notification.create({ association: application.association, recipient, type: 'join_application_received', title: `${household.displayName}の${applicantName}さんの参加申請`, body: '世帯主の確認は済んでいます。班長メニューの「参加申請」で、班・世帯への参加を承認してください。', relatedType: 'JoinApplication', relatedId: application._id });
    }
  } catch (error) { console.error('District-leader participation notification failed', error.message); }
};
const clearCompletedRegistration = async (userId) => {
  try { await ResidentRegistration.deleteOne({ user: userId }); }
  catch (error) { console.error('Completed resident onboarding cleanup failed', error.message); }
};
export const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
export const digestInvitationToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const createHouseholdInvitationToken = () => {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenDigest: digestInvitationToken(token), expiresAt: new Date(Date.now() + 7 * 86400000) };
};

export const parseResidentProfile = (body, user) => {
  const birthDateText = String(body.birthDate || '');
  const birthDate = new Date(`${birthDateText}T00:00:00.000Z`);
  const name = String(user.displayname || user.username || '').trim();
  const nameKana = String(body.representativeKana || body.nameKana || '').trim();
  const gender = String(body.gender || 'unspecified');
  if (!name || !nameKana || !/^\d{4}-\d{2}-\d{2}$/.test(birthDateText) || Number.isNaN(birthDate.getTime()) || birthDate.toISOString().slice(0, 10) !== birthDateText || !['male', 'female', 'other', 'unspecified'].includes(gender)) throw fail('氏名（よみ）、生年月日、性別を正しく入力してください。');
  return { name, nameKana, birthDate, gender, email: normalizeEmail(user.email), lineAccount: String(body.lineAccount || '').trim(), relationship: String(body.relationship || '').trim() };
};

export const loadHouseholdInvitation = async ({ token, invitationId, email } = {}) => {
  if (token && !/^[a-f0-9]{64}$/.test(String(token))) return null;
  if (!token && !invitationId) return null;
  const invitation = await Invitation.findOne({
    ...(token ? { tokenDigest: digestInvitationToken(token) } : { _id: invitationId }),
    household: { $exists: true }, householdMember: { $exists: true }, status: 'pending', expiresAt: { $gt: new Date() },
    ...(email ? { email: normalizeEmail(email) } : {})
  }).populate('association', 'name status deletedAt').populate('invitedBy', 'displayname username').lean();
  if (!invitation || invitation.association?.status !== 'active' || invitation.association.deletedAt) return null;
  const [household, member, membership] = await Promise.all([
    Household.findOne({ _id: invitation.household, association: invitation.association._id, representative: invitation.invitedBy?._id, active: true }).populate('districtGroup', 'name active').lean(),
    HouseholdMember.findOne({ _id: invitation.householdMember, household: invitation.household, isRepresentative: false, user: null }).lean(),
    AssociationMembership.exists({ association: invitation.association._id, user: invitation.invitedBy?._id, household: invitation.household, status: 'active' })
  ]);
  if (!household || !member || !membership || !household.districtGroup?.active) return null;
  return { ...invitation, household, member };
};

export const ensureCanApply = async (associationId, userId) => {
  const [membership, pending] = await Promise.all([
    AssociationMembership.exists({ user: userId, status: 'active' }),
    JoinApplication.exists({ applicant: userId, status: { $in: ['pending', 'awaiting_household'] } })
  ]);
  if (membership || pending) throw fail('参加中、または確認中の申請があります。先に申請状況を確認してください。', 409);
  const association = await NeighborhoodAssociation.findOne({ _id: associationId, status: 'active', deletedAt: { $exists: false } });
  if (!association) throw fail('参加先の町内会を確認できません。', 404);
  return association;
};

const blockedApplicationStatuses = async (associationId, userId) => {
  // An approved application is reusable only when its association membership
  // has actually ended; keep active residents and pending requests protected.
  const withdrawn = await AssociationMembership.exists({ association: associationId, user: userId, status: 'inactive' });
  return withdrawn ? ['pending', 'awaiting_household'] : ['pending', 'awaiting_household', 'approved'];
};

export const requestHouseholdLink = async ({ associationId, districtGroupId, user, headEmail, body }) => {
  await ensureCanApply(associationId, user._id);
  const email = normalizeEmail(headEmail);
  if (!/^\S+@\S+\.\S+$/.test(email) || email === normalizeEmail(user.email)) throw fail('同居している世帯主のメールアドレスを入力してください。');
  const residentProfile = parseResidentProfile(body, user);
  const head = await User.findOne({ email }).collation({ locale: 'en', strength: 2 }).select('_id');
  const household = head && await Household.findOne({ association: associationId, representative: head._id, districtGroup: districtGroupId, active: true });
  const headMembership = household && await AssociationMembership.exists({ association: associationId, user: head._id, household: household._id, status: 'active' });
  const district = household && await DistrictGroup.exists({ _id: districtGroupId, association: associationId, active: true });
  if (!household || !headMembership || !district) throw fail('指定した町内会・班で世帯を確認できません。世帯主のメールアドレスと参加先を確認してください。');
  await ResidentRegistration.findOneAndUpdate({ user: user._id }, { $set: { residentMode: 'general', householdHeadEmail: email }, $unset: { householdInvitation: '' } }, { upsert: true, setDefaultsOnInsert: true });
  const blockedStatuses = await blockedApplicationStatuses(associationId, user._id);
  const application = await JoinApplication.findOneAndUpdate({ association: associationId, applicant: user._id, status: { $nin: blockedStatuses } }, {
    $set: { household: household._id, districtGroup: household.districtGroup, source: 'household_link', status: 'awaiting_household', residentProfile, applicantNote: String(body.applicantNote || '').trim() },
    $unset: { decidedBy: '', decidedAt: '', rejectionReason: '', invitation: '', invitedBy: '', householdMember: '', householdConfirmedBy: '', householdConfirmedAt: '' }
  }, { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true });
  try {
    await Notification.create({ association: associationId, recipient: head._id, type: 'household_link_requested', title: '同居人から世帯への紐付け申請が届きました', body: `${residentProfile.name}さんが世帯への参加を申請しています。プロフィールの「世帯情報」から確認してください。`, relatedType: 'JoinApplication', relatedId: application._id });
  } catch (error) { console.error('Household-link notification creation failed', error.message); }
  return application;
};

export const acceptHouseholdInvitation = async ({ invitationId, user }) => {
  const invitation = await loadHouseholdInvitation({ invitationId, email: user.email });
  if (!invitation) throw fail('招待の期限切れ、受諾済み、または宛先が異なります。世帯主へ再招待を依頼してください。', 409);
  await ensureCanApply(invitation.association._id, user._id);
  const blockedStatuses = await blockedApplicationStatuses(invitation.association._id, user._id);
  let application;
  let memberLinked = false;
  let invitationClaimed = false;
  await runWithOptionalTransaction(async (session) => {
    const options = session ? { session } : {};
    const claimed = await Invitation.findOneAndUpdate({ _id: invitationId, status: 'pending', expiresAt: { $gt: new Date() }, email: normalizeEmail(user.email) }, { $set: { status: 'accepted', acceptedBy: user._id, acceptedAt: new Date() } }, { new: true, ...options });
    if (!claimed) throw fail('この招待は既に使用されています。', 409);
    invitationClaimed = true;
    const member = await HouseholdMember.findOneAndUpdate({ _id: invitation.member._id, household: invitation.household._id, user: null }, { $set: { user: user._id, name: user.displayname || user.username, email: normalizeEmail(user.email) } }, { new: true, ...options });
    if (!member) throw fail('世帯メンバーは既に別のアカウントと紐付いています。', 409);
    memberLinked = true;
    application = await JoinApplication.findOneAndUpdate({ association: invitation.association._id, applicant: user._id, status: { $nin: blockedStatuses } }, {
      $set: { household: invitation.household._id, householdMember: member._id, districtGroup: invitation.household.districtGroup._id, status: 'pending', source: 'household_invitation', invitation: invitation._id, invitedBy: invitation.invitedBy._id, householdConfirmedBy: invitation.invitedBy._id, householdConfirmedAt: new Date() },
      $unset: { decidedBy: '', decidedAt: '', rejectionReason: '', residentProfile: '' }
    }, { upsert: true, new: true, setDefaultsOnInsert: true, ...options });
  }, async () => {
    if (invitationClaimed) await Invitation.updateOne({ _id: invitationId, acceptedBy: user._id }, { $set: { status: 'pending' }, $unset: { acceptedBy: '', acceptedAt: '' } });
    if (memberLinked) await HouseholdMember.updateOne({ _id: invitation.member._id, user: user._id }, { $set: { name: invitation.member.name, email: invitation.member.email }, $unset: { user: '' } });
  });
  await clearCompletedRegistration(user._id);
  await notifyDistrictLeaders({ application, household: invitation.household, applicantName: user.displayname || user.username });
  return application;
};

export const confirmHouseholdLink = async ({ associationId, householdId, applicationId, userId, memberId, approve }) => {
  const household = await Household.findOne({ _id: householdId, association: associationId, representative: userId, active: true });
  const application = household && await JoinApplication.findOne({ _id: applicationId, household: householdId, association: associationId, source: 'household_link', status: 'awaiting_household' });
  if (!application) throw fail('確認できる世帯紐付け申請がありません。', 404);
  if (!await AssociationMembership.exists({ association: associationId, household: householdId, user: userId, status: 'active' })) throw fail('参加中の世帯主だけが確認できます。', 403);
  if (!approve) {
    await JoinApplication.updateOne({ _id: applicationId, status: 'awaiting_household' }, { $set: { status: 'rejected', rejectionReason: '世帯主が世帯への紐付けを承認しませんでした。', decidedBy: userId, decidedAt: new Date() } });
    await Notification.create({ association: associationId, recipient: application.applicant, type: 'join_application_rejected', title: '世帯への紐付け申請が承認されませんでした', body: '世帯主が世帯への紐付けを承認しませんでした。申請状況を確認してください。', relatedType: 'JoinApplication', relatedId: application._id });
    return;
  }
  const applicant = await User.findById(application.applicant).select('email displayname username');
  if (!applicant || await AssociationMembership.exists({ user: applicant._id, status: 'active' })) throw fail('申請者の状態が変わりました。町内会管理者へ確認してください。', 409);
  let member, previousMember, claimed = false;
  await runWithOptionalTransaction(async (session) => {
    const options = session ? { session } : {};
    const claim = await JoinApplication.findOneAndUpdate({ _id: applicationId, status: 'awaiting_household' }, { $set: { districtGroup: household.districtGroup, status: 'pending', householdConfirmedBy: userId, householdConfirmedAt: new Date() } }, { new: true, ...options });
    if (!claim) throw fail('この申請は既に確認されています。', 409);
    claimed = true;
    if (memberId) {
      previousMember = await HouseholdMember.findOne({ _id: memberId, household: householdId, association: associationId, isRepresentative: false, user: null }).session(session).lean();
      if (!previousMember) throw fail('未紐付けの世帯メンバーを選択してください。');
      member = await HouseholdMember.findOneAndUpdate({ _id: memberId, household: householdId, user: null }, { $set: { user: applicant._id, name: applicant.displayname || applicant.username, email: normalizeEmail(applicant.email) } }, { new: true, ...options });
      if (!member) throw fail('世帯メンバーの状態が変わりました。', 409);
    } else {
      previousMember = await HouseholdMember.findOne({ household: householdId, association: associationId, user: applicant._id, isRepresentative: false }).session(session).lean();
      member = await HouseholdMember.findOneAndUpdate({ household: householdId, association: associationId, user: applicant._id, isRepresentative: false }, { $setOnInsert: { ...application.toObject().residentProfile, name: applicant.displayname || applicant.username, email: normalizeEmail(applicant.email), startsAt: new Date() } }, { upsert: true, new: true, runValidators: true, ...options });
    }
    await JoinApplication.updateOne({ _id: applicationId, status: 'pending', householdConfirmedBy: userId }, { $set: { householdMember: member._id } }, options);
  }, async () => {
    if (!claimed) return;
    if (member && !previousMember) await HouseholdMember.deleteOne({ _id: member._id, user: applicant._id });
    else if (member && memberId) await HouseholdMember.updateOne({ _id: member._id, user: applicant._id }, { $set: { name: previousMember.name, email: previousMember.email }, $unset: { user: '' } });
    await JoinApplication.updateOne({ _id: applicationId, status: 'pending', householdConfirmedBy: userId }, { $set: { status: 'awaiting_household' }, $unset: { householdMember: '', householdConfirmedBy: '', householdConfirmedAt: '' } });
  });
  await notifyDistrictLeaders({ application: { ...application.toObject(), districtGroup: household.districtGroup }, household, applicantName: applicant.displayname || applicant.username });
};

// Both the current district leader and an association manager use this decision path.
export const decideJoinApplication = async ({ application, actor, approve, rejectionReason }) => {
  const household = await Household.findOne({ _id: application.household, association: application.association, active: true });
  const association = await NeighborhoodAssociation.findOne({ _id: application.association, status: 'active', deletedAt: { $exists: false } });
  const district = household && await DistrictGroup.findOne({ _id: household.districtGroup, association: application.association, active: true });
  if (!household || !association || !district || String(district._id) !== String(application.districtGroup._id || application.districtGroup)) throw fail('世帯の所属班が変更されています。申請先を確認してください。', 409);
  if ((!application.source || application.source === 'representative') && String(household.representative) !== String(application.applicant)) throw fail('申請者と世帯代表者が一致していません。', 409);
  if (approve && application.source !== 'representative' && application.source) {
    const member = await HouseholdMember.exists({ _id: application.householdMember, household: household._id, user: application.applicant, isRepresentative: false });
    if (!member || !application.householdConfirmedBy) throw fail('世帯主の確認が完了していません。', 409);
    if (!await AssociationMembership.exists({ association: application.association, household: household._id, user: household.representative, status: 'active' })) throw fail('世帯主は現在、町内会に参加していません。', 409);
  }
  if (approve && await AssociationMembership.exists({ user: application.applicant, status: 'active', association: { $ne: application.association } })) throw fail('申請者は別の町内会に参加しています。', 409);
  const reason = String(rejectionReason || '').trim();
  if (!approve && !reason) throw fail('拒否理由を入力してください。');
  const now = new Date();
  const changes = {};
  await runWithOptionalTransaction(async (session) => {
    const options = session ? { session } : {};
    const claimed = await JoinApplication.findOneAndUpdate({ _id: application._id, status: 'pending' }, { $set: { status: approve ? 'approved' : 'rejected', decidedBy: actor._id, decidedAt: now, ...(!approve ? { rejectionReason: reason } : {}) } }, { new: true, ...options });
    if (!claimed) throw fail('この申請は既に処理されています。', 409);
    changes.claimed = true;
    if (approve) {
      changes.previousMembership = await AssociationMembership.findOne({ association: application.association, user: application.applicant }).session(session).lean();
      const previousGroup = await Group.findById(association.group).select('members').session(session).lean();
      const previousUser = await User.findById(application.applicant).select('groups').session(session).lean();
      if (!previousGroup || !previousUser) throw fail('申請者または町内会の共通グループが見つかりません。', 409);
      const membership = await AssociationMembership.findOneAndUpdate({ association: application.association, user: application.applicant }, { $set: { status: 'pending', startedAt: now, household: household._id, districtGroup: district._id, residentVerifiedAt: now, joinedBy: application.source === 'household_invitation' ? 'invitation' : 'application', approvedBy: actor._id }, $unset: { endedAt: '' } }, { upsert: true, new: true, setDefaultsOnInsert: true, ...options });
      changes.membershipId = membership._id;
      changes.groupAdded = !(previousGroup.members || []).some(id => String(id) === String(application.applicant));
      await Group.updateOne({ _id: association.group }, { $addToSet: { members: application.applicant } }, options);
      changes.userGroupAdded = !(previousUser.groups || []).some(id => String(id) === String(association.group));
      await User.updateOne({ _id: application.applicant }, { $addToSet: { groups: association.group } }, options);
      if (application.householdMember && application.source !== 'representative') {
        const previousMember = await HouseholdMember.findOne({ _id: application.householdMember, household: household._id, user: application.applicant }).session(session).lean();
        if (!previousMember) throw fail('世帯メンバーの状態が変更されています。', 409);
        if (previousMember.endsAt) {
          changes.reactivatedMember = previousMember;
          const reactivated = await HouseholdMember.updateOne({ _id: previousMember._id, user: application.applicant, endsAt: previousMember.endsAt }, { $set: { startsAt: now }, $unset: { endsAt: '' } }, options);
          if (reactivated.modifiedCount !== 1) throw fail('世帯メンバーの状態が変更されています。', 409);
        }
      }
      await AssociationMembership.updateOne({ _id: membership._id }, { $set: { status: 'active' } }, options);
    } else if (application.householdMember && application.source !== 'representative') {
      changes.memberUnlinked = true;
      await HouseholdMember.updateOne({ _id: application.householdMember, household: household._id, user: application.applicant }, { $unset: { user: '' } }, options);
    }
    const [notification] = await Notification.create([{ association: application.association, recipient: application.applicant, type: approve ? 'join_application_approved' : 'join_application_rejected', title: approve ? '町内会・班への参加が承認されました' : '町内会・班への参加申請が拒否されました', body: approve ? `${district.name}への参加申請が承認されました。` : `${district.name}への申請が拒否されました。理由：${reason}`, relatedType: 'JoinApplication', relatedId: application._id }], options);
    changes.notificationId = notification._id;
    const [audit] = await AuditLog.create([{ association: application.association, actor: actor._id, action: approve ? 'join_application.approved' : 'join_application.rejected', targetType: 'JoinApplication', targetId: application._id, after: { status: claimed.status, source: application.source, household: household._id } }], options);
    changes.auditId = audit._id;
  }, async () => {
    if (!changes.claimed) return;
    if (changes.reactivatedMember) {
      const previous = changes.reactivatedMember;
      await HouseholdMember.updateOne({ _id: previous._id, user: application.applicant }, { $set: { endsAt: previous.endsAt, ...(previous.startsAt ? { startsAt: previous.startsAt } : {}) }, ...(!previous.startsAt ? { $unset: { startsAt: '' } } : {}) });
    }
    if (changes.membershipId) {
      if (!changes.previousMembership) await AssociationMembership.deleteOne({ _id: changes.membershipId, approvedBy: actor._id });
      else {
        const set = {}, unset = {};
        for (const field of ['status', 'startedAt', 'endedAt', 'household', 'districtGroup', 'residentVerifiedAt', 'joinedBy', 'approvedBy']) {
          if (changes.previousMembership[field] === undefined) unset[field] = ''; else set[field] = changes.previousMembership[field];
        }
        await AssociationMembership.updateOne({ _id: changes.membershipId, approvedBy: actor._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
      }
    }
    if (changes.groupAdded) await Group.updateOne({ _id: association.group }, { $pull: { members: application.applicant } });
    if (changes.userGroupAdded) await User.updateOne({ _id: application.applicant }, { $pull: { groups: association.group } });
    if (changes.memberUnlinked) await HouseholdMember.updateOne({ _id: application.householdMember, household: household._id, user: null }, { $set: { user: application.applicant } });
    if (changes.notificationId) await Notification.deleteOne({ _id: changes.notificationId });
    if (changes.auditId) await AuditLog.deleteOne({ _id: changes.auditId });
    await JoinApplication.updateOne({ _id: application._id, decidedBy: actor._id, status: approve ? 'approved' : 'rejected' }, { $set: { status: 'pending' }, $unset: { decidedAt: '', decidedBy: '', rejectionReason: '' } });
  });
  await clearCompletedRegistration(application.applicant);
};

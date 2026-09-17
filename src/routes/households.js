import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { DistrictGroup, Household, HouseholdMember } from '../models/organization.js';
import { JoinApplication, Invitation, WithdrawalApplication } from '../models/workflow.js';
import { ResidentRegistration } from '../models/residentRegistration.js';
import { ensureCanApply, requestHouseholdLink, confirmHouseholdLink, decideJoinApplication, parseResidentProfile } from '../services/householdParticipationService.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import crypto from 'node:crypto';
import { loadLeaderHouseholdDeletion, deleteLeaderHousehold } from '../services/leaderHouseholdDeletionService.js';
import { loadJoinFormValues } from '../services/joinFormValuesService.js';
import { removeLinkedHouseholdMember } from '../services/householdMemberRemovalService.js';

export const householdsRouter = express.Router();
householdsRouter.use(requireLogin);

const currentFiscalYear = (date = new Date()) => date.getMonth() < 3 ? date.getFullYear() - 1 : date.getFullYear();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const validId = (value) => mongoose.isValidObjectId(value);

const loadOwnedHousehold = (associationId, householdId, userId) => Household.findOne({ _id: householdId, association: associationId, representative: userId, active: true });

householdsRouter.post('/:associationId/household', verifyCsrfToken, async (req, res, next) => {
  try {
    if (!validId(req.params.associationId) || !validId(req.body.districtGroupId)) throw fail('町内会と班を確認してください。');
    const [membership, districtGroup] = await Promise.all([
      AssociationMembership.findOne({ association: req.params.associationId, user: req.user._id, status: 'active' }),
      DistrictGroup.findOne({ _id: req.body.districtGroupId, association: req.params.associationId, active: true })
    ]);
    if (!membership || !districtGroup) throw fail('参加中の町内会と班を確認できません。', 403);
    if (membership.household) throw fail('既に世帯に所属しています。新しい世帯は登録できません。', 409);
    if (await Household.exists({ association: req.params.associationId, representative: req.user._id, active: true })) throw fail('この町内会の世帯情報は既に登録されています。', 409);
    const postalCode = String(req.body.postalCode || '').trim(), street = String(req.body.street || '').trim();
    const name = String(req.user.displayname || req.user.username || '').trim(), nameKana = String(req.body.nameKana || '').trim();
    const birthDateText = String(req.body.birthDate || ''), birthDate = new Date(`${birthDateText}T00:00:00.000Z`);
    const gender = String(req.body.gender || 'unspecified'), email = String(req.body.email || '').trim().toLowerCase();
    if (!postalCode || !street || !name || !nameKana || !/^\d{4}-\d{2}-\d{2}$/.test(birthDateText) || Number.isNaN(birthDate.getTime()) || birthDate.toISOString().slice(0, 10) !== birthDateText || !['male', 'female', 'other', 'unspecified'].includes(gender) || (email && !/^\S+@\S+\.\S+$/.test(email))) throw fail('世帯と世帯代表者の情報を正しく入力してください。');
    const household = await Household.create({ association: req.params.associationId, displayName: `${name}世帯`, districtGroup: districtGroup._id, representative: req.user._id, address: { postalCode, street, building: String(req.body.building || '').trim() }, phone: String(req.body.phone || '').trim() });
    try {
      await HouseholdMember.create({ association: req.params.associationId, household: household._id, user: req.user._id, name, nameKana, birthDate, gender, email, lineAccount: String(req.body.lineAccount || '').trim(), isRepresentative: true, relationship: '世帯代表者', startsAt: new Date() });
      await AssociationMembership.updateOne({ _id: membership._id }, { $set: { household: household._id, districtGroup: districtGroup._id, residentVerifiedAt: membership.residentVerifiedAt || new Date() } });
    } catch (error) {
      await HouseholdMember.deleteMany({ household: household._id });
      await household.deleteOne();
      throw error;
    }
    req.session.notice = '世帯情報を登録しました。';
    return res.redirect(`/profile?tab=household#household-${household._id}`);
  } catch (error) { return next(error); }
});

householdsRouter.get('/:associationId/join', async (req, res, next) => {
  try {
    if (!validId(req.params.associationId)) throw fail('申請できません。', 403);
    const [association, membership, existingApplication, districtGroups] = await Promise.all([
      NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean(),
      AssociationMembership.findOne({ association: req.params.associationId, user: req.user._id, status: 'active' }),
      JoinApplication.findOne({ applicant: req.user._id, status: { $in: ['pending', 'awaiting_household'] } }),
      DistrictGroup.find({ association: req.params.associationId, active: true }).sort({ sortOrder: 1, name: 1 }).lean()
    ]);
    if (!association || membership) throw fail('この町内会には参加申請できません。', 409);
    if (existingApplication) return res.redirect(`/associations/${existingApplication.association}/participation`);
    const values = await loadJoinFormValues({ associationId: association._id, user: req.user });
    return res.render('household-application', { title: `${association.name} 参加申請`, association, districtGroups, values });
  } catch (error) { return next(error); }
});

householdsRouter.post('/:associationId/join', verifyCsrfToken, async (req, res, next) => {
  try {
    if (!validId(req.params.associationId) || !validId(req.body.districtGroupId)) throw fail('申請内容を確認してください。');
    const mode = String(req.body.residentMode || 'representative');
    if (!['representative', 'general'].includes(mode)) throw fail('登録方法を選択してください。');
    if (mode === 'general') {
      const application = await requestHouseholdLink({ associationId: req.params.associationId, districtGroupId: req.body.districtGroupId, user: req.user, headEmail: req.body.householdHeadEmail, body: req.body });
      req.session.notice = '世帯への参加を申請しました。世帯主の確認後、班長または町内会管理者の承認を受けます。';
      return res.redirect(`/associations/${application.association}/participation`);
    }
    await ensureCanApply(req.params.associationId, req.user._id);
    const residentProfile = parseResidentProfile(req.body, req.user);
    const [association, districtGroup, membership] = await Promise.all([
      NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }),
      DistrictGroup.findOne({ _id: req.body.districtGroupId, association: req.params.associationId, active: true }),
      AssociationMembership.findOne({ user: req.user._id, status: 'active' })
    ]);
    if (!association || !districtGroup || membership) throw fail('申請先を確認できません。', 409);
    const postalCode = String(req.body.postalCode || '').trim();
    const street = String(req.body.street || '').trim();
    const representativeName = String(req.user.displayname || req.user.username || '').trim();
    const representativeKana = String(req.body.representativeKana || '').trim();
    const birthDate = residentProfile.birthDate;
    const gender = String(req.body.gender || 'unspecified');
    if (!postalCode || !street || !representativeName || !representativeKana || Number.isNaN(birthDate.getTime()) || !['male', 'female', 'other', 'unspecified'].includes(gender)) throw fail('世帯と代表者の必須情報を入力してください。');
    let household = await Household.findOne({ association: association._id, representative: req.user._id });
    if (!household) household = await Household.create({ association: association._id, displayName: `${representativeName}世帯`, districtGroup: districtGroup._id, representative: req.user._id, address: { postalCode, street, building: String(req.body.building || '').trim() }, phone: String(req.body.phone || '').trim() });
    else { household.districtGroup = districtGroup._id; household.address = { postalCode, street, building: String(req.body.building || '').trim() }; household.phone = String(req.body.phone || '').trim(); household.active = true; await household.save(); }
    await HouseholdMember.findOneAndUpdate(
      { association: association._id, household: household._id, user: req.user._id },
      { $set: { name: representativeName, nameKana: representativeKana, birthDate, gender, email: String(req.body.email || req.user.email || '').trim(), lineAccount: String(req.body.lineAccount || '').trim(), isRepresentative: true, relationship: '世帯代表者', startsAt: new Date() }, $unset: { endsAt: '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await JoinApplication.findOneAndUpdate(
      { association: association._id, applicant: req.user._id },
      { $set: { districtGroup: districtGroup._id, household: household._id, status: 'pending', source: 'representative', applicantNote: String(req.body.applicantNote || '').trim() }, $unset: { decidedBy: '', decidedAt: '', rejectionReason: '', invitation: '', invitedBy: '', householdMember: '', residentProfile: '', householdConfirmedBy: '', householdConfirmedAt: '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    req.session.notice = `「${association.name}・${districtGroup.name}」への参加を申請しました。`;
    await ResidentRegistration.deleteOne({ user: req.user._id });
    return res.redirect(`/associations/${association._id}/participation`);
  } catch (error) { return next(error); }
});

householdsRouter.get('/:associationId/participation', async (req, res, next) => {
  try {
    if (!validId(req.params.associationId)) throw fail('参加先を確認してください。');
    const application = await JoinApplication.findOne({ association: req.params.associationId, applicant: req.user._id }).populate('association', 'name').populate('districtGroup', 'name').lean();
    if (!application) throw fail('参加申請がありません。', 404);
    return res.render('participation-status', { title: '参加申請の状況', application });
  } catch (error) { return next(error); }
});

for (const decision of ['confirm', 'reject']) householdsRouter.post('/:associationId/household/:householdId/applications/:applicationId/' + decision, verifyCsrfToken, async (req, res, next) => {
  try {
    if (![req.params.associationId, req.params.householdId, req.params.applicationId].every(validId) || (req.body.memberId && !validId(req.body.memberId))) throw fail('世帯紐付け申請を確認してください。');
    await confirmHouseholdLink({ associationId: req.params.associationId, householdId: req.params.householdId, applicationId: req.params.applicationId, userId: req.user._id, memberId: req.body.memberId, approve: decision === 'confirm' });
    req.session.notice = decision === 'confirm' ? '世帯への紐付けを確認しました。班長・町内会管理者の承認待ちになります。' : '世帯への紐付けを拒否しました。';
    return res.redirect(`/profile?tab=household#household-${req.params.householdId}`);
  } catch (error) { return next(error); }
});

householdsRouter.get('/:associationId/household', async (req, res, next) => {
  try {
    const household = await Household.findOne({ association: req.params.associationId, representative: req.user._id }).populate('association', 'name status').populate('districtGroup', 'name').lean();
    if (!household) return res.status(404).render('error', { title: '世帯が見つかりません', message: '先に町内会への参加申請を行ってください。' });
    return res.redirect(`/profile?tab=household&association=${household.association._id}#household-${household._id}`);
  } catch (error) { return next(error); }
});

householdsRouter.post('/:associationId/household/:householdId/update', verifyCsrfToken, async (req, res, next) => {
  try {
    const household = await loadOwnedHousehold(req.params.associationId, req.params.householdId, req.user._id);
    if (!household) throw fail('世帯を確認できません。', 404);
    const postalCode = String(req.body.postalCode || '').trim(), street = String(req.body.street || '').trim();
    if (!postalCode || !street) throw fail('郵便番号と住所を入力してください。');
    household.address = { postalCode, street, building: String(req.body.building || '').trim() }; household.phone = String(req.body.phone || '').trim(); await household.save();
    req.session.notice = '世帯情報を更新しました。'; return res.redirect(`/profile?tab=household#household-${household._id}`);
  } catch (error) { return next(error); }
});

householdsRouter.post('/:associationId/household/:householdId/members', verifyCsrfToken, async (req, res, next) => {
  try {
    const household = await loadOwnedHousehold(req.params.associationId, req.params.householdId, req.user._id);
    if (!household) throw fail('世帯を確認できません。', 404);
    const birthDate = new Date(req.body.birthDate), name = String(req.body.name || '').trim(), nameKana = String(req.body.nameKana || '').trim(), gender = String(req.body.gender || 'unspecified');
    if (!name || !nameKana || Number.isNaN(birthDate.getTime()) || !['male', 'female', 'other', 'unspecified'].includes(gender)) throw fail('世帯メンバーの必須情報を入力してください。');
    await HouseholdMember.create({ association: req.params.associationId, household: household._id, name, nameKana, birthDate, gender, email: String(req.body.email || '').trim(), lineAccount: String(req.body.lineAccount || '').trim(), relationship: String(req.body.relationship || '').trim(), startsAt: new Date() });
    req.session.notice = '世帯メンバーを登録しました。'; return res.redirect(`/profile?tab=household#household-${household._id}`);
  } catch (error) { return next(error); }
});

householdsRouter.post('/:associationId/household/:householdId/members/:memberId/update', verifyCsrfToken, async (req, res, next) => {
  try {
    const household = await loadOwnedHousehold(req.params.associationId, req.params.householdId, req.user._id);
    const member = household && await HouseholdMember.findOne({ _id: req.params.memberId, household: household._id });
    if (!member) throw fail('世帯メンバーを確認できません。', 404);
    if (member.user && String(member.user) !== String(req.user._id)) throw fail('アカウントと紐付いたメンバーの本人情報は本人が変更してください。', 403);
    const birthDate = new Date(req.body.birthDate), name = member.isRepresentative ? String(req.user.displayname || req.user.username || '').trim() : String(req.body.name || '').trim(), nameKana = String(req.body.nameKana || '').trim(), gender = String(req.body.gender || 'unspecified');
    if (!name || !nameKana || Number.isNaN(birthDate.getTime()) || !['male', 'female', 'other', 'unspecified'].includes(gender)) throw fail('必須情報を入力してください。');
    Object.assign(member, { name, nameKana, birthDate, gender, email: String(req.body.email || '').trim(), lineAccount: String(req.body.lineAccount || '').trim(), relationship: member.isRepresentative ? '世帯代表者' : String(req.body.relationship || '').trim() }); await member.save();
    req.session.notice = '世帯メンバーを更新しました。'; return res.redirect(`/profile?tab=household#household-${household._id}`);
  } catch (error) { return next(error); }
});

householdsRouter.post('/:associationId/household/:householdId/members/:memberId/delete', verifyCsrfToken, async (req, res, next) => {
  try {
    const household = await loadOwnedHousehold(req.params.associationId, req.params.householdId, req.user._id);
    const member = household && await HouseholdMember.findOne({ _id: req.params.memberId, association: req.params.associationId, household: household._id, endsAt: null });
    if (!member) throw fail('世帯メンバーを確認できません。', 404);
    if (member.isRepresentative) throw fail('世帯代表者は削除できません。', 409);
    if (member.user) {
      const result = await removeLinkedHouseholdMember({ associationId: req.params.associationId, householdId: household._id, memberId: member._id, actorId: req.user._id });
      req.session.notice = result.accountExists
        ? 'アカウント紐付け済みメンバーを世帯から削除し、町内会への参加を終了しました。共通アカウントは残ります。'
        : '存在しないアカウントへの参照を整理し、世帯メンバーを削除しました。';
      return res.redirect(`/profile?tab=household#household-${household._id}`);
    }
    await Invitation.updateMany({ householdMember: member._id, status: 'pending' }, { $set: { status: 'cancelled' } });
    await member.deleteOne(); req.session.notice = '世帯メンバーを削除しました。'; return res.redirect(`/profile?tab=household#household-${household._id}`);
  } catch (error) { return next(error); }
});

householdsRouter.post('/:associationId/household/:householdId/members/:memberId/self-update', verifyCsrfToken, async (req, res, next) => {
  try {
    if (![req.params.associationId, req.params.householdId, req.params.memberId].every(validId)) throw fail('本人の世帯メンバー情報を確認してください。');
    const membership = await AssociationMembership.exists({ association: req.params.associationId, household: req.params.householdId, user: req.user._id, status: 'active' });
    const nameKana = String(req.body.nameKana || '').trim();
    if (!membership || !nameKana) throw fail('本人の世帯メンバー情報を確認してください。', 403);
    const member = await HouseholdMember.findOneAndUpdate({ _id: req.params.memberId, association: req.params.associationId, household: req.params.householdId, user: req.user._id, isRepresentative: false }, { $set: { nameKana, lineAccount: String(req.body.lineAccount || '').trim(), relationship: String(req.body.relationship || '').trim() } }, { new: true });
    if (!member) throw fail('本人の世帯メンバー情報を確認できません。', 404);
    req.session.notice = '本人の世帯メンバー情報を更新しました。';
    return res.redirect(`/profile?tab=household#household-${req.params.householdId}`);
  } catch (error) { return next(error); }
});

const loadLeaderDistrictIds = async (associationId, userId) => AnnualLeaderAssignment.find({ association: associationId, representative: userId, fiscalYear: currentFiscalYear(), cancelledAt: null }).distinct('districtGroup');

householdsRouter.get('/:associationId/leader/households/:householdId/delete', async (req, res, next) => {
  try {
    const details = await loadLeaderHouseholdDeletion({ associationId: req.params.associationId, householdId: req.params.householdId, actorId: req.user._id });
    const confirmationToken = crypto.randomBytes(32).toString('hex');
    req.session.householdDeletionConfirmation = { associationId: req.params.associationId, householdId: req.params.householdId, fingerprint: details.fingerprint, token: confirmationToken, expiresAt: Date.now() + 10 * 60000 };
    res.set('Cache-Control', 'no-store');
    return res.render('leader-household-delete', { title: '世帯削除の確認', ...details, confirmationToken });
  } catch (error) { return next(error); }
});

householdsRouter.post('/:associationId/leader/households/:householdId/delete', verifyCsrfToken, async (req, res, next) => {
  try {
    const confirmation = req.session.householdDeletionConfirmation;
    const token = String(req.body.confirmationToken || '');
    if (req.body.confirmDeletion !== 'on' || !confirmation || confirmation.associationId !== req.params.associationId || confirmation.householdId !== req.params.householdId || confirmation.expiresAt <= Date.now() || !/^[a-f0-9]{64}$/.test(token) || token !== confirmation.token) throw fail('削除の確認画面を開き直し、内容を確認してから削除してください。', 400);
    const result = await deleteLeaderHousehold({ associationId: req.params.associationId, householdId: req.params.householdId, actor: req.user, expectedFingerprint: confirmation.fingerprint });
    delete req.session.householdDeletionConfirmation;
    req.session.notice = `「${result.household.displayName}」を班の一覧から削除しました。履歴と共通アカウントは保持しています。`;
    return res.redirect(result.removedOwnMembership ? '/dashboard' : `/associations/${req.params.associationId}/leader?tab=members`);
  } catch (error) { return next(error); }
});

householdsRouter.get('/:associationId/leader', async (req, res, next) => {
  try {
    const districtIds = await loadLeaderDistrictIds(req.params.associationId, req.user._id);
    if (!districtIds.length) return res.status(403).render('error', { title: '権限がありません', message: '現在年度の班長だけが利用できます。' });
    const [association, districtGroups, applications, memberships] = await Promise.all([
      NeighborhoodAssociation.findById(req.params.associationId).lean(), DistrictGroup.find({ _id: { $in: districtIds } }).sort({ sortOrder: 1, name: 1 }).lean(),
      JoinApplication.find({ association: req.params.associationId, districtGroup: { $in: districtIds }, status: 'pending' }).populate('applicant', 'displayname username email').populate('invitedBy', 'displayname username email').populate('districtGroup', 'name').populate('household').sort({ createdAt: 1 }).lean(),
      AssociationMembership.find({ association: req.params.associationId, districtGroup: { $in: districtIds }, status: 'active', household: { $exists: true } }).select('household').lean()
    ]);
    const households = await Household.find({ _id: { $in: memberships.map((item) => item.household) }, association: req.params.associationId, active: true }).populate('representative', 'displayname username email').populate('districtGroup', 'name').sort('displayName').lean();
    const members = await HouseholdMember.find({ household: { $in: households.map((item) => item._id) }, endsAt: null }).sort({ birthDate: 1 }).lean();
    const withdrawalApplications = await WithdrawalApplication.find({ association: req.params.associationId, districtGroup: { $in: districtIds }, status: 'pending' }).populate('requestedBy', 'displayname username email').populate('household', 'displayName').populate('districtGroup', 'name').populate('successor', 'displayname username').sort({ createdAt: 1 }).lean();
    const membersByHousehold = Object.groupBy ? Object.groupBy(members, (item) => String(item.household)) : members.reduce((result, item) => ((result[String(item.household)] ||= []).push(item), result), {});
    return res.render('leader-dashboard', { title: '班長メニュー', association, districtGroups, applications, withdrawalApplications, households, membersByHousehold, fiscalYear: currentFiscalYear() });
  } catch (error) { return next(error); }
});

for (const decision of ['approve', 'reject']) householdsRouter.post('/:associationId/leader/applications/:applicationId/' + decision, verifyCsrfToken, async (req, res, next) => {
  try {
    const districtIds = await loadLeaderDistrictIds(req.params.associationId, req.user._id);
    const application = await JoinApplication.findOne({ _id: req.params.applicationId, association: req.params.associationId, districtGroup: { $in: districtIds }, status: 'pending' }).populate('districtGroup', 'name');
    if (!application) throw fail('自分の班の参加申請を確認できません。', 403);
    await decideJoinApplication({ application, actor: req.user, approve: decision === 'approve', rejectionReason: req.body.rejectionReason });
    req.session.notice = decision === 'approve' ? '参加申請を承認しました。' : '参加申請を拒否し、申請者へ通知しました。';
    return res.redirect(`/associations/${req.params.associationId}/leader`);
  } catch (error) { return next(error); }
});

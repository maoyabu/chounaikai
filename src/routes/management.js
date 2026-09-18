import express from 'express';
import mongoose from 'mongoose';
import { requireLogin, requirePermission } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { Department, DistrictGroup, Household, HouseholdMember } from '../models/organization.js';
import { RoleAssignment, RoleDefinition } from '../models/role.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { Notification } from '../models/notification.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { AuditLog } from '../models/auditLog.js';
import { AssociationGroupRequest } from '../models/associationGroup.js';
import { JoinApplication } from '../models/workflow.js';
import { decideJoinApplication } from '../services/householdParticipationService.js';
import { acceptSymbolImage, uploadPublicPhoto } from '../services/publicPageImageService.js';

export const managementRouter = express.Router();
managementRouter.use(requireLogin);

const validId = (value) => mongoose.isValidObjectId(value);
const meta = (req) => ({ requestId: req.get('x-request-id'), ip: req.ip });
const redirectBasic = (res, associationId) => res.redirect(`/associations/${associationId}/manage/basic`);
const redirectAnnual = (res, associationId, fiscalYear) => res.redirect(`/associations/${associationId}/manage/annual?year=${fiscalYear}`);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const audit = ({ association, actor, action, targetType, targetId, before, after, req }) => AuditLog.create({
  association, actor, action, targetType, targetId, before, after, ...meta(req)
});

managementRouter.get('/:associationId/manage', requirePermission('association.manage'), async (req, res, next) => {
  try {
    const now = new Date(), fiscalYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
    const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
    if (!association) return res.status(404).render('error', { title: '町内会が見つかりません', message: '公開中の町内会を確認できませんでした。' });
    const [pendingApplicationCount, pendingGroupRequestCount] = await Promise.all([
      JoinApplication.countDocuments({ association: association._id, status: 'pending' }),
      AssociationGroupRequest.countDocuments({ association: association._id, status: 'pending' })
    ]);
    return res.render('association-manage', { title: `${association.name} 管理`, association, fiscalYear, pendingApplicationCount, pendingGroupRequestCount });
  } catch (error) { return next(error); }
});

managementRouter.get('/:associationId/manage/managers', requirePermission('role.manage'), async (req, res, next) => {
  try {
    const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
    if (!association) throw fail('町内会を確認できません。', 404);
    const [members, managerAssignments] = await Promise.all([
      AssociationMembership.find({ association: association._id, status: 'active' }).populate('user', 'displayname username email avatar').populate('districtGroup', 'name').sort({ startedAt: 1 }).lean(),
      RoleAssignment.find({ association: association._id, startsAt: { $lte: new Date() }, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: new Date() } }] }).populate({ path: 'role', match: { active: true, permissions: 'association.manage' }, select: 'name permissions' }).lean()
    ]);
    const managerIds = new Set(managerAssignments.filter((item) => item.role).map((item) => String(item.user)));
    return res.render('association-managers', { title: `${association.name} 町内会管理者`, association, members: members.filter((item) => item.user).map((item) => ({ ...item, isAssociationManager: managerIds.has(String(item.user._id)) })) });
  } catch (error) { return next(error); }
});

managementRouter.get('/:associationId/manage/applications', requirePermission('association.manage'), async (req, res, next) => {
  try {
    const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
    if (!association) throw fail('町内会を確認できません。', 404);
    const applications = await JoinApplication.find({ association: association._id, status: { $in: ['pending', 'awaiting_household'] } }).populate('applicant', 'displayname username email').populate('invitedBy', 'displayname username email').populate('districtGroup', 'name').populate({ path: 'household', populate: { path: 'representative', select: 'displayname username email' } }).sort({ source: 1, createdAt: 1 }).lean();
    return res.render('association-applications', { title: `${association.name} 参加申請`, association, applications });
  } catch (error) { return next(error); }
});

for (const decision of ['approve', 'reject']) managementRouter.post('/:associationId/manage/applications/:applicationId/' + decision, requirePermission('association.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!validId(req.params.applicationId)) throw fail('参加申請を確認してください。');
    const application = await JoinApplication.findOne({ _id: req.params.applicationId, association: req.params.associationId, status: 'pending' });
    if (!application) throw fail('承認できる参加申請がありません。世帯主の確認待ちは承認できません。', 409);
    await decideJoinApplication({ application, actor: req.user, approve: decision === 'approve', rejectionReason: req.body.rejectionReason });
    req.session.notice = decision === 'approve' ? '参加申請を承認しました。' : '参加申請を拒否しました。';
    return res.redirect(`/associations/${req.params.associationId}/manage/applications`);
  } catch (error) { return next(error); }
});

managementRouter.get('/:associationId/manage/basic', requirePermission('association.manage'), async (req, res, next) => {
  try {
    const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
    if (!association) throw fail('町内会を確認できません。', 404);
    const [roles, departments, districtGroups] = await Promise.all([RoleDefinition.find({ association: association._id, name: { $ne: '町内会管理者' } }).sort({ sortOrder: 1, name: 1 }).lean(), Department.find({ association: association._id }).sort({ sortOrder: 1, name: 1 }).lean(), DistrictGroup.find({ association: association._id }).sort({ sortOrder: 1, name: 1 }).lean()]);
    return res.render('association-basic-settings', { title: `${association.name} 基本設定`, association, roles, departments, districtGroups });
  } catch (error) { return next(error); }
});

managementRouter.get('/:associationId/manage/annual', requirePermission('association.manage'), async (req, res, next) => {
  try {
    const now = new Date(), defaultYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
    const fiscalYear = Number(req.query.year || defaultYear);
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2200) throw fail('年度を確認してください。');
    const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
    if (!association) throw fail('町内会を確認できません。', 404);
    const [memberships, officers, roles, departments, districtGroups, leaderAssignments] = await Promise.all([
      AssociationMembership.find({ association: association._id, status: 'active', household: { $exists: true } }).populate('user', 'displayname username email avatar').populate('districtGroup', 'name').populate('household', 'displayName address representative').sort({ startedAt: 1 }).lean(),
      AnnualOfficer.find({ association: association._id, fiscalYear, cancelledAt: null }).populate('user', 'displayname username email').populate('role', 'name').populate('department', 'name').sort({ createdAt: 1 }).lean(),
      RoleDefinition.find({ association: association._id, active: true, name: { $ne: '町内会管理者' } }).sort({ sortOrder: 1, name: 1 }).lean(), Department.find({ association: association._id, active: true }).sort({ sortOrder: 1, name: 1 }).lean(), DistrictGroup.find({ association: association._id, active: true }).sort({ sortOrder: 1, name: 1 }).lean(),
      AnnualLeaderAssignment.find({ association: association._id, fiscalYear, cancelledAt: null }).populate('districtGroup', 'name').populate('representative', 'displayname username email').sort({ createdAt: 1 }).lean()
    ]);
    const candidateUserIds = memberships.map((membership) => membership.user?._id).filter(Boolean);
    const permanentAssignments = candidateUserIds.length ? await RoleAssignment.find({ association: association._id, user: { $in: candidateUserIds }, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] }).populate({ path: 'role', match: { active: true }, select: 'name permissions' }).populate('department', 'name').lean() : [];
    const representativeProfiles = await HouseholdMember.find({ association: association._id, household: { $in: memberships.map((item) => item.household?._id).filter(Boolean) }, isRepresentative: true }).lean();
    const profilesByHousehold = new Map(representativeProfiles.map((profile) => [String(profile.household), profile]));
    const officersByUser = new Map(officers.map((officer) => [String(officer.user?._id || officer.user), officer]));
    const leadersByUser = new Map(leaderAssignments.map((assignment) => [String(assignment.representative?._id || assignment.representative), assignment]));
    const permanentByUser = permanentAssignments.reduce((result, assignment) => ((result[String(assignment.user)] ||= []).push(assignment), result), {});
    const householdRepresentatives = memberships.filter((item) => item.user && item.household && String(item.household.representative) === String(item.user._id)).map((membership) => {
      const officer = officersByUser.get(String(membership.user._id)), leaderAssignment = leadersByUser.get(String(membership.user._id));
      const attributeTags = [];
      (permanentByUser[String(membership.user._id)] || []).forEach((assignment) => {
        if (assignment.role?.permissions?.includes('association.manage')) attributeTags.push('町内会管理者');
      });
      if (officer) { attributeTags.push('役員'); if (officer.role?.name) attributeTags.push(officer.role.name); if (officer.department?.name) attributeTags.push(officer.department.name); }
      if (leaderAssignment) attributeTags.push('班長');
      if (!attributeTags.length) attributeTags.push('メンバー');
      return { ...membership, residentProfile: profilesByHousehold.get(String(membership.household._id)), officer, leaderAssignment, attributeTags: [...new Set(attributeTags)] };
    });
    return res.render('association-annual-settings', { title: `${fiscalYear}年度設定`, association, fiscalYear, memberships, householdRepresentatives, officers, roles, departments, districtGroups, leaderAssignments });
  } catch (error) { return next(error); }
});

managementRouter.get('/:associationId/manage/officers', requirePermission('association.manage'), async (req, res, next) => {
  try {
    const now = new Date(), defaultYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
    const fiscalYear = Number(req.query.year || defaultYear);
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2200) throw fail('年度を確認してください。');
    const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
    if (!association) throw fail('町内会を確認できません。', 404);
    const [officers, roles, departments, districtGroups] = await Promise.all([
      AnnualOfficer.find({ association: association._id, fiscalYear, cancelledAt: null }).populate('user', 'displayname username email avatar').populate('role', 'name').populate('department', 'name').sort({ createdAt: 1 }).lean(),
      RoleDefinition.find({ association: association._id, active: true, name: { $ne: '町内会管理者' } }).sort({ sortOrder: 1, name: 1 }).lean(),
      Department.find({ association: association._id, active: true }).sort({ sortOrder: 1, name: 1 }).lean(),
      DistrictGroup.find({ association: association._id, active: true }).sort({ sortOrder: 1, name: 1 }).lean()
    ]);
    const memberships = await AssociationMembership.find({ association: association._id, user: { $in: officers.map((item) => item.user?._id).filter(Boolean) }, status: 'active' }).populate('household', 'displayName address').populate('districtGroup', 'name').lean();
    const membershipByUser = new Map(memberships.map((membership) => [String(membership.user), membership]));
    return res.render('association-officers', { title: `${fiscalYear}年度の役員一覧`, association, fiscalYear, roles, departments, districtGroups, officers: officers.map((officer) => ({ ...officer, membership: membershipByUser.get(String(officer.user?._id)) })) });
  } catch (error) { return next(error); }
});

managementRouter.get('/:associationId/manage/leaders', requirePermission('association.manage'), async (req, res, next) => {
  try {
    const now = new Date(), defaultYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
    const fiscalYear = Number(req.query.year || defaultYear);
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2200) throw fail('年度を確認してください。');
    const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
    if (!association) throw fail('町内会を確認できません。', 404);
    const leaders = await AnnualLeaderAssignment.find({ association: association._id, fiscalYear, cancelledAt: null })
      .populate('representative', 'displayname username email avatar')
      .populate('districtGroup', 'name')
      .populate('household', 'displayName address')
      .sort({ createdAt: 1 }).lean();
    const [memberships, districtGroups] = await Promise.all([
      AssociationMembership.find({ association: association._id, user: { $in: leaders.map((item) => item.representative?._id).filter(Boolean) }, status: 'active' }).populate('districtGroup', 'name').lean(),
      DistrictGroup.find({ association: association._id, active: true }).sort({ sortOrder: 1, name: 1 }).lean()
    ]);
    const membershipByUser = new Map(memberships.map((membership) => [String(membership.user), membership]));
    return res.render('association-leaders', { title: `${fiscalYear}年度の班長一覧`, association, fiscalYear, districtGroups, leaders: leaders.map((leader) => ({ ...leader, membership: membershipByUser.get(String(leader.representative?._id)) })) });
  } catch (error) { return next(error); }
});

managementRouter.get('/:associationId/manage/members', requirePermission('association.manage'), async (req, res, next) => {
  try {
    const now = new Date(), fiscalYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
    const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
    if (!association) throw fail('町内会を確認できません。', 404);
    const memberships = await AssociationMembership.find({ association: association._id, status: 'active' }).populate('user', 'displayname username email avatar').populate('districtGroup', 'name').populate('household', 'displayName address').sort({ startedAt: 1 }).lean();
    const userIds = memberships.map((item) => item.user?._id).filter(Boolean);
    const [officers, leaders, managerAssignments, districtGroups, roles, departments] = await Promise.all([
      AnnualOfficer.find({ association: association._id, fiscalYear, user: { $in: userIds }, cancelledAt: null }).populate('role', 'name').populate('department', 'name').lean(),
      AnnualLeaderAssignment.find({ association: association._id, fiscalYear, representative: { $in: userIds }, cancelledAt: null }).select('representative').lean(),
      RoleAssignment.find({ association: association._id, user: { $in: userIds }, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] }).populate({ path: 'role', match: { active: true, permissions: 'association.manage' }, select: 'name' }).lean(),
      DistrictGroup.find({ association: association._id, active: true }).sort({ sortOrder: 1, name: 1 }).lean(),
      RoleDefinition.find({ association: association._id, active: true, name: { $ne: '町内会管理者' } }).sort({ sortOrder: 1, name: 1 }).lean(),
      Department.find({ association: association._id, active: true }).sort({ sortOrder: 1, name: 1 }).lean()
    ]);
    const officerByUser = new Map(officers.map((item) => [String(item.user), item]));
    const leaderUserIds = new Set(leaders.map((item) => String(item.representative)));
    const managerUserIds = new Set(managerAssignments.filter((item) => item.role).map((item) => String(item.user)));
    const members = memberships.filter((item) => item.user).map((membership) => ({ ...membership, officer: officerByUser.get(String(membership.user._id)), isLeader: leaderUserIds.has(String(membership.user._id)), isAssociationManager: managerUserIds.has(String(membership.user._id)) }));
    return res.render('association-members', { title: `${association.name}住人一覧`, association, fiscalYear, members, districtGroups, roles, departments });
  } catch (error) { return next(error); }
});

managementRouter.get('/:associationId/manage/order', requirePermission('association.manage'), async (req, res, next) => {
  try {
    const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
    if (!association) throw fail('町内会を確認できません。', 404);
    const [roles, departments, districtGroups] = await Promise.all([
      RoleDefinition.find({ association: association._id, name: { $ne: '町内会管理者' } }).sort({ sortOrder: 1, name: 1 }).lean(),
      Department.find({ association: association._id }).sort({ sortOrder: 1, name: 1 }).lean(),
      DistrictGroup.find({ association: association._id }).sort({ sortOrder: 1, name: 1 }).lean()
    ]);
    return res.render('association-order-settings', { title: '並び順設定', association, roles, departments, districtGroups });
  } catch (error) { return next(error); }
});

managementRouter.post('/:associationId/manage/members/:userId/manager', requirePermission('role.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!validId(req.params.userId)) throw fail('住人を確認できません。');
    const membership = await AssociationMembership.findOne({ association: req.params.associationId, user: req.params.userId, status: 'active' });
    if (!membership) throw fail('参加中の住人を確認できません。', 404);
    const role = await RoleDefinition.findOne({ association: req.params.associationId, name: '町内会管理者', active: true, permissions: 'association.manage' });
    if (!role) throw fail('町内会管理者の役職を確認できません。', 409);
    const now = new Date();
    const filter = { association: req.params.associationId, role: role._id, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] };
    const existing = await RoleAssignment.findOne({ ...filter, user: req.params.userId });
    if (req.body.action === 'remove') {
      if (!existing) throw fail('この住人は町内会管理者ではありません。');
      if (await RoleAssignment.countDocuments(filter) <= 1) throw fail('町内会管理者は最低1人必要です。');
      await RoleAssignment.updateOne({ _id: existing._id }, { $set: { endsAt: new Date(now.getTime() - 1) } });
      req.session.notice = String(req.user._id) === String(req.params.userId) ? '町内会管理者から外れました。' : '町内会管理者を解除しました。';
    } else {
      if (!existing) await RoleAssignment.create({ association: req.params.associationId, user: req.params.userId, role: role._id, startsAt: now });
      req.session.notice = '町内会管理者を追加しました。';
    }
    return res.redirect(`/associations/${req.params.associationId}/manage/managers`);
  } catch (error) { return next(error); }
});

managementRouter.post('/:associationId/manage/name', requirePermission('association.manage'), acceptSymbolImage, verifyCsrfToken, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim(); if (!name) throw fail('町内会名を入力してください。');
    const association = await NeighborhoodAssociation.findById(req.params.associationId); if (!association) throw fail('町内会を確認できません。', 404);
    const before = { name: association.name }; association.name = name;
    association.serviceArea = String(req.body.serviceArea || '').trim(); association.introduction = String(req.body.introduction || '').trim();
    association.contact = { name: String(req.body.contactName || '').trim(), email: String(req.body.contactEmail || '').trim(), phone: String(req.body.contactPhone || '').trim() };
    association.socialLinks = { instagram: String(req.body.instagram || '').trim(), x: String(req.body.x || '').trim(), youtube: String(req.body.youtube || '').trim() };
    if (req.file) association.symbolImage = await uploadPublicPhoto(req.file, association._id, 'symbol');
    await association.save();
    await audit({ association: association._id, actor: req.user._id, action: 'association.name.updated', targetType: 'NeighborhoodAssociation', targetId: association._id, before, after: { name }, req });
    req.session.notice = '町内会名を更新しました。'; return redirectBasic(res, association._id);
  } catch (error) { return next(error); }
});

managementRouter.post('/:associationId/manage/symbol', requirePermission('association.manage'), acceptSymbolImage, verifyCsrfToken, async (req, res, next) => {
  try {
    const association = await NeighborhoodAssociation.findById(req.params.associationId);
    if (!association) throw fail('町内会を確認できません。', 404);
    if (req.file) association.symbolImage = await uploadPublicPhoto(req.file, association._id, 'symbol');
    await association.save(); req.session.notice = 'シンボル画像を更新しました。'; return res.redirect(`/associations/${association._id}/manage/basic`);
  } catch (error) { return next(error); }
});

const organizationRoutes = [
  { path: 'departments', Model: Department, label: '部', refs: () => [RoleAssignment, AnnualOfficer] },
  { path: 'district-groups', Model: DistrictGroup, label: '班', refs: () => [RoleAssignment, AssociationMembership, Household, AnnualLeaderAssignment] }
];

const orderTypes = {
  roles: { Model: RoleDefinition, label: '役職', extraFilter: { name: { $ne: '町内会管理者' } } },
  departments: { Model: Department, label: '部会', extraFilter: {} },
  'district-groups': { Model: DistrictGroup, label: '班', extraFilter: {} }
};

managementRouter.post('/:associationId/manage/order/:type', requirePermission('association.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const config = orderTypes[req.params.type];
    const order = Array.isArray(req.body.order) ? req.body.order.map(String) : [];
    if (!config || !order.length || order.some((id) => !validId(id)) || new Set(order).size !== order.length) throw fail('並び順データを確認してください。');
    const filter = { association: req.params.associationId, ...config.extraFilter };
    const existingIds = (await config.Model.find(filter).select('_id').lean()).map((item) => String(item._id));
    if (existingIds.length !== order.length || existingIds.some((id) => !order.includes(id))) throw fail('項目が更新されています。画面を再読み込みしてください。', 409);
    const updates = await Promise.all(order.map((id, sortOrder) => config.Model.updateOne(
      { _id: id, association: req.params.associationId, ...config.extraFilter },
      { $set: { sortOrder } },
      { runValidators: true }
    )));
    if (updates.some((result) => result.matchedCount !== 1)) throw fail('並び順を保存できませんでした。画面を再読み込みしてください。', 409);
    const savedOrder = (await config.Model.find(filter).sort({ sortOrder: 1, name: 1 }).select('_id').lean()).map((item) => String(item._id));
    if (savedOrder.some((id, index) => id !== order[index])) throw fail('保存後の並び順を確認できませんでした。', 409);
    await audit({ association: req.params.associationId, actor: req.user._id, action: `${req.params.type}.reordered`, targetType: config.Model.modelName, targetId: order[0], after: { order }, req });
    return res.json({ ok: true, order: savedOrder });
  } catch (error) { return next(error); }
});

managementRouter.post('/:associationId/manage/order/:type/move', requirePermission('association.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const config = orderTypes[req.params.type];
    const direction = req.body.direction;
    const itemId = req.body.itemId;
    if (!config || !validId(itemId) || !['up', 'down'].includes(direction)) throw fail('移動する行と方向を選択してください。');
    const filter = { association: req.params.associationId, ...config.extraFilter };
    const items = await config.Model.find(filter).sort({ sortOrder: 1, name: 1 });
    const index = items.findIndex((item) => String(item._id) === itemId);
    const targetIndex = index + (direction === 'up' ? -1 : 1);
    if (index < 0) throw fail(`${config.label}を確認できません。`, 404);
    if (targetIndex >= 0 && targetIndex < items.length) [items[index], items[targetIndex]] = [items[targetIndex], items[index]];
    if (items.length) await config.Model.bulkWrite(items.map((item, sortOrder) => ({ updateOne: { filter: { _id: item._id, association: req.params.associationId }, update: { $set: { sortOrder } } } })));
    await audit({ association: req.params.associationId, actor: req.user._id, action: `${req.params.type}.reordered`, targetType: config.Model.modelName, targetId: items[targetIndex]?._id || items[index]._id, after: { direction }, req });
    req.session.notice = `${config.label}の並び順を更新しました。`;
    return res.redirect(`/associations/${req.params.associationId}/manage/order#${req.params.type}`);
  } catch (error) { return next(error); }
});

for (const config of organizationRoutes) {
  managementRouter.post(`/:associationId/manage/${config.path}`, requirePermission('organization.manage'), verifyCsrfToken, async (req, res, next) => {
    try {
      const name = String(req.body.name || '').trim();
      if (!name) throw fail(`${config.label}名を入力してください。`);
      const last = await config.Model.findOne({ association: req.params.associationId }).sort({ sortOrder: -1 });
      const item = await config.Model.create({ association: req.params.associationId, name, sortOrder: (last?.sortOrder ?? -1) + 1 });
      await audit({ association: req.params.associationId, actor: req.user._id, action: `organization.${config.path}.created`, targetType: config.Model.modelName, targetId: item._id, after: { name }, req });
      req.session.notice = `${config.label}を作成しました。`;
      return redirectBasic(res, req.params.associationId);
    } catch (error) { return next(error); }
  });
  managementRouter.post(`/:associationId/manage/${config.path}/:itemId/update`, requirePermission('organization.manage'), verifyCsrfToken, async (req, res, next) => {
    try {
      if (!validId(req.params.itemId)) throw fail('invalid_id');
      const item = await config.Model.findOne({ _id: req.params.itemId, association: req.params.associationId });
      const name = String(req.body.name || '').trim();
      if (!item || !name) throw fail(`${config.label}を確認できません。`, 404);
      const before = { name: item.name }; item.name = name; await item.save();
      await audit({ association: req.params.associationId, actor: req.user._id, action: `organization.${config.path}.updated`, targetType: config.Model.modelName, targetId: item._id, before, after: { name }, req });
      req.session.notice = `${config.label}を更新しました。`; return redirectBasic(res, req.params.associationId);
    } catch (error) { return next(error); }
  });
  managementRouter.post(`/:associationId/manage/${config.path}/:itemId/delete`, requirePermission('organization.manage'), verifyCsrfToken, async (req, res, next) => {
    try {
      const item = await config.Model.findOne({ _id: req.params.itemId, association: req.params.associationId });
      if (!item) throw fail(`${config.label}を確認できません。`, 404);
      for (const RefModel of config.refs()) if (await RefModel.exists({ association: req.params.associationId, [config.path === 'departments' ? 'department' : config.path === 'district-groups' && RefModel === AnnualLeaderAssignment ? 'districtGroup' : config.path === 'district-groups' ? 'districtGroup' : '_id']: item._id })) throw fail(`使用中の${config.label}は削除できません。`, 409);
      await config.Model.deleteOne({ _id: item._id });
      await audit({ association: req.params.associationId, actor: req.user._id, action: `organization.${config.path}.deleted`, targetType: config.Model.modelName, targetId: item._id, before: { name: item.name }, req });
      req.session.notice = `${config.label}を削除しました。`; return redirectBasic(res, req.params.associationId);
    } catch (error) { return next(error); }
  });
}

const allowedPermissions = ['association.manage', 'organization.manage', 'role.manage', 'announcement.manage', 'audit.read'];
managementRouter.post('/:associationId/manage/roles', requirePermission('role.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw fail('役職名を入力してください。');
    const requested = Array.isArray(req.body.permissions) ? req.body.permissions : [req.body.permissions].filter(Boolean);
    const last = await RoleDefinition.findOne({ association: req.params.associationId }).sort({ sortOrder: -1 });
    const role = await RoleDefinition.create({ association: req.params.associationId, name, sortOrder: (last?.sortOrder ?? -1) + 1, permissions: requested.filter((item) => allowedPermissions.includes(item)) });
    await audit({ association: req.params.associationId, actor: req.user._id, action: 'role.created', targetType: 'RoleDefinition', targetId: role._id, after: { name, permissions: role.permissions }, req });
    req.session.notice = '役職を作成しました。'; return redirectBasic(res, req.params.associationId);
  } catch (error) { return next(error); }
});

managementRouter.post('/:associationId/manage/roles/:roleId/update', requirePermission('role.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const role = await RoleDefinition.findOne({ _id: req.params.roleId, association: req.params.associationId });
    if (!role) throw fail('役職を確認できません。', 404);
    const name = String(req.body.name || '').trim(); if (!name) throw fail('役職名を入力してください。');
    const requested = Array.isArray(req.body.permissions) ? req.body.permissions : [req.body.permissions].filter(Boolean);
    if (role.name === '町内会管理者') {
      req.session.notice = '町内会管理者の権限はシステムで保護されています。';
      return redirectBasic(res, req.params.associationId);
    }
    const before = { name: role.name, permissions: role.permissions }; role.name = name; role.permissions = requested.filter((item) => allowedPermissions.includes(item)); await role.save();
    await audit({ association: req.params.associationId, actor: req.user._id, action: 'role.updated', targetType: 'RoleDefinition', targetId: role._id, before, after: { name, permissions: role.permissions }, req });
    req.session.notice = '役職を更新しました。'; return redirectBasic(res, req.params.associationId);
  } catch (error) { return next(error); }
});

managementRouter.post('/:associationId/manage/roles/:roleId/delete', requirePermission('role.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const role = await RoleDefinition.findOne({ _id: req.params.roleId, association: req.params.associationId });
    if (!role) throw fail('役職を確認できません。', 404);
    if (role.name === '町内会管理者' || await RoleAssignment.exists({ association: req.params.associationId, role: role._id }) || await AnnualOfficer.exists({ association: req.params.associationId, role: role._id })) throw fail('管理者役職または使用中の役職は削除できません。', 409);
    await role.deleteOne(); await audit({ association: req.params.associationId, actor: req.user._id, action: 'role.deleted', targetType: 'RoleDefinition', targetId: role._id, before: { name: role.name }, req });
    req.session.notice = '役職を削除しました。'; return redirectBasic(res, req.params.associationId);
  } catch (error) { return next(error); }
});

managementRouter.post('/:associationId/manage/annual/officers', requirePermission('role.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const fiscalYear = Number(req.body.fiscalYear);
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2200 || !validId(req.body.userId)) throw fail('年度と住人を選択してください。');
    const membership = await AssociationMembership.findOne({ association: req.params.associationId, user: req.body.userId, status: 'active', household: { $exists: true } });
    if (!membership) throw fail('住人登録を確認できません。');
    const officer = await AnnualOfficer.findOneAndUpdate({ association: req.params.associationId, fiscalYear, user: membership.user }, { $setOnInsert: { selectedBy: req.user._id }, $unset: { cancelledAt: '' } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    await audit({ association: req.params.associationId, actor: req.user._id, action: 'annual_officer.selected', targetType: 'AnnualOfficer', targetId: officer._id, after: { fiscalYear, user: membership.user }, req });
    req.session.notice = `${fiscalYear}年度の役員を選定しました。`; return redirectAnnual(res, req.params.associationId, fiscalYear);
  } catch (error) { return next(error); }
});

managementRouter.post('/:associationId/manage/annual/officers/configure', requirePermission('role.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const fiscalYear = Number(req.body.fiscalYear), userId = String(req.body.userId || '');
    const redirectAfterSave = () => req.body.returnTo === 'officers' ? res.redirect(`/associations/${req.params.associationId}/manage/officers?year=${fiscalYear}`) : redirectAnnual(res, req.params.associationId, fiscalYear);
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2200 || !validId(userId)) throw fail('年度と世帯主を確認してください。');
    const membership = await AssociationMembership.findOne({ association: req.params.associationId, user: userId, status: 'active', household: { $exists: true } });
    if (!membership) throw fail('世帯主の住民登録を確認できません。');
    const membershipDistrictGroupId = req.body.membershipDistrictGroupId || req.body.districtGroupId;
    if (membershipDistrictGroupId) {
      const districtGroup = await DistrictGroup.findOne({ _id: membershipDistrictGroupId, association: req.params.associationId, active: true });
      if (!districtGroup) throw fail('所属班を確認できません。');
      if (String(membership.districtGroup || '') !== String(districtGroup._id)) {
        await Promise.all([
          AssociationMembership.updateMany({ household: membership.household, association: req.params.associationId }, { $set: { districtGroup: districtGroup._id } }),
          Household.updateOne({ _id: membership.household, association: req.params.associationId }, { $set: { districtGroup: districtGroup._id } }),
          JoinApplication.updateMany({ household: membership.household, association: req.params.associationId, status: { $in: ['pending', 'awaiting_household'] } }, { $set: { districtGroup: districtGroup._id } })
        ]);
        await audit({ association: req.params.associationId, actor: req.user._id, action: 'membership.district.updated', targetType: 'AssociationMembership', targetId: membership._id, before: { districtGroup: membership.districtGroup }, after: { districtGroup: districtGroup._id }, req });
        membership.districtGroup = districtGroup._id;
      }
    }
    const existing = await AnnualOfficer.findOne({ association: req.params.associationId, fiscalYear, user: userId });
    if (!req.body.isOfficer) {
      if (existing) {
        await existing.deleteOne();
        await audit({ association: req.params.associationId, actor: req.user._id, action: 'annual_officer.deleted', targetType: 'AnnualOfficer', targetId: existing._id, before: { fiscalYear, user: userId }, req });
      }
      req.session.notice = existing ? '年度役員のフラグを解除しました。' : '変更はありません。';
      return redirectAfterSave();
    }
    const [role, department] = await Promise.all([
      req.body.roleId ? RoleDefinition.findOne({ _id: req.body.roleId, association: req.params.associationId, active: true, name: { $ne: '町内会管理者' } }) : null,
      req.body.departmentId ? Department.findOne({ _id: req.body.departmentId, association: req.params.associationId, active: true }) : null
    ]);
    if ((req.body.roleId && !role) || (req.body.departmentId && !department)) throw fail('役職または所属部を確認できません。');
    const officer = await AnnualOfficer.findOneAndUpdate(
      { association: req.params.associationId, fiscalYear, user: userId },
      { $set: { role: role?._id || null, department: department?._id || null }, $setOnInsert: { selectedBy: req.user._id }, $unset: { cancelledAt: '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await audit({ association: req.params.associationId, actor: req.user._id, action: existing ? 'annual_officer.updated' : 'annual_officer.selected', targetType: 'AnnualOfficer', targetId: officer._id, before: existing ? { role: existing.role, department: existing.department } : undefined, after: { fiscalYear, user: userId, role: officer.role, department: officer.department }, req });
    req.session.notice = existing ? '役員の役職・所属部を更新しました。' : `${fiscalYear}年度の役員に選定しました。`;
    return redirectAfterSave();
  } catch (error) { return next(error); }
});

managementRouter.post('/:associationId/manage/annual/officers/:officerId/update', requirePermission('role.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const officer = await AnnualOfficer.findOne({ _id: req.params.officerId, association: req.params.associationId });
    if (!officer) throw fail('年度役員を確認できません。', 404);
    const [role, department] = await Promise.all([req.body.roleId ? RoleDefinition.findOne({ _id: req.body.roleId, association: req.params.associationId, active: true }) : null, req.body.departmentId ? Department.findOne({ _id: req.body.departmentId, association: req.params.associationId, active: true }) : null]);
    if ((req.body.roleId && !role) || (req.body.departmentId && !department)) throw fail('役職または所属部を確認できません。');
    const before = { role: officer.role, department: officer.department }; officer.role = role?._id; officer.department = department?._id; await officer.save();
    await audit({ association: req.params.associationId, actor: req.user._id, action: 'annual_officer.updated', targetType: 'AnnualOfficer', targetId: officer._id, before, after: { role: officer.role, department: officer.department }, req });
    req.session.notice = '役員の役職・所属部を更新しました。'; return redirectAnnual(res, req.params.associationId, officer.fiscalYear);
  } catch (error) { return next(error); }
});

managementRouter.post('/:associationId/manage/annual/officers/:officerId/delete', requirePermission('role.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const officer = await AnnualOfficer.findOneAndDelete({ _id: req.params.officerId, association: req.params.associationId });
    if (!officer) throw fail('年度役員を確認できません。', 404);
    await audit({ association: req.params.associationId, actor: req.user._id, action: 'annual_officer.deleted', targetType: 'AnnualOfficer', targetId: officer._id, before: { fiscalYear: officer.fiscalYear, user: officer.user }, req });
    req.session.notice = '年度役員から削除しました。'; return redirectAnnual(res, req.params.associationId, officer.fiscalYear);
  } catch (error) { return next(error); }
});

managementRouter.post('/:associationId/manage/leaders', requirePermission('organization.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const fiscalYear = Number(req.body.fiscalYear);
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2200 || !validId(req.body.districtGroupId) || !validId(req.body.userId)) throw fail('年度、班、世帯代表者を正しく選択してください。');
    const [districtGroup, membership, household] = await Promise.all([DistrictGroup.findOne({ _id: req.body.districtGroupId, association: req.params.associationId }), AssociationMembership.findOne({ association: req.params.associationId, user: req.body.userId, status: 'active' }), req.body.householdId ? Household.findOne({ _id: req.body.householdId, association: req.params.associationId, active: true }) : null]);
    if (!districtGroup || !membership?.household || String(membership.districtGroup) !== String(districtGroup._id) || (req.body.householdId && !household)) throw fail('選択した班に所属する世帯代表者を確認できません。');
    const previous = await AnnualLeaderAssignment.findOne({ association: req.params.associationId, fiscalYear, districtGroup: districtGroup._id });
    const assignment = await AnnualLeaderAssignment.findOneAndUpdate({ association: req.params.associationId, fiscalYear, districtGroup: districtGroup._id }, { $set: { representative: membership.user, household: household?._id || membership.household, assignedBy: req.user._id, notifiedAt: new Date() }, $unset: { cancelledAt: '' } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    if (previous) await Notification.deleteMany({ relatedType: 'AnnualLeaderAssignment', relatedId: assignment._id, type: 'district_leader_assigned' });
    await Notification.create({ association: req.params.associationId, recipient: membership.user, type: 'district_leader_assigned', title: `${fiscalYear}年度 ${districtGroup.name}班長のお願い`, body: `${fiscalYear}年度の${districtGroup.name}班長に指定されました。`, relatedType: 'AnnualLeaderAssignment', relatedId: assignment._id });
    await audit({ association: req.params.associationId, actor: req.user._id, action: 'district_leader.assigned', targetType: 'AnnualLeaderAssignment', targetId: assignment._id, after: { fiscalYear, districtGroup: districtGroup._id, representative: membership.user }, req });
    req.session.notice = '班長を指定し、対象者へ通知しました。'; return redirectAnnual(res, req.params.associationId, fiscalYear);
  } catch (error) { return next(error); }
});

managementRouter.post('/:associationId/manage/leaders/configure', requirePermission('organization.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const fiscalYear = Number(req.body.fiscalYear), userId = String(req.body.userId || '');
    const redirectAfterSave = () => req.body.returnTo === 'leaders' ? res.redirect(`/associations/${req.params.associationId}/manage/leaders?year=${fiscalYear}`) : redirectAnnual(res, req.params.associationId, fiscalYear);
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2200 || !validId(userId)) throw fail('年度と世帯主を確認してください。');
    const membership = await AssociationMembership.findOne({ association: req.params.associationId, user: userId, status: 'active', household: { $exists: true } });
    if (!membership) throw fail('世帯主の住民登録を確認できません。');
    if (req.body.membershipDistrictGroupId) {
      const membershipDistrict = await DistrictGroup.findOne({ _id: req.body.membershipDistrictGroupId, association: req.params.associationId, active: true });
      if (!membershipDistrict) throw fail('所属班を確認できません。');
      if (String(membership.districtGroup || '') !== String(membershipDistrict._id)) {
        await Promise.all([
          AssociationMembership.updateMany({ household: membership.household, association: req.params.associationId }, { $set: { districtGroup: membershipDistrict._id } }),
          Household.updateOne({ _id: membership.household, association: req.params.associationId }, { $set: { districtGroup: membershipDistrict._id } }),
          JoinApplication.updateMany({ household: membership.household, association: req.params.associationId, status: { $in: ['pending', 'awaiting_household'] } }, { $set: { districtGroup: membershipDistrict._id } })
        ]);
        await audit({ association: req.params.associationId, actor: req.user._id, action: 'membership.district.updated', targetType: 'AssociationMembership', targetId: membership._id, before: { districtGroup: membership.districtGroup }, after: { districtGroup: membershipDistrict._id }, req });
        membership.districtGroup = membershipDistrict._id;
      }
    }
    const currentAssignments = await AnnualLeaderAssignment.find({ association: req.params.associationId, fiscalYear, representative: userId });
    if (!req.body.isLeader) {
      if (currentAssignments.length) {
        await AnnualLeaderAssignment.deleteMany({ _id: { $in: currentAssignments.map((item) => item._id) } });
        await Notification.deleteMany({ relatedType: 'AnnualLeaderAssignment', relatedId: { $in: currentAssignments.map((item) => item._id) }, type: 'district_leader_assigned' });
      }
      req.session.notice = currentAssignments.length ? '班長フラグを解除しました。' : '変更はありません。';
      return redirectAfterSave();
    }
    if (!validId(req.body.districtGroupId)) throw fail('担当班を選択してください。');
    const districtGroup = await DistrictGroup.findOne({ _id: req.body.districtGroupId, association: req.params.associationId, active: true });
    if (!districtGroup) throw fail('担当班を確認できません。');
    const previousForDistrict = await AnnualLeaderAssignment.findOne({ association: req.params.associationId, fiscalYear, districtGroup: districtGroup._id });
    if (currentAssignments.length) await AnnualLeaderAssignment.deleteMany({ _id: { $in: currentAssignments.map((item) => item._id), $ne: previousForDistrict?._id } });
    const assignment = await AnnualLeaderAssignment.findOneAndUpdate(
      { association: req.params.associationId, fiscalYear, districtGroup: districtGroup._id },
      { $set: { representative: membership.user, household: membership.household, assignedBy: req.user._id, notifiedAt: new Date() }, $unset: { cancelledAt: '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await Notification.deleteMany({ relatedType: 'AnnualLeaderAssignment', relatedId: assignment._id, type: 'district_leader_assigned' });
    await Notification.create({ association: req.params.associationId, recipient: membership.user, type: 'district_leader_assigned', title: `${fiscalYear}年度 ${districtGroup.name}班長のお願い`, body: `${fiscalYear}年度の${districtGroup.name}班長に指定されました。`, relatedType: 'AnnualLeaderAssignment', relatedId: assignment._id });
    await audit({ association: req.params.associationId, actor: req.user._id, action: 'district_leader.assigned', targetType: 'AnnualLeaderAssignment', targetId: assignment._id, before: previousForDistrict ? { representative: previousForDistrict.representative } : undefined, after: { fiscalYear, districtGroup: districtGroup._id, representative: membership.user }, req });
    req.session.notice = `${fiscalYear}年度の${districtGroup.name}班長を設定しました。`;
    return redirectAfterSave();
  } catch (error) { return next(error); }
});

managementRouter.post('/:associationId/manage/leaders/:assignmentId/delete', requirePermission('organization.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const assignment = await AnnualLeaderAssignment.findOneAndDelete({ _id: req.params.assignmentId, association: req.params.associationId });
    if (!assignment) throw fail('班長設定を確認できません。', 404);
    await Notification.deleteMany({ relatedType: 'AnnualLeaderAssignment', relatedId: assignment._id, type: 'district_leader_assigned' });
    await audit({ association: req.params.associationId, actor: req.user._id, action: 'district_leader.deleted', targetType: 'AnnualLeaderAssignment', targetId: assignment._id, before: { fiscalYear: assignment.fiscalYear, representative: assignment.representative }, req });
    req.session.notice = '班長設定を削除しました。'; return redirectAnnual(res, req.params.associationId, assignment.fiscalYear);
  } catch (error) { return next(error); }
});

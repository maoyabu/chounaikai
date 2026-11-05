import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { DistrictGroup, Household } from '../models/organization.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { JoinApplication } from '../models/workflow.js';
import { AuditLog } from '../models/auditLog.js';
import { LocationLinkRequest } from '../models/locationLinkRequest.js';
import { annualRoleYears } from '../lib/annualRoleAccess.js';
import { loadLeaderDistrictIds } from './householdParticipationService.js';
import { runWithOptionalTransaction } from './associationService.js';

export const locationId = value => String(value?._id || value || '');
const same = (a, b) => locationId(a) === locationId(b);
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const fields = '_id updatedAt districtGroup district group household user representative feeRepresentative profileHousehold fiscalYear status active cancelledAt districtLabel';
const models = { memberships: AssociationMembership, households: Household, officers: AnnualOfficer, leaders: AnnualLeaderAssignment, applications: JoinApplication };

export const loadLocationLink = async ({ associationId, userId, kind, recordId, actorId, manager, session = null }) => {
  if (![associationId, userId, recordId, actorId].every(mongoose.isValidObjectId) || !['ledger', 'officer', 'leader'].includes(kind)) throw fail('紐付け対象を確認してください。', 400);
  const membership = await AssociationMembership.findOne({ association: associationId, user: userId, status: 'active' }).populate('user', 'displayname username').session(session).lean();
  if (!membership) throw fail('参加中の会員を確認できません。', 404);
  const targetModel = kind === 'ledger' ? Household : kind === 'officer' ? AnnualOfficer : AnnualLeaderAssignment;
  const target = await targetModel.findOne({ _id: recordId, association: associationId, ...(kind === 'ledger' ? { active: true } : { cancelledAt: null }) }).session(session).lean();
  if (!target) throw fail('紐付け対象を確認できません。', 404);
  let allowedDistricts = [];
  if (!manager) {
    allowedDistricts = await loadLeaderDistrictIds(associationId, actorId);
    if (kind !== 'ledger' || !allowedDistricts.some(value => same(value, target.districtGroup))) throw fail('担当班の世帯と会員だけを紐付けできます。', 403);
    if (!await AssociationMembership.exists({ association: associationId, user: actorId, status: 'active' }).session(session)) throw fail('班長の参加状況を確認できません。', 403);
  }
  if (kind === 'ledger' && (!target.districtLabel || target.representative || target.feeRepresentative)) throw fail('未紐付けの世帯を選び直してください。');
  // Follow the profile/ledger relationship without replacing the family household ID.
  const householdIds = new Set([membership.household, membership.ledgerPreviousHousehold].filter(Boolean).map(locationId));
  const userIds = new Set([locationId(userId)]);
  const relatedHouseholds = new Map(), relatedMemberships = new Map();
  let size = -1;
  while (size !== householdIds.size + userIds.size) {
    size = householdIds.size + userIds.size;
    const houses = await Household.find({ association: associationId, active: true, $or: [{ _id: { $in: [...householdIds] } }, { profileHousehold: { $in: [...householdIds] } }, { representative: { $in: [...userIds] } }, { feeRepresentative: { $in: [...userIds] } }] }).select(fields).session(session).lean();
    for (const house of houses) {
      relatedHouseholds.set(locationId(house), house);
      householdIds.add(locationId(house));
      if (house.profileHousehold) householdIds.add(locationId(house.profileHousehold));
    }
    const members = await AssociationMembership.find({ association: associationId, status: { $in: ['active', 'pending', 'withdrawal_pending'] }, $or: [{ user: { $in: [...userIds] } }, { household: { $in: [...householdIds] } }] }).select(fields).session(session).lean();
    for (const member of members) {
      relatedMemberships.set(locationId(member), member);
      userIds.add(locationId(member.user));
      if (member.household) householdIds.add(locationId(member.household));
    }
  }
  const sourceId = membership.ledgerPreviousHousehold || membership.household;
  if (sourceId && !relatedHouseholds.has(locationId(sourceId))) throw fail('会員の家族世帯を確認できません。管理者に世帯情報の確認を依頼してください。');
  relatedMemberships.set(locationId(membership), membership);
  if (kind === 'ledger' && [...relatedHouseholds.values()].some(h => (h.feeRepresentative || h.districtLabel) && !(h.districtLabel === '班長世帯' && !h.representative && same(h.feeRepresentative, userId)))) throw fail('この会員または世帯はすでに台帳に紐付けされています。');
  if (kind === 'ledger') relatedHouseholds.set(locationId(target), target);
  const minimumYear = Math.min(...annualRoleYears());
  const [officers, leaders, applications, districts] = await Promise.all([
    AnnualOfficer.find({ association: associationId, user: { $in: [...userIds] }, fiscalYear: { $gte: minimumYear }, cancelledAt: null }).select(fields).session(session).lean(),
    AnnualLeaderAssignment.find({ association: associationId, representative: { $in: [...userIds] }, fiscalYear: { $gte: minimumYear }, cancelledAt: null }).select(fields).session(session).lean(),
    JoinApplication.find({ association: associationId, household: { $in: [...householdIds] }, status: { $in: ['pending', 'awaiting_household'] } }).select(fields).session(session).lean(),
    DistrictGroup.find({ association: associationId, active: true }).select('_id name parentDistrict updatedAt').session(session).lean()
  ]);
  if (kind !== 'ledger') {
    const list = kind === 'officer' ? officers : leaders;
    if (!list.some(row => same(row, target))) list.push(target);
  }
  const rows = { memberships: [...relatedMemberships.values()], households: [...relatedHouseholds.values()], officers, leaders, applications };
  const entries = Object.entries(rows).flatMap(([type, list]) => list.map(row => ({ type, id: locationId(row), districtGroup: locationId(row.districtGroup), fiscalYear: row.fiscalYear })));
  const districtMap = new Map(districts.map(row => [locationId(row), row]));
  const groupIds = [...new Set(entries.map(row => row.districtGroup).filter(Boolean))];
  const choices = groupIds.filter(value => districtMap.has(value)).map(value => {
    const group = districtMap.get(value), parent = districtMap.get(locationId(group.parentDistrict));
    return { id: value, label: parent ? `${parent.name}・${group.name}` : group.name };
  });
  const version = row => [locationId(row), row.updatedAt || null, ...['districtGroup', 'district', 'group', 'household', 'user', 'representative', 'feeRepresentative', 'profileHousehold', 'status', 'active', 'cancelledAt', 'ledgerPreviousHousehold', 'ledgerPreviousDistrictGroup'].map(key => locationId(row[key]))];
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ kind, recordId: locationId(recordId), userId: locationId(userId), rows: Object.fromEntries(Object.entries(rows).map(([key, list]) => [key, list.map(version).sort((a, b) => a[0].localeCompare(b[0]))])), districts: districts.map(version).sort((a, b) => a[0].localeCompare(b[0])) })).digest('hex');
  return { associationId, userId, kind, recordId, actorId, manager, membership, target, rows, choices, entries, districts, fingerprint, conflict: groupIds.length > 1, allowedDistricts };
};

export const locationLinkPresentation = context => ({
  memberName: context.membership.user?.displayname || context.membership.user?.username || '選択した会員',
  choices: context.choices,
  conflictRows: context.entries.map(row => ({ ...row, typeLabel: { memberships: '会員・家族の所属', households: '世帯・世帯台帳', officers: '役員', leaders: '班長', applications: '参加申請' }[row.type], label: context.choices.find(choice => choice.id === row.districtGroup)?.label || '地区・班未設定' })),
  impact: { memberships: context.rows.memberships.length, households: context.rows.households.length, officers: context.rows.officers.length, leaders: context.rows.leaders.length },
  manager: context.manager
});

const updateFor = (row, values) => {
  const set = {}, unset = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) unset[key] = '';
    else set[key] = value;
  }
  return { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) };
};

export const applyLocationLink = async (input, { fingerprint, districtId, approvedRequest } = {}) => {
  const undo = [], created = [];
  return runWithOptionalTransaction(async session => {
    undo.length = 0; created.length = 0;
    const context = await loadLocationLink({ ...input, session });
    if (context.fingerprint !== fingerprint) throw fail('確認中に情報が変更されました。紐付けを最初からやり直してください。');
    const selected = context.districts.find(row => same(row, districtId));
    if (!selected || !context.choices.some(choice => same(choice.id, districtId))) throw fail('表示された地区・班から選択してください。', 400);
    if (!input.manager && (context.conflict || !context.allowedDistricts.some(value => same(value, districtId)))) throw fail('地区・班の統一には管理者の承認が必要です。', 403);
    if (selected.parentDistrict && !context.districts.some(row => same(row, selected.parentDistrict))) throw fail('地区が無効になっています。');
    const options = session ? { session } : {};
    if (input.kind === 'officer' && context.rows.officers.some(row => !same(row, context.target) && same(row.user, input.userId) && row.fiscalYear === context.target.fiscalYear)) throw fail('この会員は対象年度の別の役員記録に紐付け済みです。年度設定を確認してください。');
    // A leader cannot take another assignment's unique district/year slot.
    for (const leader of context.rows.leaders) {
      const duplicate = await AnnualLeaderAssignment.findOne({ association: input.associationId, fiscalYear: leader.fiscalYear, districtGroup: selected._id, _id: { $ne: leader._id } }).session(session).lean();
      if (duplicate) throw fail(`${leader.fiscalYear}年度の変更先には既に班長の記録があります。年度設定で班長を整理してから再度紐付けしてください。`);
    }
    const write = async (Model, row, values) => {
      const after = updateFor(row, values);
      const before = Object.fromEntries(Object.keys(values).map(key => [key, row[key]]));
      const filter = { _id: row._id, association: input.associationId, ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}) };
      const result = await Model.updateOne(filter, after, options);
      if (result.matchedCount !== 1) throw fail('情報が変更されました。画面を開き直してください。');
      undo.push({ Model, row, before, after });
    };
    if (approvedRequest) {
      const claim = await LocationLinkRequest.updateOne({ _id: approvedRequest._id, association: input.associationId, status: 'pending', fingerprint }, { $set: { status: 'approved', decidedBy: input.actorId, decidedAt: new Date() } }, options);
      if (claim.matchedCount !== 1) throw fail('この確認依頼は処理済みです。');
      undo.push({ Model: LocationLinkRequest, row: approvedRequest, before: { status: 'pending', decidedBy: undefined, decidedAt: undefined }, after: { $set: { status: 'approved', decidedBy: input.actorId } } });
    }
    const familyId = context.membership.ledgerPreviousHousehold || context.membership.household || (input.kind === 'ledger' ? context.target._id : undefined);
    let leaderHousehold = familyId || context.rows.households[0]?._id;
    if (input.kind === 'leader' && !leaderHousehold) {
      const [house] = await Household.create([{ association: input.associationId, districtGroup: selected._id, displayName: '班長世帯', representative: input.userId }], options);
      leaderHousehold = house._id;
      created.push({ Model: Household, id: house._id });
    }
    for (const [type, rows] of Object.entries(context.rows)) for (const row of rows) {
      const values = { districtGroup: selected._id };
      if (type === 'officers' || type === 'leaders') Object.assign(values, { district: selected.parentDistrict || selected._id, group: selected.parentDistrict ? selected._id : undefined });
      if (type === 'memberships' && same(row.user, input.userId)) {
        if (input.kind === 'ledger' || (input.kind === 'leader' && !row.household)) Object.assign(values, { household: input.kind === 'ledger' ? familyId : leaderHousehold, ledgerPreviousHousehold: undefined, ledgerPreviousDistrictGroup: undefined });
      }
      if (type === 'households' && input.kind === 'ledger' && row.districtLabel === '班長世帯' && !row.representative && same(row.feeRepresentative, input.userId)) Object.assign(values, { districtLabel: undefined, feeRepresentative: undefined, representative: input.userId });
      if (type === 'households' && input.kind === 'ledger' && same(row, context.target)) Object.assign(values, { feeRepresentative: input.userId, profileHousehold: same(familyId, row._id) ? undefined : familyId, ...(!familyId || same(familyId, row._id) ? { representative: input.userId } : {}) });
      if (type === 'officers' && input.kind === 'officer' && same(row, context.target)) values.user = input.userId;
      if (type === 'leaders' && input.kind === 'leader' && same(row, context.target)) Object.assign(values, { representative: input.userId, household: leaderHousehold });
      await write(models[type], row, values);
    }
    const [audit] = await AuditLog.create([{ association: input.associationId, actor: input.actorId, action: 'membership.location_linked', targetType: input.kind, targetId: input.recordId, before: { locations: context.entries }, after: { districtGroup: selected._id, user: input.userId, request: approvedRequest?._id } }], options);
    created.push({ Model: AuditLog, id: audit._id });
    return context;
  }, async () => {
    for (const entry of [...undo].reverse()) {
      // Do not overwrite another operation's changes during compensation.
      const filter = { _id: entry.row._id, association: input.associationId, ...entry.after.$set };
      for (const key of Object.keys(entry.after.$unset || {})) filter[key] = { $exists: false };
      await entry.Model.updateOne(filter, updateFor(entry.row, entry.before));
    }
    for (const entry of [...created].reverse()) await entry.Model.deleteOne({ _id: entry.id, association: input.associationId });
  });
};

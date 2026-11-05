import { Household } from '../models/organization.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { runWithOptionalTransaction } from './associationService.js';

const same = (a, b) => String(a || '') === String(b || '');
const fail = message => Object.assign(new Error(message), { status: 409 });

// The ledger points to the family's household; it must not replace the family's ID.
export const linkHouseholdLedger = async ({ associationId, membership, household }) => {
  const sourceId = membership.ledgerPreviousHousehold || membership.household;
  let profile, residents = [], linked = false, profileChanged = false, residentsChanged = false, memberChanged = false;
  const previous = { household: membership.household, districtGroup: membership.districtGroup, ledgerPreviousHousehold: membership.ledgerPreviousHousehold, ledgerPreviousDistrictGroup: membership.ledgerPreviousDistrictGroup };
  const ledgerBefore = { feeRepresentative: household.feeRepresentative, profileHousehold: household.profileHousehold, representative: household.representative };
  await runWithOptionalTransaction(async session => {
    const options = session ? { session } : {};
    profile = sourceId && !same(sourceId, household._id)
      ? await Household.findOne({ _id: sourceId, association: associationId, active: true }).session(session).lean() : null;
    if (sourceId && !same(sourceId, household._id) && !profile) throw fail('家族情報のある世帯を確認できません。管理者にご確認ください。');
    const familyId = profile?._id || household._id;
    if (profile && !same(profile.districtGroup, household.districtGroup)) {
      residents = await AssociationMembership.find({ association: associationId, household: profile._id, status: { $in: ['active', 'pending', 'withdrawal_pending'] } }).session(session).lean();
      const changed = await Household.updateOne({ _id: profile._id, association: associationId, districtGroup: profile.districtGroup, active: true }, { $set: { districtGroup: household.districtGroup } }, options);
      if (changed.matchedCount !== 1) throw fail('世帯の所属班が変更されました。画面を開き直してください。');
      profileChanged = true;
      residentsChanged = true;
      const moved = await AssociationMembership.updateMany({ _id: { $in: residents.map(item => item._id) }, association: associationId, household: profile._id }, { $set: { districtGroup: household.districtGroup } }, options);
      if (moved.matchedCount !== residents.length) throw fail('家族の所属が変更されました。画面を開き直してください。');
    }
    membership.household = familyId;
    membership.districtGroup = household.districtGroup;
    membership.ledgerPreviousHousehold = undefined;
    membership.ledgerPreviousDistrictGroup = undefined;
    await membership.save(options);
    memberChanged = true;
    household.feeRepresentative = membership.user;
    household.profileHousehold = profile?._id;
    if (!profile) household.representative = household.representative || membership.user;
    await household.save(options);
    linked = true;
  }, async () => {
    // Standalone development databases do not support transactions.
    if (linked) { Object.assign(household, ledgerBefore); await household.save(); }
    if (memberChanged) { Object.assign(membership, previous); await membership.save(); }
    if (residentsChanged) for (const resident of residents) {
      await AssociationMembership.updateOne({ _id: resident._id, association: associationId, household: profile._id }, resident.districtGroup ? { $set: { districtGroup: resident.districtGroup } } : { $unset: { districtGroup: '' } });
    }
    if (profileChanged) await Household.updateOne({ _id: profile._id, association: associationId }, { $set: { districtGroup: profile.districtGroup } });
  });
};

import { Household, HouseholdMember, DistrictGroup } from '../models/organization.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { User } from '../models/user.js';
import { JoinApplication } from '../models/workflow.js';
import { ResidentRegistration } from '../models/residentRegistration.js';

const dateValue = value => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};

export const loadJoinFormValues = async ({ associationId, user }) => {
  const [member, application, registration] = await Promise.all([
    // Include ended memberships: withdrawal retains this information for rejoining.
    HouseholdMember.findOne({ association: associationId, user: user._id }).sort({ updatedAt: -1, startsAt: -1 }).populate({ path: 'household', populate: { path: 'representative', select: 'email' } }).lean(),
    JoinApplication.findOne({ association: associationId, applicant: user._id }).sort({ updatedAt: -1 }).lean(),
    ResidentRegistration.findOne({ user: user._id }).lean()
  ]);
  const profile = member || application?.residentProfile || {};
  const household = member?.household;
  const isHead = household?.representative && String(household.representative._id) === String(user._id);
  let headDistrictGroupId = '';
  if (registration?.residentMode === 'general' && registration.householdHeadEmail) {
    const head = await User.findOne({ email: String(registration.householdHeadEmail).trim().toLowerCase() })
      .collation({ locale: 'en', strength: 2 }).select('_id').lean();
    if (head) {
      const headHousehold = await Household.findOne({ association: associationId, representative: head._id, active: true }).select('_id districtGroup').lean();
      if (headHousehold) {
        const [membership, district] = await Promise.all([
          AssociationMembership.exists({ association: associationId, user: head._id, household: headHousehold._id, status: 'active' }),
          DistrictGroup.exists({ _id: headHousehold.districtGroup, association: associationId, active: true })
        ]);
        if (membership && district) headDistrictGroupId = String(headHousehold.districtGroup);
      }
    }
  }
  return {
    residentMode: registration?.residentMode || (household ? isHead ? 'representative' : 'general' : 'representative'),
    householdHeadEmail: registration?.householdHeadEmail || (!isHead && household?.active ? household.representative?.email || '' : ''),
    districtGroupId: headDistrictGroupId || String(household?.districtGroup || application?.districtGroup || ''),
    postalCode: household?.address?.postalCode || '', street: household?.address?.street || '', building: household?.address?.building || '', phone: household?.phone || '',
    representativeKana: profile.nameKana || '', birthDate: dateValue(user.birth_date || profile.birthDate), gender: user.sex || profile.gender || 'unspecified',
    lineAccount: profile.lineAccount || '', relationship: profile.relationship || '', applicantNote: application?.applicantNote || ''
  };
};

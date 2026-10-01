import { HouseholdMember } from '../models/organization.js';
import { JoinApplication } from '../models/workflow.js';

const dateValue = value => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};

export const loadJoinFormValues = async ({ associationId, user }) => {
  const [member, application] = await Promise.all([
    // Include ended memberships: withdrawal retains this information for rejoining.
    HouseholdMember.findOne({ association: associationId, user: user._id }).sort({ updatedAt: -1, startsAt: -1 }).populate('household').lean(),
    JoinApplication.findOne({ association: associationId, applicant: user._id }).sort({ updatedAt: -1 }).lean()
  ]);
  const profile = member || application?.residentProfile || {};
  const household = member?.household;
  return {
    residentMode: 'representative',
    districtGroupId: String(household?.districtGroup || application?.districtGroup || ''),
    postalCode: household?.address?.postalCode || '', street: household?.address?.street || '', building: household?.address?.building || '', phone: household?.phone || '',
    representativeKana: profile.nameKana || '', birthDate: dateValue(user.birth_date || profile.birthDate), gender: user.sex || profile.gender || 'unspecified',
    lineAccount: profile.lineAccount || '', relationship: profile.relationship || '', applicantNote: application?.applicantNote || ''
  };
};

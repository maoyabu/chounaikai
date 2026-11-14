import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { annualRoleYearFilter } from '../lib/annualRoleAccess.js';
import { viewerDisclosureAccess } from './officerDisclosureService.js';

// Directory access is separate from each officer's personal-data consent.
export const canViewOfficerDirectory = async (association, user, access) => {
  const viewer = access || await viewerDisclosureAccess(association, user);
  if (viewer.manager || viewer.audience === 'officers') return true;
  if (!user || viewer.audience !== 'residents' || !viewer.viewerId) return false;
  return Boolean(await AnnualLeaderAssignment.exists({ association: association._id,
    representative: user._id, fiscalYear: annualRoleYearFilter(), cancelledAt: null }));
};

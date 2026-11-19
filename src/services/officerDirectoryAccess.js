import { residentDisplayEnabled } from './associationFeatureService.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { annualRoleYearFilter } from '../lib/annualRoleAccess.js';
import { viewerDisclosureAccess } from './officerDisclosureService.js';

// Directory access is separate from each officer's personal-data consent.
export const canViewOfficerDirectory = async (association, user, access) => {
  if (!residentDisplayEnabled(association, 'officers')) return false;
  const viewer = access || await viewerDisclosureAccess(association, user);
  if (viewer.manager || viewer.audience === 'officers') return true;
  if (!user || viewer.audience !== 'residents' || !viewer.viewerId) return false;
  // Existing associations retain directory permissions until the administrator
  // explicitly saves resident visibility; personal-data consent still applies.
  if (association.residentDisplay?.officers === true) return true;
  return Boolean(await AnnualLeaderAssignment.exists({ association: association._id,
    representative: user._id, fiscalYear: annualRoleYearFilter(), cancelledAt: null }));
};

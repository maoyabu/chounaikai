import { Household } from '../models/organization.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { annualRoleYearFilter } from '../lib/annualRoleAccess.js';

const id = value => String(value?._id || value || '');

// Ledger membership and annual appointments are separate relationships.
export const loadMemberTags = async association => {
  const [ledgers, officers, leaders] = await Promise.all([
    Household.find({ association, active: true, feeRepresentative: { $ne: null } }).select('feeRepresentative profileHousehold').lean(),
    AnnualOfficer.find({ association, fiscalYear: annualRoleYearFilter(), cancelledAt: null, user: { $ne: null } }).populate('role', 'name').lean(),
    AnnualLeaderAssignment.find({ association, fiscalYear: annualRoleYearFilter(), cancelledAt: null, representative: { $ne: null } }).select('representative').lean()
  ]);
  return {
    isLinked(user, household) {
      return ledgers.some(row => (id(user) && id(row.feeRepresentative) === id(user)) || (id(household) && [id(row._id), id(row.profileHousehold)].includes(id(household))));
    },
    roles(users) {
      const ids = new Set(users.filter(Boolean).map(id));
      return [...new Set([
        ...officers.filter(row => ids.has(id(row.user))).map(row => row.role?.name || '一般役員'),
        ...leaders.filter(row => ids.has(id(row.representative))).map(() => '班長')
      ])];
    }
  };
};

import { Household, HouseholdMember, DistrictGroup } from '../models/organization.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { visibleEvents, calendarWindow } from './associationEventService.js';
import { AssociationGroup, AssociationGroupMembership } from '../models/associationGroup.js';

export const loadAssociationPageData = async (association, { publicOnly = true, month } = {}) => {
  const now = new Date(), fiscalYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  const window = calendarWindow(month, now);
  const [events, districtGroups, households, officers, groups] = await Promise.all([
    visibleEvents([association._id], { publicOnly, now: window.first }),
    DistrictGroup.find({ association: association._id, active: true }).sort({ sortOrder: 1, name: 1 }).lean(),
    Household.find({ association: association._id, active: true, deletedAt: { $exists: false } }).select('_id districtGroup').lean(),
    AnnualOfficer.find({ association: association._id, fiscalYear, cancelledAt: null }).populate('user', 'displayname username avatar').populate('role', 'name').populate('department', 'name').sort({ createdAt: 1 }).lean(),
    AssociationGroup.find({ association: association._id, status: 'active' }).sort({ name: 1 }).lean()
  ]);
  const groupMembers = groups.length ? await AssociationGroupMembership.aggregate([{ $match: { association: association._id, group: { $in: groups.map(group => group._id) }, status: 'active' } }, { $group: { _id: '$group', count: { $sum: 1 } } }]) : [];
  const groupCount = new Map(groupMembers.map(item => [String(item._id), item.count]));
  const memberCounts = households.length ? await HouseholdMember.aggregate([
    { $match: { association: association._id, household: { $in: households.map(household => household._id) }, endsAt: null } },
    { $group: { _id: '$household', count: { $sum: 1 } } }
  ]) : [];
  const memberCountByHousehold = new Map(memberCounts.map(item => [String(item._id), item.count]));
  const districtStats = districtGroups.map(group => {
    const groupHouseholds = households.filter(household => String(household.districtGroup) === String(group._id));
    return { name: group.name, householdCount: groupHouseholds.length, residentCount: groupHouseholds.reduce((sum, household) => sum + (memberCountByHousehold.get(String(household._id)) || 0), 0) };
  });
  return {
    events, months: window.months, calendarWindow: window, fiscalYear, officers, districtStats,
    groups: groups.filter(group => !publicOnly || group.publicVisibility === 'open').map(group => ({ ...group, memberCount: groupCount.get(String(group._id)) || 0 })),
    householdCount: households.length,
    residentCount: households.reduce((sum, household) => sum + (memberCountByHousehold.get(String(household._id)) || 0), 0)
  };
};

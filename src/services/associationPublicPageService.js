import { canViewGoodPlaceAuthors, goodPlaceAuthorQuery, redactGoodPlaceAuthor } from './goodPlaceDisclosureService.js';
import { GoodPlace } from '../models/goodPlace.js';
import { discloseOfficers } from './officerDisclosureService.js';
import { Household, HouseholdMember, DistrictGroup } from '../models/organization.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { AnnualDepartmentPlan } from '../models/annualDepartmentPlan.js';
import { visibleEvents, calendarWindow } from './associationEventService.js';
import { AssociationGroup, AssociationGroupMembership } from '../models/associationGroup.js';

// Both the association total and each location use the same household roster.
// Family members need not have accounts; ended roster entries are excluded by
// the member-count query below. District totals include their child groups.
export const summarizeAssociationHouseholds = (districtGroups, households, memberCounts) => {
  const memberCountByHousehold = new Map(memberCounts.map(item => [String(item._id), item.count]));
  const householdsByGroup = new Map();
  for (const household of households) {
    const key = String(household.districtGroup);
    if (!householdsByGroup.has(key)) householdsByGroup.set(key, []);
    householdsByGroup.get(key).push(household);
  }
  const residents = rows => rows.reduce((sum, household) => sum + (memberCountByHousehold.get(String(household._id)) || 0), 0);
  const districts = districtGroups.filter(group => !group.parentDistrict);
  const children = districtGroups.filter(group => group.parentDistrict);
  const knownDistricts = new Set(districts.map(group => String(group._id)));
  const orderedGroups = districts.flatMap(district => [district, ...children.filter(group => String(group.parentDistrict) === String(district._id))]);
  orderedGroups.push(...children.filter(group => !knownDistricts.has(String(group.parentDistrict))));
  const districtStats = orderedGroups.map(group => {
    const ids = [group._id, ...(!group.parentDistrict ? children.filter(child => String(child.parentDistrict) === String(group._id)).map(child => child._id) : [])];
    const rows = ids.flatMap(id => householdsByGroup.get(String(id)) || []);
    const parent = group.parentDistrict && districts.find(district => String(district._id) === String(group.parentDistrict));
    const name = parent && !group.name.startsWith(parent.name) ? `${parent.name} ${group.name}` : group.name;
    return { name, householdCount: rows.length, residentCount: residents(rows) };
  });
  return { districtStats, householdCount: households.length, residentCount: residents(households) };
};

export const loadAssociationPageData = async (association, { publicOnly = true, month, viewer = {} } = {}) => {
  const now = new Date(), fiscalYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  const window = calendarWindow(month, now);
  const showGoodPlaceAuthors = !publicOnly && await canViewGoodPlaceAuthors(association._id, viewer.viewerId);
  const [events, districtGroups, households, rawOfficers, groups, departmentPlans, goodPlaces] = await Promise.all([
    visibleEvents([association._id], { publicOnly, now: window.first }),
    DistrictGroup.find({ association: association._id, active: true }).sort({ sortOrder: 1, createdAt: 1, name: 1 }).lean(),
    Household.find({ association: association._id, active: true, deletedAt: { $exists: false } }).select('_id districtGroup').lean(),
    AnnualOfficer.find({ association: association._id, fiscalYear, cancelledAt: null }).populate('user', 'displayname username email avatar').populate('role', 'name').populate('department', 'name').populate('districtGroup', 'name').sort({ createdAt: 1 }).lean(),
    AssociationGroup.find({ association: association._id, status: { $in: ['active', 'suspended'] } }).sort({ name: 1 }).lean(),
    AnnualDepartmentPlan.find({ association: association._id, fiscalYear }).populate('department', 'name sortOrder').sort({ createdAt: 1 }).lean(),
    goodPlaceAuthorQuery(GoodPlace.find({ association: association._id }), showGoodPlaceAuthors).sort({ createdAt: -1, _id: -1 }).lean()
  ]);
  const officers = await discloseOfficers(association, rawOfficers, publicOnly ? { audience: 'open' } : viewer);
  const groupMembers = groups.length ? await AssociationGroupMembership.aggregate([{ $match: { association: association._id, group: { $in: groups.map(group => group._id) }, status: 'active' } }, { $group: { _id: '$group', count: { $sum: 1 } } }]) : [];
  const groupCount = new Map(groupMembers.map(item => [String(item._id), item.count]));
  const memberCounts = households.length ? await HouseholdMember.aggregate([
    { $match: { association: association._id, household: { $in: households.map(household => household._id) }, endsAt: null } },
    { $group: { _id: '$household', count: { $sum: 1 } } }
  ]) : [];
  const householdStats = summarizeAssociationHouseholds(districtGroups, households, memberCounts);
  const plansWithOfficers = departmentPlans.map((plan) => ({
    ...plan,
    officers: officers.filter((officer) => String(officer.department?._id || officer.department || '') === String(plan.department?._id || plan.department || ''))
  }));
  return {
    goodPlaces: goodPlaces.map(report => redactGoodPlaceAuthor(report, showGoodPlaceAuthors)), showGoodPlaceAuthors, events, months: window.months, calendarWindow: window, fiscalYear, officers, departmentPlans: plansWithOfficers, ...householdStats,
    groups: groups.filter(group => !publicOnly || group.publicVisibility === 'open').map(group => ({ ...group, memberCount: groupCount.get(String(group._id)) || 0 }))
  };
};

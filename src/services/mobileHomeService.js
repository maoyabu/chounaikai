import { AssociationMembership } from '../models/associationMembership.js';
import { RoleAssignment } from '../models/role.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { AssociationGroupMembership } from '../models/associationGroup.js';
import { annualRoleYearFilter } from '../lib/annualRoleAccess.js';

const id = value => value ? String(value._id || value) : null;

const activeAssignmentFilter = now => ({
  startsAt: { $lte: now },
  $or: [
    { endsAt: null },
    { endsAt: { $exists: false } },
    { endsAt: { $gte: now } }
  ]
});

const roleLabel = ({ department, role }, fallback) => {
  const values = [department?.name, role?.name].filter(Boolean);
  return values.length ? values.join(' ') : fallback;
};

const uniqueRoles = roles => [...new Map(roles.map(role => [
  `${role.kind}:${role.name}:${role.groupId || ''}`,
  role
])).values()];

export const mobileAssociationProfile = ({ membership, assignments, officers, leaders, groupManagers }) => {
  const districtGroup = membership.districtGroup;
  const district = districtGroup?.parentDistrict || (districtGroup ? districtGroup : null);
  const group = districtGroup?.parentDistrict ? districtGroup : null;
  const roles = uniqueRoles([
    ...assignments.filter(item => item.role).map(item => ({
      kind: 'management',
      name: roleLabel(item, '町内会管理者')
    })),
    ...officers.map(item => ({
      kind: 'officer',
      name: roleLabel(item, '一般役員')
    })),
    ...leaders.map(() => ({ kind: 'district_leader', name: '班長' })),
    ...groupManagers.filter(item => item.group).map(item => ({
      kind: 'group_manager',
      name: `${item.group.name} 管理者`,
      groupId: id(item.group)
    }))
  ]);

  return {
    association: {
      id: id(membership.association),
      name: membership.association?.name || ''
    },
    district: district ? { id: id(district), name: district.name } : null,
    group: group ? { id: id(group), name: group.name } : null,
    roles
  };
};

export const loadMobileHome = async ({ userId, now = new Date() }) => {
  const memberships = await AssociationMembership.find({ user: userId, status: 'active' })
    .populate('association', 'name')
    .populate({ path: 'districtGroup', select: 'name parentDistrict', populate: { path: 'parentDistrict', select: 'name' } })
    .lean();
  const associationIds = memberships.map(item => item.association?._id).filter(Boolean);
  if (!associationIds.length) return { associations: [] };

  const [assignments, officers, leaders, groupManagers] = await Promise.all([
    RoleAssignment.find({ association: { $in: associationIds }, user: userId, ...activeAssignmentFilter(now) })
      .populate({ path: 'role', match: { active: true }, select: 'name' })
      .populate('department', 'name')
      .lean(),
    AnnualOfficer.find({ association: { $in: associationIds }, user: userId, fiscalYear: annualRoleYearFilter(now), cancelledAt: null })
      .populate('role', 'name')
      .populate('department', 'name')
      .lean(),
    AnnualLeaderAssignment.find({ association: { $in: associationIds }, representative: userId, fiscalYear: annualRoleYearFilter(now), cancelledAt: null })
      .select('association districtGroup')
      .lean(),
    AssociationGroupMembership.find({ association: { $in: associationIds }, user: userId, role: 'manager', status: 'active' })
      .populate({ path: 'group', match: { status: 'active' }, select: 'name' })
      .lean()
  ]);

  const forAssociation = (rows, associationId) => rows.filter(item => id(item.association) === associationId);
  return {
    associations: memberships.filter(item => item.association).map(membership => {
      const associationId = id(membership.association);
      return mobileAssociationProfile({
        membership,
        assignments: forAssociation(assignments, associationId),
        officers: forAssociation(officers, associationId),
        leaders: forAssociation(leaders, associationId),
        groupManagers: forAssociation(groupManagers, associationId)
      });
    })
  };
};

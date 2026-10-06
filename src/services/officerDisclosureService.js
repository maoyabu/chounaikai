import { AnnualOfficer } from '../models/annualOfficer.js';
import { DisclosureConsent } from '../models/disclosureConsent.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { RoleAssignment } from '../models/role.js';
import { redactOfficer } from './disclosurePolicy.js';
export const currentFiscalYear = (now = new Date()) => now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
export const viewerDisclosureAccess = async (association, user) => {
  if (!user) return { audience: 'open' };
  if (user.isAdmin) return { audience: 'officers', manager: true, viewerId: user._id };
  const now = new Date();
  const [member, assignments, officer] = await Promise.all([
    AssociationMembership.exists({ association: association._id, user: user._id, status: 'active' }),
    RoleAssignment.find({ association: association._id, user: user._id, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] }).populate({ path: 'role', match: { active: true, permissions: 'association.manage' } }).lean(),
    AnnualOfficer.exists({ association: association._id, user: user._id, fiscalYear: currentFiscalYear(), cancelledAt: null })
  ]);
  const manager = assignments.some(item => item.role);
  return { audience: manager || (member && officer) ? 'officers' : member ? 'residents' : 'open', manager, viewerId: member || manager ? user._id : undefined };
};
export const discloseOfficers = async (association, officers, viewer = {}) => {
  const ids = officers.map(item => item.user?._id || item.user).filter(Boolean);
  const [consents, members] = await Promise.all([
    DisclosureConsent.find({ association: association._id, user: { $in: ids } }).lean(),
    AssociationMembership.find({ association: association._id, user: { $in: ids }, status: 'active' }).select('user').lean()
  ]);
  const consentByUser = new Map(consents.map(item => [String(item.user), item]));
  const activeUsers = new Set(members.map(item => String(item.user)));
  return officers.map(officer => {
    const id = String(officer.user?._id || officer.user || '');
    return redactOfficer(officer, association.officerDisclosurePolicy, activeUsers.has(id) ? consentByUser.get(id) : null, { ...viewer, currentYear: currentFiscalYear(), policyHistory: association.officerDisclosureHistory });
  });
};

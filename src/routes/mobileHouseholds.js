import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { Household, HouseholdMember } from '../models/organization.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { Invitation } from '../models/workflow.js';
import { User } from '../models/user.js';
import { saveMemberSupport } from '../services/memberSupportService.js';
import { updateOwnedHousehold, createOwnedHouseholdMember, updateOwnedHouseholdMember, deleteOwnedHouseholdMember } from './households.js';
import { inviteOwnedHouseholdMember, cancelOwnedHouseholdInvitation } from './householdInvitations.js';

const handle = callback => async (req, res, next) => { try { await callback(req, res); } catch (error) { next(error); } };
const ownedHouseholds = userId => Household.find({ representative: userId, active: true })
  .populate({ path: 'association', match: { status: 'active', deletedAt: { $exists: false } }, select: 'name' })
  .populate('districtGroup', 'name').sort({ createdAt: 1 }).lean();
const dateText = value => value ? new Date(value).toISOString().slice(0, 10) : '';
export const mobileHouseholdsRouter = express.Router();
mobileHouseholdsRouter.use(requireLogin, provideCsrfToken, (_req, res, next) => {
  res.locals.mobileHouseholds = true;
  res.set('Cache-Control', 'private, no-store'); next();
});
mobileHouseholdsRouter.get('/access', handle(async (req, res) => {
  res.json({ isHouseholdHead: (await ownedHouseholds(req.user._id)).some(row => row.association) });
}));
mobileHouseholdsRouter.get('/', handle(async (req, res) => {
  const households = (await ownedHouseholds(req.user._id)).filter(row => row.association);
  const householdIds = households.map(row => row._id);
  const [members, memberships, invitations] = await Promise.all([
    HouseholdMember.find({ household: { $in: householdIds }, endsAt: null }).sort({ isRepresentative: -1, birthDate: 1 }).lean(),
    AssociationMembership.find({ user: req.user._id, household: { $in: householdIds }, status: 'active' }).select('household').lean(),
    Invitation.find({ household: { $in: householdIds } }).select('householdMember status expiresAt').sort({ createdAt: -1 }).lean()
  ]);
  const accounts = await User.find({ _id: { $in: members.map(row => row.user).filter(Boolean) } }).select('displayname username email birth_date sex').lean();
  const accountsById = new Map(accounts.map(row => [String(row._id), row]));
  res.json({ csrfToken: res.locals.csrfToken, households: households.map(row => {
    const activeMembership = memberships.some(value => String(value.household) === String(row._id));
    return { id: String(row._id), associationId: String(row.association._id), associationName: row.association.name,
      districtName: row.districtGroup?.name || '班未設定', postalCode: row.address?.postalCode || '', street: row.address?.street || '',
      building: row.address?.building || '', phone: row.phone || '', activeMembership,
      members: members.filter(member => String(member.household) === String(row._id)).map(member => {
        const account = accountsById.get(String(member.user));
        const editable = !member.user || String(member.user) === String(req.user._id);
        const invitation = invitations.find(value => String(value.householdMember) === String(member._id));
        const pendingInvitation = invitation?.status === 'pending' && new Date(invitation.expiresAt) > new Date();
        return { id: String(member._id), name: account?.displayname || member.name || '', nameKana: member.nameKana || '',
          birthDate: dateText(!editable && account?.birth_date || member.birthDate), gender: !editable && account?.sex || member.gender || 'unspecified',
          email: !editable && account?.email || member.email || '', lineAccount: member.lineAccount || '', relationship: member.relationship || '',
          username: account?.username || '', isRepresentative: Boolean(member.isRepresentative), linked: Boolean(member.user),
          linkedAccountMissing: Boolean(member.user && !account), canEdit: editable, canInvite: !member.user && !member.isRepresentative && activeMembership,
          supportRequired: member.supportRequired ?? null, supportPriority: member.supportPriority ?? null,
          invitationId: pendingInvitation ? String(invitation._id) : null,
          invitationExpiresAt: pendingInvitation ? invitation.expiresAt : null };
      }) };
  }) });
}));
// Guard each mobile mutation before reusing the Web validation and lifecycle handlers.
mobileHouseholdsRouter.use('/:associationId/:householdId', async (req, res, next) => {
  try {
    if (![req.params.associationId, req.params.householdId].every(mongoose.isValidObjectId)) return res.status(400).json({ error: 'invalid_request' });
    const household = await Household.findOne({ _id: req.params.householdId, association: req.params.associationId, representative: req.user._id, active: true })
      .populate({ path: 'association', match: { status: 'active', deletedAt: { $exists: false } }, select: '_id' });
    if (!household?.association) return res.status(403).json({ error: 'permission_denied' });
    next();
  } catch (error) { next(error); }
});
mobileHouseholdsRouter.post('/:associationId/:householdId/update', verifyCsrfToken, updateOwnedHousehold);
mobileHouseholdsRouter.post('/:associationId/:householdId/members', verifyCsrfToken, createOwnedHouseholdMember);
mobileHouseholdsRouter.post('/:associationId/:householdId/members/:memberId/update', verifyCsrfToken, updateOwnedHouseholdMember);
mobileHouseholdsRouter.post('/:associationId/:householdId/members/:memberId/delete', verifyCsrfToken, deleteOwnedHouseholdMember);
mobileHouseholdsRouter.post('/:associationId/:householdId/members/:memberId/invite', verifyCsrfToken, inviteOwnedHouseholdMember);
mobileHouseholdsRouter.post('/:associationId/:householdId/invitations/:invitationId/cancel', verifyCsrfToken, cancelOwnedHouseholdInvitation);
mobileHouseholdsRouter.post('/:associationId/:householdId/members/:memberId/support', verifyCsrfToken, handle(async (req, res) => {
  await saveMemberSupport({ ...req.params, actorId: req.user._id, values: req.body });
  res.json({ success: true });
}));

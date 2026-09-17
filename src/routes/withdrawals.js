import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { Household, HouseholdMember } from '../models/organization.js';
import { WithdrawalApplication } from '../models/workflow.js';
import { requestWithdrawal, confirmWithdrawal, decideWithdrawal, cancelWithdrawal } from '../services/withdrawalService.js';

export const withdrawalsRouter = express.Router();
withdrawalsRouter.get('/profile/withdrawals', requireLogin, async (req, res, next) => {
  try {
    const memberships = await AssociationMembership.find({ user: req.user._id, status: 'active' }).populate({ path: 'association', match: { status: 'active', deletedAt: { $exists: false } }, select: 'name' }).populate('household').lean();
    const visibleMemberships = memberships.filter(membership => membership.association && membership.household?.active);
    const ownedIds = visibleMemberships.filter(membership => String(membership.household.representative) === String(req.user._id)).map(membership => membership.household._id);
    const [successorMemberships, members, applications, headApplications] = await Promise.all([
      AssociationMembership.find({ household: { $in: ownedIds }, user: { $ne: req.user._id }, status: 'active' }).populate('user', 'displayname username').lean(),
      HouseholdMember.find({ household: { $in: ownedIds }, endsAt: null }).select('user').lean(),
      WithdrawalApplication.find({ requestedBy: req.user._id }).populate('association', 'name').populate('successor', 'displayname username').sort({ createdAt: -1 }).limit(30).lean(),
      WithdrawalApplication.find({ household: { $in: ownedIds }, status: 'awaiting_household' }).populate('requestedBy', 'displayname username email').populate('household', 'displayName').populate('association', 'name').lean()
    ]);
    const successors = successorMemberships.filter(membership => members.some(member => String(member.user) === String(membership.user?._id)));
    const busy = await WithdrawalApplication.find({ household: { $in: visibleMemberships.map(membership => membership.household._id) }, status: { $in: ['awaiting_household', 'pending', 'processing'] } }).select('household').lean();
    return res.render('withdrawals', { title: '町内会の退会申請', memberships: visibleMemberships, successors, applications, headApplications, busyHouseholds: busy.map(application => String(application.household)) });
  } catch (error) { next(error); }
});
withdrawalsRouter.post('/associations/:associationId/withdrawals', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try {
    await requestWithdrawal({ associationId: req.params.associationId, userId: req.user._id, scope: req.body.scope, successorId: req.body.successorId, reason: req.body.reason, confirmed: req.body.confirmWithdrawal === 'on' });
    req.session.notice = '退会申請を送信しました。承認が完了するまで町内会を利用できます。';
    res.redirect('/profile/withdrawals');
  } catch (error) { next(error); }
});
for (const decision of ['approve', 'reject']) {
  withdrawalsRouter.post('/associations/:associationId/withdrawals/:applicationId/head/' + decision, requireLogin, verifyCsrfToken, async (req, res, next) => {
    try {
      await confirmWithdrawal({ ...req.params, actorId: req.user._id, approve: decision === 'approve' });
      req.session.notice = decision === 'approve' ? '世帯主として承認し、班長へ退会申請を送りました。' : '退会申請を承認しませんでした。';
      res.redirect('/profile/withdrawals');
    } catch (error) { next(error); }
  });
  withdrawalsRouter.post('/associations/:associationId/leader/withdrawals/:applicationId/' + decision, requireLogin, verifyCsrfToken, async (req, res, next) => {
    try {
      await decideWithdrawal({ ...req.params, actorId: req.user._id, approve: decision === 'approve' });
      req.session.notice = decision === 'approve' ? '退会申請を承認し、退会が完了しました。' : '退会申請を承認しませんでした。';
      const active = await AssociationMembership.exists({ association: req.params.associationId, user: req.user._id, status: 'active' });
      res.redirect(active ? `/associations/${req.params.associationId}/leader?tab=withdrawals` : '/dashboard');
    } catch (error) { next(error); }
  });
}
withdrawalsRouter.post('/profile/withdrawals/:applicationId/cancel', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try {
    await cancelWithdrawal({ applicationId: req.params.applicationId, actorId: req.user._id });
    req.session.notice = '退会申請を取り消しました。';
    res.redirect('/profile/withdrawals');
  } catch (error) { next(error); }
});

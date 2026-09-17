import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { ResidentRegistration } from '../models/residentRegistration.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { Invitation, JoinApplication } from '../models/workflow.js';
import { Household, HouseholdMember } from '../models/organization.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { assertMailConfigured, sendHouseholdInvitationEmail } from '../services/emailVerificationService.js';
import { loadHouseholdInvitation, acceptHouseholdInvitation, createHouseholdInvitationToken, normalizeEmail } from '../services/householdParticipationService.js';

export const householdInvitationsRouter = express.Router();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

householdInvitationsRouter.get('/household-invitations', async (req, res, next) => {
  try {
    const invitation = await loadHouseholdInvitation({ token: String(req.query.token || '') });
    if (!invitation) return res.status(400).render('error', { title: '招待を利用できません', message: '有効期限が切れているか、受諾済みの招待です。世帯主に再招待を依頼してください。' });
    req.session.householdInvitationId = String(invitation._id);
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store');
    // Strip the token from the address bar before rendering links to other pages.
    return res.redirect('/resident-onboarding');
  } catch (error) { return next(error); }
});

householdInvitationsRouter.get('/resident-onboarding', async (req, res, next) => {
  try {
    const registration = req.user ? await ResidentRegistration.findOne({ user: req.user._id }).lean() : null;
    if (req.user) {
      const application = await JoinApplication.findOne({ applicant: req.user._id, status: { $in: ['pending', 'awaiting_household'] } }).select('association').lean();
      if (application) return res.redirect(`/associations/${application.association}/participation`);
      if (await AssociationMembership.exists({ user: req.user._id, status: 'active' })) return res.redirect('/dashboard');
    }
    const invitationId = req.session.householdInvitationId || registration?.householdInvitation;
    res.set('Cache-Control', 'no-store');
    if (invitationId) {
      const invitation = await loadHouseholdInvitation({ invitationId });
      if (!invitation) {
        delete req.session.householdInvitationId;
        return res.status(409).render('error', { title: '招待を利用できません', message: '招待の有効期限や世帯情報が変更されています。世帯主に再招待を依頼してください。' });
      }
      return res.render('household-invitation', { title: '世帯への招待', invitation, emailMatches: !req.user || normalizeEmail(req.user.email) === invitation.email });
    }
    if (!req.user) return res.redirect('/login');
    const associations = await NeighborhoodAssociation.find({ status: 'active', deletedAt: { $exists: false } }).sort('name').lean();
    return res.render('resident-onboarding', { title: '町内会と世帯への参加', associations, registration });
  } catch (error) { return next(error); }
});

householdInvitationsRouter.post('/household-invitations/:invitationId/accept', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try {
    const registration = await ResidentRegistration.findOne({ user: req.user._id }).lean();
    const authorizedIds = [req.session.householdInvitationId, registration?.householdInvitation].filter(Boolean).map(String);
    if (req.user.isAdmin || !mongoose.isValidObjectId(req.params.invitationId) || !authorizedIds.includes(req.params.invitationId)) throw fail('先に招待メールのリンクを開いてください。', 403);
    const application = await acceptHouseholdInvitation({ invitationId: req.params.invitationId, user: req.user });
    delete req.session.householdInvitationId;
    req.session.notice = '招待を受諾し、世帯に紐付けました。班長または町内会管理者の承認をお待ちください。';
    return res.redirect(`/associations/${application.association}/participation`);
  } catch (error) { return next(error); }
});

householdInvitationsRouter.post('/household-invitations/decline', verifyCsrfToken, (req, res) => {
  delete req.session.householdInvitationId;
  return res.redirect(req.user ? '/dashboard' : '/register');
});

householdInvitationsRouter.post('/associations/:associationId/household/:householdId/invitations/:invitationId/cancel', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try {
    if (![req.params.associationId, req.params.householdId, req.params.invitationId].every(mongoose.isValidObjectId)) throw fail('招待を確認してください。');
    const household = await Household.findOne({ _id: req.params.householdId, association: req.params.associationId, representative: req.user._id, active: true });
    if (!household) throw fail('自分の世帯の招待だけを取り消せます。', 403);
    const result = await Invitation.updateOne({ _id: req.params.invitationId, association: req.params.associationId, household: household._id, invitedBy: req.user._id, status: 'pending' }, { $set: { status: 'cancelled' } });
    if (!result.modifiedCount) throw fail('この招待は既に受諾または取り消し済みです。', 409);
    req.session.notice = '未受諾の招待を取り消しました。';
    return res.redirect(`/profile?tab=household#household-${household._id}`);
  } catch (error) { return next(error); }
});

householdInvitationsRouter.post('/associations/:associationId/household/:householdId/members/:memberId/invite', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try {
    const { associationId, householdId, memberId } = req.params;
    if (![associationId, householdId, memberId].every(mongoose.isValidObjectId)) throw fail('世帯メンバーを確認してください。');
    const household = await Household.findOne({ _id: householdId, association: associationId, representative: req.user._id, active: true }).populate('association', 'name status deletedAt');
    const member = household && await HouseholdMember.findOne({ _id: memberId, household: householdId, association: associationId, isRepresentative: false, user: null });
    if (!member || household.association?.status !== 'active' || household.association.deletedAt || !await AssociationMembership.exists({ association: associationId, user: req.user._id, household: householdId, status: 'active' })) throw fail('参加中の世帯の未紐付けメンバーだけを招待できます。', 403);
    const email = normalizeEmail(req.body.email);
    if (!/^\S+@\S+\.\S+$/.test(email) || email === normalizeEmail(req.user.email)) throw fail('同居人本人のメールアドレスを入力してください。');
    if (await Invitation.exists({ householdMember: memberId, status: 'pending', createdAt: { $gt: new Date(Date.now() - 60000) } })) throw fail('再送は1分以上あけてください。', 429);
    try { assertMailConfigured(); } catch (_error) { throw fail('メール送信の設定が完了していません。町内会管理者に確認してください。', 503); }
    const verification = createHouseholdInvitationToken();
    const invitation = await Invitation.create({ association: associationId, household: householdId, householdMember: memberId, email, invitedBy: req.user._id, tokenDigest: verification.tokenDigest, expiresAt: verification.expiresAt });
    try {
      await sendHouseholdInvitationEmail({ email, token: verification.token, associationName: household.association.name, inviterName: req.user.displayname || req.user.username, memberName: member.name });
    } catch (error) {
      await Invitation.updateOne({ _id: invitation._id, status: 'pending' }, { $set: { status: 'cancelled' } });
      console.error('Household invitation delivery failed', error.message);
      throw fail('招待メールを送信できませんでした。時間をおいて再度お試しください。', 503);
    }
    await Invitation.updateMany({ householdMember: memberId, _id: { $ne: invitation._id }, status: 'pending' }, { $set: { status: 'cancelled' } });
    member.email = email;
    await member.save();
    req.session.notice = `${member.name}さんに招待メールを送信しました。`;
    return res.redirect(`/profile?tab=household#household-${householdId}`);
  } catch (error) { return next(error); }
});

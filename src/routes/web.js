import express from 'express';
import passport from 'passport';
import mongoose from 'mongoose';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { RoleAssignment, RoleDefinition } from '../models/role.js';
import { JoinApplication, Invitation } from '../models/workflow.js';
import { Notification } from '../models/notification.js';
import { QuestionThread } from '../models/questionThread.js';
import { OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { DistrictGroup, Household, HouseholdMember } from '../models/organization.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { User } from '../models/user.js';
import { ResidentRegistration } from '../models/residentRegistration.js';
import { PendingUserRegistration } from '../models/pendingUserRegistration.js';
import { visibleEvents, calendarWindow } from '../services/associationEventService.js';
import { loadAssociationPageData } from '../services/associationPublicPageService.js';
import { loadHouseholdInvitation } from '../services/householdParticipationService.js';
import { deleteNotification, markNotificationRead, syncCompletedNotifications } from '../services/notificationInboxService.js';
import { requireLogin, requireSystemAdmin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { approveAssociation, hideAssociation, permanentlyDeleteAssociation, requestAssociation, restoreAssociation } from '../services/associationService.js';
import { registerUser } from '../services/userService.js';
import { assertMailConfigured, resendVerification, sendVerificationEmail, verifyEmailToken } from '../services/emailVerificationService.js';
import { acceptProfileImage, uploadProfileImage } from '../services/profileImageService.js';
import { requestPasswordReset, isPasswordResetValid, resetPassword } from '../services/passwordResetService.js';
import { changePassword } from '../services/passwordChangeService.js';
import { AssociationGroupMembership } from '../models/associationGroup.js';

export const webRouter = express.Router();

webRouter.use(provideCsrfToken);
const renderPasswordReset = (res, mode, extra = {}) => res.render('password-reset', { title: 'パスワードの再設定', mode, message: null, formError: null, ...extra });
webRouter.use(['/forgot-password', '/reset-password'], (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
webRouter.get('/forgot-password', (req, res) => renderPasswordReset(res, 'request'));
webRouter.post('/forgot-password', verifyCsrfToken, async (req, res) => {
  const message = '登録済みのメールアドレスの場合、再設定リンクを送信しました。メールをご確認ください。';
  if (Date.now() - (req.session.passwordResetRequestedAt || 0) < 60000) return renderPasswordReset(res, 'request', { message });
  req.session.passwordResetRequestedAt = Date.now();
  try { await requestPasswordReset(req.body.email); }
  catch (error) {
    console.error('Password reset email delivery failed');
    return renderPasswordReset(res.status(503), 'request', { formError: '現在メールを送信できません。しばらくしてから再度お試しください。' });
  }
  return renderPasswordReset(res, 'request', { message });
});
webRouter.get('/reset-password', async (req, res, next) => {
  try {
    if (req.query.token !== undefined) {
      req.session.passwordResetToken = /^[a-f0-9]{64}$/.test(String(req.query.token)) ? String(req.query.token) : null;
      return res.redirect('/reset-password');
    }
    return renderPasswordReset(res, await isPasswordResetValid(req.session.passwordResetToken) ? 'reset' : 'invalid');
  } catch (error) { next(error); }
});
webRouter.post('/reset-password', verifyCsrfToken, async (req, res, next) => {
  try {
    const success = await resetPassword({ token: req.session.passwordResetToken, password: req.body.password, confirmation: req.body.passwordConfirmation });
    delete req.session.passwordResetToken;
    if (!success) return renderPasswordReset(res.status(400), 'invalid');
    return req.session.destroy(error => error ? next(error) : renderPasswordReset(res, 'complete', { message: 'パスワードを再設定しました。新しいパスワードでログインしてください。' }));
  } catch (error) {
    if (error.status === 400) return renderPasswordReset(res.status(400), 'reset', { formError: error.message });
    next(error);
  }
});
webRouter.use(async (req, res, next) => {
  try {
    res.locals.currentUser = req.user || null;
    res.locals.notice = req.session.notice || null;
    res.locals.errorMessage = req.session.errorMessage || null;
    res.locals.currentPath = req.path;
    res.locals.currentRoleTags = [];
    res.locals.currentManagerAssociations = [];
    res.locals.currentLeaderAssociations = [];
    res.locals.currentOfficerQuestionBoxes = [];
    res.locals.currentGroupManagers = [];
    res.locals.currentHasAssociationMembership = false;
    res.locals.currentMenuAssociationName = null;
    if (req.user?.isAdmin) {
      res.locals.currentRoleTags.push('システム管理者');
    } else if (req.user?._id) {
      const now = new Date();
      const currentFiscalYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
      const [assignments, leaderAssignments, annualOfficers, activeMembership, groupManagerMemberships] = await Promise.all([
        RoleAssignment.find({
          user: req.user._id,
          startsAt: { $lte: now },
          $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }]
        }).populate({ path: 'role', match: { active: true }, select: 'name permissions' })
          .populate({ path: 'association', match: { status: 'active', deletedAt: { $exists: false } }, select: 'name' }).lean(),
        AnnualLeaderAssignment.find({ representative: req.user._id, fiscalYear: { $gte: currentFiscalYear }, cancelledAt: null })
          .populate('districtGroup', 'name')
          .populate({ path: 'association', match: { status: 'active', deletedAt: { $exists: false } }, select: 'name' })
          .sort({ fiscalYear: 1 }).lean(),
        AnnualOfficer.find({ user: req.user._id, fiscalYear: currentFiscalYear, cancelledAt: null })
          .populate('role', 'name').populate('department', 'name')
          .populate({ path: 'association', match: { status: 'active', deletedAt: { $exists: false } }, select: 'name' }).lean(),
        AssociationMembership.findOne({ user: req.user._id, status: 'active' })
          .populate({ path: 'association', match: { status: 'active', deletedAt: { $exists: false } }, select: 'name' }).lean(),
        AssociationGroupMembership.find({ user: req.user._id, role: 'manager', status: 'active' }).populate({ path: 'group', match: { status: 'active' }, select: 'name association' }).lean()
      ]);
      res.locals.currentGroupManagers = groupManagerMemberships.filter(item => item.group).map(item => ({ _id: item.group._id, name: item.group.name, association: item.group.association }));
      const roleNames = [
        ...assignments.map((item) => item.role?.name).filter(Boolean),
        ...annualOfficers.filter((item) => item.association && item.role?.name).map((item) => `${item.fiscalYear}年度 ${item.role.name}`)
      ];
      const leaderNames = leaderAssignments
        .filter((item) => item.association && item.districtGroup?.name)
        .map((item) => `${item.fiscalYear}年度 ${item.districtGroup.name} 班長`);
      res.locals.currentRoleTags = [...new Set([...roleNames, ...leaderNames])];
      res.locals.currentManagerAssociations = [...new Map(
        assignments
          .filter((item) => item.association && item.role?.permissions?.includes('association.manage'))
          .map((item) => [String(item.association._id), { _id: item.association._id, name: item.association.name }])
      ).values()];
      if (res.locals.currentManagerAssociations.length) {
        const counts = await Promise.all(res.locals.currentManagerAssociations.map(async (item) => [String(item._id), await JoinApplication.countDocuments({ association: item._id, status: 'pending' })]));
        const countMap = new Map(counts);
        res.locals.currentManagerAssociations = res.locals.currentManagerAssociations.map(item => ({ ...item, actionCount: countMap.get(String(item._id)) || 0 }));
      }
      const answerAssociations = [...new Map([
        ...annualOfficers.filter((item) => item.association).map((item) => [String(item.association._id), item.association]),
        ...res.locals.currentManagerAssociations.map((item) => [String(item._id), item])
      ]).values()];
      if (answerAssociations.length) {
        const activeAnswerMemberships = await AssociationMembership.find({ user: req.user._id, status: 'active', association: { $in: answerAssociations.map((item) => item._id) } }).select('association').lean();
        const activeIds = new Set(activeAnswerMemberships.map((item) => String(item.association)));
        const activeAssociations = answerAssociations.filter((item) => activeIds.has(String(item._id)));
        const pendingQuestions = activeAssociations.length ? await QuestionThread.find({ association: { $in: activeAssociations.map((item) => item._id) }, status: 'unanswered' }).select('association').lean() : [];
        res.locals.currentOfficerQuestionBoxes = activeAssociations.map((item) => ({ _id: item._id, name: item.name,
          unansweredCount: pendingQuestions.filter((thread) => String(thread.association) === String(item._id)).length }));
      }
      res.locals.currentLeaderAssociations = [...new Map(
        leaderAssignments
          .filter((item) => item.association && item.fiscalYear === currentFiscalYear)
          .map((item) => [String(item.association._id), { _id: item.association._id, name: item.association.name }])
      ).values()];
      if (res.locals.currentLeaderAssociations.length) {
        const counts = await Promise.all(res.locals.currentLeaderAssociations.map(async (item) => [String(item._id), await JoinApplication.countDocuments({ association: item._id, status: 'pending' })]));
        const countMap = new Map(counts);
        res.locals.currentLeaderAssociations = res.locals.currentLeaderAssociations.map(item => ({ ...item, actionCount: countMap.get(String(item._id)) || 0 }));
      }
      res.locals.currentHasAssociationMembership = Boolean(activeMembership);
      res.locals.currentMenuAssociationName = activeMembership?.association?.name || res.locals.currentOfficerQuestionBoxes[0]?.name || res.locals.currentLeaderAssociations[0]?.name || res.locals.currentManagerAssociations[0]?.name || null;
    }
    delete req.session.notice;
    delete req.session.errorMessage;
    return next();
  } catch (error) {
    return next(error);
  }
});

webRouter.get('/', (req, res) => res.redirect(req.isAuthenticated?.() ? '/dashboard' : '/associations'));

webRouter.get('/associations', async (req, res, next) => {
  try {
    const prefecture = String(req.query.prefecture || '').trim();
    const city = String(req.query.city || '').trim();
    const keyword = String(req.query.keyword || '').trim();
    const filter = { status: 'active', deletedAt: { $exists: false } };
    if (prefecture) filter['address.prefecture'] = new RegExp(prefecture.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (city) filter['address.city'] = new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (keyword) {
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = ['name', 'serviceArea', 'address.street'].map((field) => ({ [field]: new RegExp(escapedKeyword, 'i') }));
    }
    const [associations, locationAssociations] = await Promise.all([
      NeighborhoodAssociation.find(filter).sort('name').lean(),
      NeighborhoodAssociation.find({ status: 'active', deletedAt: { $exists: false } }).select('address.prefecture address.city').lean(),
    ]);
    const locations = {};
    locationAssociations.forEach((association) => {
      const selectedPrefecture = String(association.address?.prefecture || '').trim();
      const selectedCity = String(association.address?.city || '').trim();
      if (!selectedPrefecture || !selectedCity) return;
      if (!locations[selectedPrefecture]) locations[selectedPrefecture] = new Set();
      locations[selectedPrefecture].add(selectedCity);
    });
    const prefectures = Object.keys(locations).sort((a, b) => a.localeCompare(b, 'ja'));
    const citiesByPrefecture = Object.fromEntries(prefectures.map((name) => [name, [...locations[name]].sort((a, b) => a.localeCompare(b, 'ja'))]));
    return res.render('association-list', { title: '町内会一覧', associations, filters: { prefecture, city, keyword }, prefectures, citiesByPrefecture });
  } catch (error) { return next(error); }
});

webRouter.get('/associations/create/start', (req, res) => {
  req.session.registrationChoice = { purpose: 'create' };
  return res.redirect(req.isAuthenticated?.() ? '/associations/new' : '/login');
});

webRouter.get('/associations/create/register', (req, res) => {
  req.session.registrationChoice = { purpose: 'create' };
  return res.redirect(req.isAuthenticated?.() ? '/associations/new' : '/register');
});

webRouter.get('/associations/:associationId/register/start', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.redirect('/associations');
    const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
    if (!association) return res.redirect('/associations');
    req.session.registrationChoice = { purpose: 'join', associationId: String(association._id) };
    return res.redirect(req.isAuthenticated?.() ? `/associations/${association._id}/join` : (req.query.login === '1' ? '/login' : '/register'));
  } catch (error) { return next(error); }
});

webRouter.get('/login', (req, res) => {
  if (req.isAuthenticated?.()) return res.redirect('/dashboard');
  return res.render('login', { title: 'ログイン' });
});

webRouter.use('/register', async (req, res, next) => {
  try {
    res.locals.invitation = req.session.householdInvitationId ? await loadHouseholdInvitation({ invitationId: req.session.householdInvitationId }) : null;
    return next();
  } catch (error) { return next(error); }
});

webRouter.get('/register', async (req, res, next) => {
  try {
    if (req.isAuthenticated?.()) {
      if (req.session.householdInvitationId) return res.redirect('/resident-onboarding');
      if (req.session.registrationChoice?.purpose === 'create') return res.redirect('/associations/new');
      if (req.session.registrationChoice?.purpose === 'join') return res.redirect(`/associations/${req.session.registrationChoice.associationId}/join`);
      return res.redirect('/dashboard');
    }
    const invitation = req.session.householdInvitationId ? await loadHouseholdInvitation({ invitationId: req.session.householdInvitationId }) : null;
    const choice = req.session.registrationChoice;
    if (!invitation && !choice) return res.redirect('/associations');
    const association = choice?.purpose === 'join' ? await NeighborhoodAssociation.findOne({ _id: choice.associationId, status: 'active', deletedAt: { $exists: false } }).lean() : null;
    if (choice?.purpose === 'join' && !association) return res.redirect('/associations');
    return res.render('register', { title: '新規会員登録', values: invitation ? { email: invitation.email, displayname: invitation.member.name, residentMode: 'general' } : {}, invitation, association, registrationPurpose: choice?.purpose });
  } catch (error) { return next(error); }
});

webRouter.post('/register', verifyCsrfToken, async (req, res, next) => {
  let choice, invitation, association;
  try {
    choice = req.session.registrationChoice;
    invitation = req.session.householdInvitationId ? await loadHouseholdInvitation({ invitationId: req.session.householdInvitationId }) : null;
    if (!invitation && !choice) return res.redirect('/associations');
    association = choice?.purpose === 'join' ? await NeighborhoodAssociation.findOne({ _id: choice.associationId, status: 'active', deletedAt: { $exists: false } }).lean() : null;
    if (choice?.purpose === 'join' && !association) return res.redirect('/associations');
    res.locals.association = association;
    res.locals.registrationPurpose = choice?.purpose;
    res.locals.invitation = invitation;
  } catch (error) { return next(error); }
  const values = {
    username: String(req.body.username || '').trim(),
    displayname: String(req.body.displayname || '').trim(),
    email: String(req.body.email || '').trim().toLowerCase(),
    residentMode: String(req.body.residentMode || 'representative'),
    householdHeadEmail: String(req.body.householdHeadEmail || '').trim().toLowerCase()
  };
  if (choice?.purpose === 'create' && !invitation) values.residentMode = 'representative';
  const password = String(req.body.password || '');
  if (password !== String(req.body.passwordConfirmation || '')) {
    return res.status(400).render('register', { title: '新規会員登録', values, formError: '確認用パスワードが一致しません。' });
  }
  try {
    if (req.session.householdInvitationId && (!invitation || invitation.email !== values.email)) {
      return res.status(400).render('register', { title: '新規会員登録', values, formError: '招待が無効、またはメールアドレスが招待先と異なります。招待リンクを再度確認してください。' });
    }
    if (invitation && req.body.acceptInvitation !== 'on') return res.status(400).render('register', { title: '新規会員登録', values, formError: '招待を受諾することにチェックしてください。' });
    if (invitation) values.residentMode = 'general';
    try {
      assertMailConfigured();
    } catch (_mailConfigError) {
      return res.status(503).render('register', {
        title: '新規会員登録', values,
        formError: '現在メール送信の準備中です。管理者がメール設定を完了してから、もう一度お試しください。'
      });
    }
    const { user, verificationToken } = await registerUser({ ...values, password, householdInvitation: invitation?._id, association: association?._id, registrationPurpose: choice?.purpose });
    try {
      await sendVerificationEmail({ user, token: verificationToken });
      return res.render('check-email', { title: '確認メールを送信しました', email: user.email, deliveryFailed: false });
    } catch (mailError) {
      console.error('Verification email delivery failed', mailError.message);
      return res.status(503).render('check-email', { title: '確認メールを送信できませんでした', email: user.email, deliveryFailed: true });
    }
  } catch (error) {
    const messages = {
      invalid_registration_fields: 'ユーザー名と有効なメールアドレスを入力してください。',
      password_too_short: 'パスワードは8文字以上で入力してください。',
      account_already_exists: '同じユーザー名またはメールアドレスのアカウントがすでに存在します。',
      invalid_household_head_email: '一般メンバーとして登録する場合は、同居する世帯主の有効なメールアドレスを入力してください。'
    };
    if (messages[error.message] || error?.code === 11000 || error?.name === 'UserExistsError') {
      return res.status(error.status || 409).render('register', {
        title: '新規会員登録', values,
        formError: messages[error.message] || '同じユーザー名またはメールアドレスのアカウントがすでに存在します。'
      });
    }
    return next(error);
  }
});

webRouter.get('/verify-email', async (req, res, next) => {
  try {
    const user = await verifyEmailToken(req.query.token);
    if (user?.$locals?.householdParticipationSubmitted) delete req.session.householdInvitationId;
    return res.status(user ? 200 : 400).render('email-verified', {
      title: user ? '登録が完了しました' : '確認リンクを利用できません',
      verified: Boolean(user),
      householdParticipationSubmitted: Boolean(user?.$locals?.householdParticipationSubmitted),
      householdParticipationError: user?.$locals?.householdParticipationError || null
    });
  } catch (error) {
    return next(error);
  }
});

webRouter.post('/verification-email/resend', verifyCsrfToken, async (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  try {
    let deliveryFailed = false;
    try {
      await resendVerification(email);
    } catch (mailError) {
      deliveryFailed = true;
      console.error('Verification email resend failed', mailError.message);
    }
    // Always use a generic result so this endpoint does not reveal accounts.
    return res.status(deliveryFailed ? 503 : 200).render('check-email', {
      title: deliveryFailed ? '確認メールを送信できませんでした' : '確認メールをご確認ください',
      email,
      deliveryFailed
    });
  } catch (error) {
    return next(error);
  }
});

webRouter.post('/login', verifyCsrfToken, (req, res, next) => {
  passport.authenticate('local', (error, user, info) => {
    if (error) return next(error);
    if (!user) {
      req.session.errorMessage = info?.code === 'email_not_verified'
        ? 'メールアドレスの確認が完了していません。確認メールのリンクを開いてください。'
        : 'メールアドレスまたはユーザー名、パスワードを確認してください。';
      return res.redirect('/login');
    }
    return req.logIn(user, async (loginError) => {
      if (loginError) return next(loginError);
      try {
        const registration = await ResidentRegistration.findOne({ user: user._id }).lean();
        if (req.session.registrationChoice?.purpose === 'create') return res.redirect('/associations/new');
        if (req.session.registrationChoice?.purpose === 'join') return res.redirect(`/associations/${req.session.registrationChoice.associationId}/join`);
        if (registration?.registrationPurpose === 'create') {
          req.session.registrationChoice = { purpose: 'create' };
          return res.redirect('/associations/new');
        }
        if (registration?.association) return res.redirect(`/associations/${registration.association}/join`);
        return res.redirect(req.session.householdInvitationId || registration?.householdInvitation || registration?.residentMode === 'general' ? '/resident-onboarding' : '/dashboard');
      } catch (registrationError) { return next(registrationError); }
    });
  })(req, res, next);
});

webRouter.post('/logout', requireLogin, verifyCsrfToken, (req, res, next) => {
  req.logout((error) => {
    if (error) return next(error);
    return req.session.destroy((sessionError) => {
      if (sessionError) return next(sessionError);
      res.clearCookie('chounaikai.sid');
      return res.redirect('/login');
    });
  });
});

webRouter.get('/profile', requireLogin, async (req, res, next) => {
  try {
    const households = await Household.find({ representative: req.user._id, active: true })
      .populate('association', 'name status')
      .populate('districtGroup', 'name')
      .sort({ createdAt: 1 })
      .lean();
    const visibleHouseholds = households.filter((household) => household.association);
    const [members, memberships] = await Promise.all([
      HouseholdMember.find({ household: { $in: visibleHouseholds.map((household) => household._id) }, endsAt: null }).sort({ isRepresentative: -1, birthDate: 1 }).lean(),
      AssociationMembership.find({ user: req.user._id, status: 'active' }).populate({ path: 'association', match: { status: 'active', deletedAt: { $exists: false } }, select: 'name' }).lean()
    ]);
    const accountIds = members.map((member) => member.user).filter(Boolean);
    const accounts = accountIds.length ? await User.find({ _id: { $in: accountIds } }).select('displayname username email birth_date sex').lean() : [];
    const accountsById = new Map(accounts.map((account) => [String(account._id), account]));
    members.forEach((member) => {
      if (member.user) {
        const account = accountsById.get(String(member.user));
        member.linkedAccountMissing = !account;
        member.user = account || null;
      }
      if (member.isRepresentative && String(member.user?._id || member.user || '') === String(req.user._id)) member.name = req.user.displayname || req.user.username;
    });
    const membersByHousehold = members.reduce((result, member) => {
      (result[String(member.household)] ||= []).push(member);
      return result;
    }, {});
    const registeredAssociationIds = new Set(visibleHouseholds.map((household) => String(household.association._id)));
    const unregisteredMemberships = memberships.filter((membership) => membership.association && !membership.household && !registeredAssociationIds.has(String(membership.association._id)));
    const districtGroups = await DistrictGroup.find({ association: { $in: unregisteredMemberships.map((membership) => membership.association._id) }, active: true }).sort({ sortOrder: 1, name: 1 }).lean();
    const districtsByAssociation = districtGroups.reduce((result, district) => {
      (result[String(district.association)] ||= []).push(district);
      return result;
    }, {});
    const availableHouseholdRegistrations = unregisteredMemberships.map((membership) => ({ membership, districtGroups: districtsByAssociation[String(membership.association._id)] || [] }));
    const [householdLinkApplications, householdInvitations, affiliatedHouseholds, ownHouseholdMembers] = await Promise.all([
      JoinApplication.find({ household: { $in: visibleHouseholds.map((household) => household._id) }, status: 'awaiting_household' }).populate('applicant', 'displayname username email').lean(),
      Invitation.find({ household: { $in: visibleHouseholds.map((household) => household._id) } }).select('householdMember status expiresAt').sort({ createdAt: -1 }).lean(),
      Household.find({ _id: { $in: memberships.map((membership) => membership.household).filter(Boolean) }, representative: { $ne: req.user._id }, active: true }).populate('association', 'name').populate('districtGroup', 'name').populate('representative', 'displayname username').lean(),
      HouseholdMember.find({ user: req.user._id, household: { $in: memberships.map((membership) => membership.household).filter(Boolean) } }).lean()
    ]);
    const invitationByMember = householdInvitations.reduce((result, invitation) => { result[String(invitation.householdMember)] ||= invitation; return result; }, {});
    const activeHouseholdIds = memberships.map((membership) => String(membership.household || ''));
    return res.render('profile', { title: 'プロフィール', values: res.locals.currentUser, formError: null, households: visibleHouseholds, membersByHousehold, availableHouseholdRegistrations, householdLinkApplications, invitationByMember, activeHouseholdIds, affiliatedHouseholds: affiliatedHouseholds.filter(household => household.association), ownHouseholdMembers });
  } catch (error) { return next(error); }
});

webRouter.post('/profile/password', requireLogin, verifyCsrfToken, async (req, res, next) => {
  if (Date.now() - (req.session.passwordChangeAttemptAt || 0) < 3000) {
    req.session.errorMessage = '少し待ってから再度お試しください。';
    return res.redirect('/profile?tab=account#password-change');
  }
  req.session.passwordChangeAttemptAt = Date.now();
  try {
    await changePassword({ userId: req.user._id, currentPassword: req.body.currentPassword, password: req.body.password, confirmation: req.body.passwordConfirmation });
    req.session.notice = 'パスワードを変更しました。';
    delete req.session.passwordResetToken;
    return res.redirect('/profile?tab=account#password-change');
  } catch (error) {
    if (error.status === 400) {
      req.session.errorMessage = error.message;
      return res.redirect('/profile?tab=account#password-change');
    }
    return next(error);
  }
});

webRouter.post('/profile', requireLogin, acceptProfileImage, verifyCsrfToken, async (req, res, next) => {
  const values = {
    displayname: String(req.body.displayname || '').trim(),
    email: String(req.body.email || '').trim().toLowerCase(),
    birth_date: String(req.body.birth_date || '').trim(),
    sex: String(req.body.sex || '').trim()
  };
  const renderError = (message, status = 400) => res.status(status).render('profile', {
    title: 'プロフィール', values: { ...req.user.toObject(), ...values }, formError: message, households: [], membersByHousehold: {}, availableHouseholdRegistrations: []
  });
  if (!values.displayname || !/^\S+@\S+\.\S+$/.test(values.email)) return renderError('氏名と有効なメールアドレスを入力してください。');
  const parsedBirthDate = values.birth_date ? new Date(`${values.birth_date}T00:00:00.000Z`) : null;
  if (values.birth_date && (!/^\d{4}-\d{2}-\d{2}$/.test(values.birth_date) || Number.isNaN(parsedBirthDate.getTime()) || parsedBirthDate.toISOString().slice(0, 10) !== values.birth_date)) return renderError('生年月日を正しく入力してください。');
  if (!['', 'male', 'female', 'other', 'unspecified'].includes(values.sex)) return renderError('性別を正しく選択してください。');
  try {
    const duplicate = await User.exists({ _id: { $ne: req.user._id }, email: values.email });
    if (duplicate) return renderError('このメールアドレスは既に使用されています。', 409);
    const avatar = await uploadProfileImage(req.file, req.user._id);
    const update = {
      displayname: values.displayname, email: values.email,
      birth_date: parsedBirthDate,
      sex: values.sex || 'unspecified', update_date: new Date()
    };
    if (avatar) update.avatar = avatar;
    await User.updateOne({ _id: req.user._id }, { $set: update });
    const representativeHouseholds = await HouseholdMember.find({ user: req.user._id, isRepresentative: true }).distinct('household');
    await Promise.all([
      HouseholdMember.updateMany({ user: req.user._id }, { $set: { name: values.displayname, email: values.email, ...(parsedBirthDate ? { birthDate: parsedBirthDate } : {}), ...(values.sex ? { gender: values.sex } : {}) } }),
      Household.updateMany({ _id: { $in: representativeHouseholds }, representative: req.user._id }, { $set: { displayName: `${values.displayname}世帯` } })
    ]);
    Object.assign(req.user, update);
    req.session.notice = 'プロフィールを更新しました。';
    return res.redirect('/profile');
  } catch (error) {
    if (error?.status === 503) return renderError(error.message, 503);
    if (error?.code === 11000) return renderError('このメールアドレスは既に使用されています。', 409);
    return next(error);
  }
});

webRouter.get('/dashboard', requireLogin, async (req, res, next) => {
  try {
    await syncCompletedNotifications({ recipient: req.user._id });
    const memberships = await AssociationMembership.find({ user: req.user._id, status: 'active' })
      .populate({ path: 'association', match: { deletedAt: { $exists: false }, status: 'active' } })
      .populate('districtGroup', 'name')
      .sort({ startedAt: -1 })
      .lean();
    const visibleMemberships = memberships.filter((item) => item.association);
    const now = new Date(), fiscalYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
    const [officerAssignments, leaderAssignments] = await Promise.all([
      AnnualOfficer.find({ user: req.user._id, association: { $in: visibleMemberships.map((item) => item.association._id) }, fiscalYear, cancelledAt: null }).select('association').lean(),
      AnnualLeaderAssignment.find({ representative: req.user._id, association: { $in: visibleMemberships.map((item) => item.association._id) }, fiscalYear, cancelledAt: null }).select('association').lean()
    ]);
    const officerAssociationIds = new Set(officerAssignments.map((item) => String(item.association)));
    const myAnsweredThreads = await QuestionThread.find({ association: { $in: visibleMemberships.map((item) => item.association._id) }, author: req.user._id, status: { $in: ['unanswered', 'answered'] }, lastOfficerAt: { $exists: true } }).select('association lastOfficerAt residentReadAt').lean();
    const unreadAnnouncements = await OfficerAnnouncementReceipt.find({ association: { $in: visibleMemberships.map((item) => item.association._id) }, recipient: req.user._id, readAt: null }).populate('announcement', 'channel districtGroup associationGroup').select('association announcement').lean();
    const questionBoxes = visibleMemberships.map((item) => {
      const id = String(item.association._id);
      return { association: item.association,
        unreadAnswers: myAnsweredThreads.filter((thread) => String(thread.association) === id && (!thread.residentReadAt || new Date(thread.lastOfficerAt) > new Date(thread.residentReadAt))).length };
    });
    const announcementBoxes = visibleMemberships.map((item) => ({ association: item.association,
      unreadCount: unreadAnnouncements.filter(receipt => String(receipt.association) === String(item.association._id) && receipt.announcement && (receipt.announcement.channel || 'resident') === 'resident').length }));
    const officerNetworkBoxes = visibleMemberships.filter(item => res.locals.currentOfficerQuestionBoxes.some(officer => String(officer._id) === String(item.association._id)))
      .map(item => ({ association: item.association, unreadCount: unreadAnnouncements.filter(receipt => String(receipt.association) === String(item.association._id) && receipt.announcement?.channel === 'officer').length }));
    const districtMessageBoxes = visibleMemberships.filter(item => item.districtGroup).map(item => ({ association: item.association, districtGroup: item.districtGroup,
      unreadCount: unreadAnnouncements.filter(receipt => String(receipt.association) === String(item.association._id) && receipt.announcement?.channel === 'district' && String(receipt.announcement.districtGroup) === String(item.districtGroup._id)).length }));
    const groupMemberships = await AssociationGroupMembership.find({ association: { $in: visibleMemberships.map(item => item.association._id) }, user: req.user._id, status: 'active' }).populate({ path: 'group', match: { status: 'active' }, select: 'name association' }).lean();
    const groupMessageBoxes = groupMemberships.filter(item => item.group).map(item => ({ group: item.group, unreadCount: unreadAnnouncements.filter(receipt => receipt.announcement?.channel === 'association_group' && String(receipt.announcement.associationGroup) === String(item.group._id)).length }));
    const leaderAssociationIds = new Set(leaderAssignments.map((item) => String(item.association)));
    visibleMemberships.forEach((membership) => {
      const associationId = String(membership.association._id), memberTags = [];
      if (officerAssociationIds.has(associationId)) memberTags.push('役員');
      if (leaderAssociationIds.has(associationId)) memberTags.push('班長');
      membership.memberTags = memberTags.length ? memberTags : ['メンバー'];
    });
    const applications = await NeighborhoodAssociation.find({ requestedBy: req.user._id, status: 'pending', deletedAt: { $exists: false } }).sort({ createdAt: -1 }).lean();
    const pendingJoins = await JoinApplication.find({ applicant: req.user._id, status: { $in: ['pending', 'awaiting_household'] } }).select('association status source').lean();
    const excludedIds = [...visibleMemberships.map((item) => item.association._id), ...pendingJoins.map((item) => item.association)];
    const [availableAssociations, unreadNotifications, readNotifications, unreadNotificationCount] = await Promise.all([
      NeighborhoodAssociation.find({ status: 'active', deletedAt: { $exists: false }, _id: { $nin: excludedIds } }).sort('name').lean(),
      Notification.find({ recipient: req.user._id, readAt: null }).populate('association', 'name').sort({ createdAt: -1 }).limit(20).lean(),
      Notification.find({ recipient: req.user._id, readAt: { $ne: null } }).populate('association', 'name').sort({ createdAt: -1 }).limit(20).lean(),
      Notification.countDocuments({ recipient: req.user._id, readAt: null })
    ]);
    const notifications = [...unreadNotifications, ...readNotifications].slice(0, 20);
    const residentRegistration = await ResidentRegistration.findOne({ user: req.user._id }).lean();
    for (const notification of notifications) {
      if (notification.type === 'withdrawal_leader_requested' && notification.association && res.locals.currentLeaderAssociations.some(association => String(association._id) === String(notification.association._id))) {
        notification.actionUrl = `/associations/${notification.association._id}/leader?tab=withdrawals#withdrawal-${notification.relatedId}`;
        notification.actionLabel = '班長メニューの退会申請を開く';
      } else if (['withdrawal_head_requested', 'withdrawal_approved', 'withdrawal_rejected'].includes(notification.type)) {
        notification.actionUrl = '/profile/withdrawals';
        notification.actionLabel = '退会申請を確認';
      } else if (notification.type === 'question_answered' && notification.association && notification.relatedId) {
        notification.actionUrl = `/associations/${notification.association._id}/questions?open=own-${notification.relatedId}`;
        notification.actionLabel = '回答を確認';
      } else if (['officer_announcement', 'officer_announcement_reminder'].includes(notification.type) && notification.association && notification.relatedId) {
        notification.actionUrl = `/associations/${notification.association._id}/announcements/${notification.relatedId}`;
        notification.actionLabel = '連絡を確認';
      } else if (['officer_network', 'officer_network_reminder'].includes(notification.type) && notification.association && notification.relatedId) {
        notification.actionUrl = `/associations/${notification.association._id}/officer-network/inbox/${notification.relatedId}`;
        notification.actionLabel = '役員間の連絡を確認';
      } else if (['district_message', 'district_message_reminder'].includes(notification.type) && notification.association && notification.relatedId) {
        notification.actionUrl = `/associations/${notification.association._id}/district-messages/inbox/${notification.relatedId}`;
        notification.actionLabel = '班内の連絡を確認';
      }
      if (notification.type === 'join_application_received' && notification.association && res.locals.currentLeaderAssociations.some(association => String(association._id) === String(notification.association._id))) {
        notification.actionUrl = `/associations/${notification.association._id}/leader?tab=applications#application-${notification.relatedId}`;
      }
    }
    const financeReports = visibleMemberships.filter((item) => item.association.financePublic).map((item) => ({ association: item.association }));
    const eventWindow = calendarWindow(req.query.month);
    const associationEvents = await visibleEvents(visibleMemberships.map(item => item.association._id), { now: eventWindow.first });
    return res.render('dashboard', { title: '町内会ホーム', memberships: visibleMemberships, applications, pendingJoins, availableAssociations, notifications, unreadNotificationCount, notificationInboxOpen: req.query.notifications === 'open', residentRegistration, questionBoxes, financeReports, announcementBoxes, officerNetworkBoxes, districtMessageBoxes, groupMessageBoxes, associationEvents, eventMonths: eventWindow.months, eventWindow });
  } catch (error) {
    return next(error);
  }
});

webRouter.post('/notifications/:notificationId/read', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try {
    await markNotificationRead({ notificationId: req.params.notificationId, recipient: req.user._id });
    return res.redirect('/dashboard?notifications=open');
  } catch (error) { return next(error); }
});

webRouter.post('/notifications/:notificationId/delete', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try {
    await deleteNotification({ notificationId: req.params.notificationId, recipient: req.user._id });
    return res.redirect('/dashboard?notifications=open');
  } catch (error) { return next(error); }
});

webRouter.get('/admin', requireSystemAdmin, async (req, res, next) => {
  try {
    const [associations, activeCount, pendingCount, userCount, pendingRegistrations, registrations] = await Promise.all([
      NeighborhoodAssociation.find({}).populate('group', 'group_name').populate('requestedBy', 'displayname username email').sort({ createdAt: -1 }).lean(),
      NeighborhoodAssociation.countDocuments({ status: 'active', deletedAt: { $exists: false } }),
      NeighborhoodAssociation.countDocuments({ status: 'pending', deletedAt: { $exists: false } }),
      mongoose.connection.collection('users').countDocuments({ unsubscribe_date: { $exists: false } }),
      PendingUserRegistration.find({ expiresAt: { $gt: new Date() } }).select('username email registrationPurpose createdAt expiresAt').sort({ createdAt: -1 }).lean(),
      ResidentRegistration.find({}).select('user').lean()
    ]);
    const inactiveUsers = await User.find({ _id: { $in: registrations.map((item) => item.user) }, unsubscribe_date: { $type: 'date' } }).select('username email groups unsubscribe_date').lean();
    const inactiveUserIds = inactiveUsers.map((user) => user._id);
    const [linkedMemberships, linkedRoles, linkedApplications] = await Promise.all([
      AssociationMembership.distinct('user', { user: { $in: inactiveUserIds } }),
      RoleAssignment.distinct('user', { user: { $in: inactiveUserIds } }),
      NeighborhoodAssociation.distinct('requestedBy', { requestedBy: { $in: inactiveUserIds } })
    ]);
    const linkedIds = new Set([...linkedMemberships, ...linkedRoles, ...linkedApplications].map(String));
    const inactiveRegistrants = inactiveUsers.map((user) => ({ ...user, canRemove: !user.groups?.length && !linkedIds.has(String(user._id)) }));
    return res.render('admin-dashboard', {
      title: '管理者メニュー',
      associations, pendingRegistrations, inactiveRegistrants,
      stats: { total: associations.filter((item) => !item.deletedAt).length, active: activeCount, pending: pendingCount, users: userCount }
    });
  } catch (error) {
    return next(error);
  }
});

webRouter.post('/admin/pending-registrations/:registrationId/delete', requireSystemAdmin, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.registrationId)) return res.redirect('/admin');
    const result = await PendingUserRegistration.deleteOne({ _id: req.params.registrationId });
    req.session.notice = result.deletedCount ? '未完了の会員登録を削除しました。' : '対象の登録はすでにありません。';
    return res.redirect('/admin');
  } catch (error) { return next(error); }
});

webRouter.post('/admin/inactive-registrants/:userId/delete', requireSystemAdmin, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) return res.redirect('/admin');
    const user = await User.findOne({ _id: req.params.userId, unsubscribe_date: { $type: 'date' } }).select('groups').lean();
    if (!user || user.groups?.length) return res.status(409).render('error', { title: '削除できません', message: '共通システムに利用中の所属があるユーザーは削除できません。' });
    const [membership, role, association, registration] = await Promise.all([
      AssociationMembership.exists({ user: user._id }), RoleAssignment.exists({ user: user._id }),
      NeighborhoodAssociation.exists({ requestedBy: user._id }), ResidentRegistration.exists({ user: user._id })
    ]);
    if (!registration || membership || role || association) return res.status(409).render('error', { title: '削除できません', message: 'このユーザーに紐づく町内会の記録が残っています。先に対象の申請を確認してください。' });
    await User.deleteOne({ _id: user._id, unsubscribe_date: { $type: 'date' } });
    await ResidentRegistration.deleteOne({ user: user._id });
    req.session.notice = '共通システムで削除済みの孤立ユーザーを整理しました。';
    return res.redirect('/admin');
  } catch (error) { return next(error); }
});

const hasActiveAssociation = (userId) => AssociationMembership.exists({ user: userId, status: 'active' });

webRouter.get('/associations/new', requireLogin, async (req, res, next) => {
  if (req.session.registrationChoice?.purpose !== 'create') return res.redirect('/associations');
  if (req.user.isAdmin) return res.status(403).render('error', { title: '申請できません', message: 'システム管理者は町内会管理者の申請者にはなれません。' });
  try {
    if (await hasActiveAssociation(req.user._id)) return res.redirect('/dashboard');
    return res.render('association-new', { title: '町内会の新規作成申請', values: {} });
  } catch (error) { return next(error); }
});

webRouter.post('/associations', requireLogin, verifyCsrfToken, async (req, res, next) => {
  if (req.session.registrationChoice?.purpose !== 'create') return res.status(403).render('error', { title: '申請できません', message: '町内会一覧から新規作成を選択してください。' });
  if (req.user.isAdmin) return res.status(403).render('error', { title: '申請できません', message: 'システム管理者は町内会管理者の申請者にはなれません。' });
  try {
    if (await hasActiveAssociation(req.user._id)) return res.redirect('/dashboard');
  } catch (error) { return next(error); }
  const values = {
    name: String(req.body.name || '').trim(),
    groupName: String(req.body.groupName || '').trim(),
    publicSlug: String(req.body.publicSlug || '').trim().toLowerCase(),
    address: { postalCode: String(req.body.postalCode || '').replace(/[^0-9]/g, ''), prefecture: String(req.body.prefecture || '').trim(), city: String(req.body.city || '').trim(), street: String(req.body.street || '').trim() },
    serviceArea: String(req.body.serviceArea || '').trim(),
    introduction: String(req.body.introduction || '').trim(),
    contact: { name: String(req.body.contactName || '').trim(), email: String(req.body.contactEmail || '').trim(), phone: String(req.body.contactPhone || '').trim() }
  };
  if (!values.name || !values.groupName || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(values.publicSlug)) {
    return res.status(400).render('association-new', {
      title: '町内会の新規作成申請', values,
      formError: '名称、共通グループ名、公開URL名を正しく入力してください。'
    });
  }
  try {
    await requestAssociation({
      actor: req.user,
      input: values,
      requestMeta: { requestId: req.get('x-request-id'), ip: req.ip }
    });
    delete req.session.registrationChoice;
    req.session.notice = '町内会の新規作成を申請しました。システム管理者の承認をお待ちください。';
    return res.redirect('/dashboard');
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).render('association-new', {
        title: '町内会の新規作成申請', values,
        formError: '同じ共通グループ名または公開URL名がすでに使われています。'
      });
    }
    return next(error);
  }
});

webRouter.post('/admin/associations/:associationId/approve', requireSystemAdmin, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(404).render('error', { title: '町内会が見つかりません', message: '指定された町内会を確認できませんでした。' });
    const association = await NeighborhoodAssociation.findById(req.params.associationId);
    if (!association) return res.status(404).render('error', { title: '町内会が見つかりません', message: '指定された町内会を確認できませんでした。' });
    await approveAssociation({ association, actor: req.user, requestMeta: { requestId: req.get('x-request-id'), ip: req.ip } });
    req.session.notice = `「${association.name}」を承認し、申請者を町内会管理者にしました。`;
    return res.redirect('/admin');
  } catch (error) { return next(error); }
});

webRouter.post('/admin/associations/:associationId/delete', requireSystemAdmin, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(404).render('error', { title: '町内会が見つかりません', message: '指定された町内会を確認できませんでした。' });
    const association = await NeighborhoodAssociation.findById(req.params.associationId);
    if (!association) return res.status(404).render('error', { title: '町内会が見つかりません', message: '指定された町内会を確認できませんでした。' });
    if (req.body.deleteMode === 'permanent') {
      await permanentlyDeleteAssociation({ association });
      req.session.notice = `「${association.name}」を完全に削除しました。`;
    } else {
      await hideAssociation({ association, actor: req.user, requestMeta: { requestId: req.get('x-request-id'), ip: req.ip } });
      req.session.notice = `「${association.name}」を非表示にしました。`;
    }
    return res.redirect('/admin');
  } catch (error) { return next(error); }
});

webRouter.post('/admin/associations/:associationId/restore', requireSystemAdmin, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(404).render('error', { title: '町内会が見つかりません', message: '指定された町内会を確認できませんでした。' });
    const association = await NeighborhoodAssociation.findById(req.params.associationId);
    if (!association) return res.status(404).render('error', { title: '町内会が見つかりません', message: '指定された町内会を確認できませんでした。' });
    await restoreAssociation({ association, actor: req.user, requestMeta: { requestId: req.get('x-request-id'), ip: req.ip } });
    req.session.notice = `「${association.name}」を再表示しました。`;
    return res.redirect('/admin');
  } catch (error) { return next(error); }
});

webRouter.get('/associations/:associationId', requireLogin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(404).render('error', { title: '町内会が見つかりません', message: '指定された町内会を確認できませんでした。' });
    const association = await NeighborhoodAssociation.findById(req.params.associationId).populate('group', 'group_name').populate('requestedBy', 'displayname username email').lean();
    if (!association) return res.status(404).render('error', { title: '町内会が見つかりません', message: '指定された町内会を確認できませんでした。' });
    const [membership, assignment] = await Promise.all([
      AssociationMembership.findOne({ association: association._id, user: req.user._id, status: 'active' }).lean(),
      RoleAssignment.findOne({ association: association._id, user: req.user._id, $or: [{ endsAt: null }, { endsAt: { $exists: false } }] }).populate({ path: 'role', match: { active: true, permissions: 'association.manage' } }).lean()
    ]);
    const isApplicant = String(association.requestedBy?._id || association.requestedBy) === String(req.user._id);
    if ((!membership && !req.user.isAdmin && !isApplicant) || (association.deletedAt && !req.user.isAdmin)) return res.status(404).render('error', { title: '町内会が見つかりません', message: '指定された町内会を確認できませんでした。' });
    const pageData = association.status === 'active' && !association.deletedAt ? await loadAssociationPageData(association, { publicOnly: false, month: req.query.month }) : null;
    return res.render('association-detail', { title: association.name, association, membership, canManage: Boolean(req.user.isAdmin || assignment?.role), pageData });
  } catch (error) {
    return next(error);
  }
});

webRouter.get('/associations/:associationId/officers', requireLogin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) throw Object.assign(new Error('町内会を確認できません。'), { status: 404 });
    const now = new Date(), defaultYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
    const fiscalYear = Number(req.query.year || defaultYear);
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2200) throw Object.assign(new Error('年度を確認してください。'), { status: 400 });
    const [association, membership] = await Promise.all([
      NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean(),
      AssociationMembership.findOne({ association: req.params.associationId, user: req.user._id, status: 'active' }).lean()
    ]);
    if (!association || (!membership && !req.user.isAdmin)) return res.status(404).render('error', { title: '町内会が見つかりません', message: '指定された町内会を確認できませんでした。' });
    const officers = await AnnualOfficer.find({ association: association._id, fiscalYear, cancelledAt: null }).populate('user', 'displayname username avatar').populate('role', 'name').populate('department', 'name').sort({ createdAt: 1 }).lean();
    return res.render('association-public-officers', { title: `${association.name}の役員`, association, fiscalYear, officers });
  } catch (error) { return next(error); }
});

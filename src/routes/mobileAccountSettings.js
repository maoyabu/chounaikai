import { changePassword } from '../services/passwordChangeService.js';
import { loadOwnWithdrawals } from './withdrawals.js';
import { requestWithdrawal, confirmWithdrawal, cancelWithdrawal } from '../services/withdrawalService.js';
import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { loadOwnDisclosureRows, saveOwnDisclosure } from './disclosure.js';
import { disclosureFields, disclosureLevels } from '../services/disclosurePolicy.js';
import { currentFiscalYear } from '../services/officerDisclosureService.js';
const handle = callback => async (req, res, next) => { try { await callback(req, res); } catch (error) { next(error); } };
export const mobileDisclosureRow = row => ({
  id: String(row.association._id), associationName: row.association.name,
  confirmed: Boolean(row.consent?.confirmedAt && row.consent.fiscalYear === currentFiscalYear()),
  policyRevision: row.association.officerDisclosureHistory?.length || 0,
  fields: disclosureFields.map(([id, label]) => ({
    id, label, value: row.effective[id], maximum: disclosureLevels.find(([key]) => key === row.policy[id])[1],
    options: disclosureLevels.slice(0, disclosureLevels.findIndex(([key]) => key === row.policy[id]) + 1).map(([id, label]) => ({ id, label }))
  }))
});
export const createMobileAccountSettingsRouter = ({ lineService, passkeys }) => {
  const router = express.Router();
  router.use(requireLogin, provideCsrfToken, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.get('/login-settings', handle(async (req, res) => {
    res.json({ lineEnabled: Boolean(lineService.enabled), lineLinked: lineService.enabled ? Boolean(await lineService.status(req.user._id)) : false,
      passkeyEnabled: Boolean(passkeys.enabled), csrfToken: res.locals.csrfToken });
  }));
  router.get('/disclosure', handle(async (req, res) => {
    const rows = await loadOwnDisclosureRows(req.user._id);
    res.json({ rows: rows.map(mobileDisclosureRow), csrfToken: res.locals.csrfToken });
  }));
  router.post('/disclosure/:associationId', verifyCsrfToken, handle(async (req, res) => {
    await saveOwnDisclosure(req.params.associationId, req.user, req.body);
    res.json({ success: true });
  }));
  router.get('/password', handle(async (_req, res) => {
    res.json({ csrfToken: res.locals.csrfToken });
  }));
  router.post('/password', verifyCsrfToken, handle(async (req, res) => {
    if (Date.now() - (req.session.passwordChangeAttemptAt || 0) < 3000) {
      return res.status(429).json({ error: '少し待ってから再度お試しください。' });
    }
    req.session.passwordChangeAttemptAt = Date.now();
    await changePassword({ userId: req.user._id, currentPassword: req.body.currentPassword, password: req.body.password, confirmation: req.body.passwordConfirmation });
    delete req.session.passwordResetToken;
    res.json({ success: true });
  }));
  router.get('/withdrawals', handle(async (req, res) => {
    const value = await loadOwnWithdrawals(req.user._id);
    const application = row => ({ id: String(row._id), associationId: String(row.association?._id || ''),
      associationName: row.association?.name || '町内会', status: row.status, scope: row.scope,
      reason: row.reason || '', requesterName: row.requestedBy?.displayname || row.requestedBy?.username || '',
      householdName: row.household?.displayName || '' });
    res.json({ csrfToken: res.locals.csrfToken,
      memberships: value.memberships.map(row => ({ id: String(row.association._id), name: row.association.name,
        isHead: String(row.household.representative || row.household.feeRepresentative) === String(req.user._id),
        busy: value.busyHouseholds.includes(String(row.household._id)),
        successors: value.successors.filter(candidate => String(candidate.household) === String(row.household._id))
          .map(candidate => ({ id: String(candidate.user._id), name: candidate.user.displayname || candidate.user.username })) })),
      applications: value.applications.map(application), headApplications: value.headApplications.map(application) });
  }));
  router.post('/withdrawals/:associationId/request', verifyCsrfToken, handle(async (req, res) => {
    await requestWithdrawal({ associationId: req.params.associationId, userId: req.user._id, scope: req.body.scope,
      successorId: req.body.successorId, reason: req.body.reason, confirmed: req.body.confirmWithdrawal === 'on' });
    res.json({ success: true });
  }));
  router.post('/withdrawals/:applicationId/cancel', verifyCsrfToken, handle(async (req, res) => {
    await cancelWithdrawal({ applicationId: req.params.applicationId, actorId: req.user._id });
    res.json({ success: true });
  }));
  for (const decision of ['approve', 'reject']) {
    router.post('/withdrawals/:associationId/:applicationId/' + decision, verifyCsrfToken, handle(async (req, res) => {
      await confirmWithdrawal({ ...req.params, actorId: req.user._id, approve: decision === 'approve' });
      res.json({ success: true });
    }));
  }
  return router;
};

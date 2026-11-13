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
  return router;
};

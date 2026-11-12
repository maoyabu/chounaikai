import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { ApnsSubscription } from '../models/apnsSubscription.js';
import { apnsConfigured, apnsSessionKey, revokeApnsSession, validateApnsRegistration } from '../services/apnsService.js';

export const apnsDevicesRouter = express.Router();
apnsDevicesRouter.use(requireLogin, provideCsrfToken);
apnsDevicesRouter.get('/', (req, res) => res.set('Cache-Control', 'no-store').json({ csrfToken: req.session.csrfToken, configured: apnsConfigured() }));
apnsDevicesRouter.post('/', verifyCsrfToken, async (req, res, next) => {
  try {
    const device = validateApnsRegistration(req.body);
    if (!apnsConfigured()) return res.status(503).json({ error: 'push_not_configured' });
    // A token belongs to one current account, never to all accounts that used the phone.
    await ApnsSubscription.findOneAndUpdate(device, { $set: {
      user: req.user._id, sessionKey: apnsSessionKey(req.sessionID), sessionId: req.sessionID, disabledAt: null,
      expiresAt: req.session.cookie.expires || new Date(Date.now() + 7 * 86400000)
    } }, { upsert: true, setDefaultsOnInsert: true });
    res.status(204).end();
  } catch (error) { next(error); }
});
apnsDevicesRouter.delete('/', verifyCsrfToken, async (req, res, next) => {
  try { await revokeApnsSession(req.sessionID); res.status(204).end(); } catch (error) { next(error); }
});

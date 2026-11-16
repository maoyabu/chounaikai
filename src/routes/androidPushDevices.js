import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { AndroidFcmSubscription } from '../models/androidFcmSubscription.js';
import { androidFcmConfigured, androidFcmSessionKey, revokeAndroidFcmSession, validateAndroidFcmRegistration } from '../services/androidFcmService.js';

// Android device registration for push notifications (the iOS counterpart is /api/push-devices).
export const androidPushDevicesRouter = express.Router();
androidPushDevicesRouter.use(requireLogin, provideCsrfToken);
androidPushDevicesRouter.get('/', (req, res) => res.set('Cache-Control', 'no-store').json({ csrfToken: req.session.csrfToken, configured: androidFcmConfigured() }));
androidPushDevicesRouter.post('/', verifyCsrfToken, async (req, res, next) => {
  try {
    const device = validateAndroidFcmRegistration(req.body);
    if (!androidFcmConfigured()) return res.status(503).json({ error: 'push_not_configured' });
    // A token belongs to one current account, never to all accounts that used the phone.
    await AndroidFcmSubscription.findOneAndUpdate(device, { $set: {
      user: req.user._id, sessionKey: androidFcmSessionKey(req.sessionID), sessionId: req.sessionID, disabledAt: null,
      expiresAt: req.session.cookie.expires || new Date(Date.now() + 7 * 86400000)
    } }, { upsert: true, setDefaultsOnInsert: true });
    res.status(204).end();
  } catch (error) { next(error); }
});
androidPushDevicesRouter.delete('/', verifyCsrfToken, async (req, res, next) => {
  try { await revokeAndroidFcmSession(req.sessionID); res.status(204).end(); } catch (error) { next(error); }
});

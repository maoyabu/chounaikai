import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { disablePushSubscription, savePushSubscription } from '../services/notificationService.js';
import { Notification } from '../models/notification.js';

export const notificationsRouter = express.Router();
notificationsRouter.use(requireLogin);

notificationsRouter.get('/push/status', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const endpoint = String(req.query.endpoint || '');
  if (!endpoint) return res.json({ enabled: false });
  const subscription = await import('../models/pushSubscription.js').then(({ PushSubscription }) => PushSubscription.exists({ user: req.user._id, endpoint, disabledAt: null }));
  return res.json({ enabled: Boolean(subscription) });
});

notificationsRouter.post('/permission-prompt/seen', verifyCsrfToken, (req, res) => {
  req.session.notificationPromptPending = false;
  return res.status(204).end();
});

notificationsRouter.get('/unread-count', async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try {
    const unreadCount = await Notification.countDocuments({ recipient: req.user._id, readAt: null });
    res.json({ unreadCount });
  } catch (error) { next(error); }
});

notificationsRouter.get('/push/public-key', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const key = String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim();
  if (!key) return res.status(503).json({ error: 'web_push_not_configured' });
  return res.json({ publicKey: key });
});

notificationsRouter.post('/push-subscriptions', verifyCsrfToken, async (req, res, next) => {
  try {
    const subscription = await savePushSubscription({ user: req.user._id, subscription: req.body, userAgent: req.get('user-agent') });
    return res.status(201).json({ id: subscription._id });
  } catch (error) { return next(error); }
});

notificationsRouter.delete('/push-subscriptions', verifyCsrfToken, async (req, res, next) => {
  try {
    await disablePushSubscription({ user: req.user._id, endpoint: req.body.endpoint });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

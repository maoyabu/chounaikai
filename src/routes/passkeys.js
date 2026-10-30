import express from 'express';
import { randomBytes } from 'node:crypto';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { recordPrimaryAuth } from '../middleware/mfa.js';
import { passwordFingerprint } from '../services/mfaService.js';

const verifyPassword = (user, password) => new Promise((resolve, reject) => {
  if (typeof password !== 'string' || !password || password.length > 128) return resolve(false);
  user.authenticate(password, (error, authenticated, passwordError) => error ? reject(error) : resolve(Boolean(authenticated && !passwordError)));
});
const failure = (status = 400) => Object.assign(new Error('パスキーを確認できませんでした。'), { status });
const save = req => new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));

export const createPasskeyRouter = service => {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/profile', requireLogin, async (req, res, next) => {
    try { res.json({ credentials: await service.list(req.user._id) }); } catch (error) { next(error); }
  });
  router.post('/profile/register/options', requireLogin, verifyCsrfToken, async (req, res, next) => {
    try {
      if (!await verifyPassword(req.user, req.body.currentPassword)) throw failure(403);
      req.session.passkeyBinding = randomBytes(32).toString('base64url');
      const result = await service.startRegistration(req.user, req.session.passkeyBinding);
      await save(req);
      res.json(result);
    } catch (error) { next(error); }
  });
  router.post('/profile/register/verify', requireLogin, verifyCsrfToken, async (req, res, next) => {
    try {
      const result = await service.finishRegistration({ user: req.user, binding: req.session.passkeyBinding,
        flowId: req.body.flowId, response: req.body.response });
      delete req.session.passkeyBinding;
      res.json({ credential: result });
    } catch (error) { next(error); }
  });
  router.post('/profile/remove', requireLogin, verifyCsrfToken, async (req, res, next) => {
    try {
      if (!await verifyPassword(req.user, req.body.currentPassword)) throw failure(403);
      if (typeof req.body.id !== 'string' || !/^[a-f\d]{24}$/i.test(req.body.id)) throw failure();
      const removed = await service.remove(req.user._id, req.body.id);
      if (!removed) throw failure(404);
      res.json({ removed: true });
    } catch (error) { next(error); }
  });
  router.post('/auth/options', verifyCsrfToken, async (req, res, next) => {
    try {
      if (req.user) throw failure(409);
      req.session.passkeyBinding = randomBytes(32).toString('base64url');
      const result = await service.startAuthentication(req.session.passkeyBinding);
      await save(req);
      res.json(result);
    } catch (error) { next(error); }
  });
  router.post('/auth/verify', verifyCsrfToken, async (req, res, next) => {
    try {
      if (req.user) throw failure(409);
      const { user, credential } = await service.finishAuthentication({ binding: req.session.passkeyBinding,
        flowId: req.body.flowId, response: req.body.response });
      delete req.session.passkeyBinding;
      const context = {};
      for (const key of ['householdInvitationId', 'registrationChoice']) if (req.session[key] !== undefined) context[key] = req.session[key];
      await new Promise((resolve, reject) => req.logIn(user, error => error ? reject(error) : resolve()));
      Object.assign(req.session, context);
      req.session.passkeyLogin = { credentialId: String(credential._id), fingerprint: passwordFingerprint(user) };
      req.session.notificationPromptPending = true;
      const state = await recordPrimaryAuth(req, user, '/login/complete');
      const nextUrl = state.required || state.credential?.enabledAt ? (state.credential?.enabledAt ? '/mfa/verify' : '/mfa/setup') : '/login/complete';
      res.json({ next: nextUrl });
    } catch (error) { next(error); }
  });
  return router;
};

export const enforcePasskeySession = service => async (req, res, next) => {
  try {
    if (req.user && req.session.passkeyLogin && !await service.validSession(req.user, req.session.passkeyLogin)) {
      return req.session.destroy(error => {
        if (error) return next(error);
        res.clearCookie('chounaikai.sid');
        return req.originalUrl.startsWith('/api/') ? res.status(401).json({ error: 'reauthentication_required' }) : res.redirect('/login');
      });
    }
    next();
  } catch (error) { next(error); }
};

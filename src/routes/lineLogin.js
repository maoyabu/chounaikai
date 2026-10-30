import express from 'express';
import { randomBytes } from 'node:crypto';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { recordPrimaryAuth } from '../middleware/mfa.js';
import { passwordFingerprint } from '../services/mfaService.js';
import { eligibleLineUser } from '../services/lineLoginService.js';

const save = req => new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
const verifyPassword = (user, password) => new Promise((resolve, reject) => {
  if (typeof password !== 'string' || !password || password.length > 128) return resolve(false);
  user.authenticate(password, (error, authenticated, passwordError) => error ? reject(error) : resolve(Boolean(authenticated && !passwordError)));
});

export const createLineLoginRouter = service => {
  const router = express.Router();
  router.use(['/auth/line', '/profile/line'], (_req, res, next) => {
    res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next();
  });
  router.post('/auth/line', verifyCsrfToken, async (req, res, next) => {
    try {
      if (req.user) return res.redirect('/dashboard');
      req.session.lineOAuthBinding = randomBytes(32).toString('base64url');
      const url = await service.start({ binding: req.session.lineOAuthBinding, mode: 'login' });
      await save(req); return res.redirect(url);
    } catch (error) { next(error); }
  });
  router.get('/profile/line', requireLogin, provideCsrfToken, async (req, res, next) => {
    try { return res.render('line-settings', { title: 'LINEログイン設定', lineEnabled: service.enabled, linked: await service.status(req.user._id) }); }
    catch (error) { next(error); }
  });
  for (const action of ['link', 'unlink']) router.post(`/profile/line/${action}`, requireLogin, verifyCsrfToken, async (req, res, next) => {
    try {
      if (!eligibleLineUser(req.user) || !await verifyPassword(req.user, req.body.currentPassword)) {
        req.session.errorMessage = '現在のパスワードを確認してください。'; return res.redirect('/profile?tab=login#line-login');
      }
      if (action === 'unlink') {
        await service.unlink(req.user._id);
        // End this session too; other LINE sessions are rejected on their next request.
        return req.session.destroy(error => { if (error) return next(error); res.clearCookie('chounaikai.sid'); res.redirect('/login'); });
      }
      if (await service.status(req.user._id)) { req.session.errorMessage = 'すでにLINEと連携されています。'; return res.redirect('/profile?tab=login#line-login'); }
      req.session.lineOAuthBinding = randomBytes(32).toString('base64url');
      const url = await service.start({ binding: req.session.lineOAuthBinding, mode: 'link', user: req.user });
      await save(req); return res.redirect(url);
    } catch (error) { next(error); }
  });
  router.get('/auth/line/callback', async (req, res, next) => {
    let flow;
    try {
      flow = await service.consume({ state: req.query.state, binding: req.session.lineOAuthBinding });
      delete req.session.lineOAuthBinding;
      if (req.query.error) throw Object.assign(new Error('LINEでの認証がキャンセルされました。'), { status: 400 });
      if ((flow.mode === 'link' && String(req.user?._id) !== String(flow.user)) || (flow.mode === 'login' && req.user)) throw Object.assign(new Error('ログイン状態が変わりました。最初からやり直してください。'), { status: 400 });
      const subject = await service.authenticate(req.query.code, flow);
      if (flow.mode === 'link') {
        await service.link(subject, flow, req.user);
        req.session.notice = 'LINEと連携しました。次回から「LINEでログイン」を利用できます。';
        return res.redirect('/profile?tab=login#line-login');
      }
      const { user, identity } = await service.resolve(subject);
      const context = {};
      for (const key of ['householdInvitationId', 'registrationChoice']) if (req.session[key] !== undefined) context[key] = req.session[key];
      await new Promise((resolve, reject) => req.logIn(user, error => error ? reject(error) : resolve()));
      Object.assign(req.session, context);
      req.session.lineLogin = { identityId: String(identity._id), fingerprint: passwordFingerprint(user) };
      req.session.notificationPromptPending = true;
      const state = await recordPrimaryAuth(req, user, '/login/complete');
      return res.redirect(state.required || state.credential?.enabledAt ? (state.credential?.enabledAt ? '/mfa/verify' : '/mfa/setup') : '/login/complete');
    } catch (error) {
      if (!error.status || error.status >= 500) return next(error);
      req.session.errorMessage = error.message;
      return res.redirect(flow?.mode === 'link' && req.user ? '/profile?tab=login#line-login' : '/login');
    }
  });
  return router;
};

export const enforceLineSession = service => async (req, res, next) => {
  try {
    if (req.user && req.session.lineLogin && !await service.validSession(req.user, req.session.lineLogin)) {
      return req.session.destroy(error => {
        if (error) return next(error);
        res.clearCookie('chounaikai.sid');
        return req.originalUrl.startsWith('/api/') ? res.status(401).json({ error: 'reauthentication_required' }) : res.redirect('/login');
      });
    }
    next();
  } catch (error) { next(error); }
};

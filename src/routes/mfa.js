import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { completeMfa, safeMfaReturnTo } from '../middleware/mfa.js';

export const mfaRouter = express.Router();
const isApi = req => req.originalUrl.toLowerCase().startsWith('/api/');
const service = req => req.app.locals.mfaService;
const destination = req => req.mfaState?.credential?.enabledAt ? '/mfa/verify' : '/mfa/setup';
const send = (req, res, mode, data = {}, status = 200) => {
  const values = { mode, title: '管理者の多要素認証', formError: null, ...data };
  if (isApi(req)) return res.status(status).json({ ...values, csrfToken: req.session.csrfToken });
  return res.status(status).render('mfa', values);
};
const redirect = (req, res, nextPath) => isApi(req) ? res.json({ verified: Boolean(req.session.mfaVerified), next: nextPath }) : res.redirect(nextPath);
const requireVerified = (req, res, next) => req.mfaVerified ? next() : redirect(req, res, destination(req));
const setupView = async (req, res, formError = null, status = 200) => {
  const details = await service(req).setupDetails(req.user, req.session.mfaSetup);
  return send(req, res, 'setup', { ...details, changing: Boolean(req.session.mfaSetup.revision), formError }, status);
};
const showCodes = async (req, res, result) => {
  delete req.session.mfaSetup;
  await completeMfa(req, result.credential);
  provideCsrfToken(req, res, () => {});
  return send(req, res, 'codes', { codes: result.codes });
};

mfaRouter.use(requireLogin, provideCsrfToken, (req, res, next) => {
  res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
  // Pending sessions must not display admin menus or trigger notification prompts.
  res.locals.currentUser = null; res.locals.showNotificationPrompt = false;
  if (!req.mfaState?.required && !req.mfaState?.credential?.enabledAt) {
    return res.status(403).json({ error: 'mfa_not_required' });
  }
  next();
});

mfaRouter.get('/', (req, res) => {
  if (isApi(req)) return res.json({ required: req.mfaState.required, enrolled: Boolean(req.mfaState.credential?.enabledAt), verified: req.mfaVerified, csrfToken: req.session.csrfToken, next: req.mfaVerified ? '/mfa/settings' : destination(req) });
  return res.redirect(req.mfaVerified ? '/mfa/settings' : destination(req));
});
mfaRouter.get('/setup', async (req, res, next) => {
  try {
    if (req.mfaState.credential?.enabledAt) return redirect(req, res, req.mfaVerified ? '/mfa/settings' : '/mfa/verify');
    if (!req.session.mfaSetup || req.session.mfaSetup.expiresAt <= Date.now()) req.session.mfaSetup = service(req).newSetup(req.user);
    return await setupView(req, res);
  } catch (error) { next(error); }
});
mfaRouter.post('/setup', verifyCsrfToken, async (req, res, next) => {
  try { return await showCodes(req, res, await service(req).confirmSetup(req.user, req.session.mfaSetup, req.body.code)); }
  catch (error) {
    if (error.status === 400 && req.session.mfaSetup?.expiresAt > Date.now()) {
      try { return await setupView(req, res, error.message, 400); } catch (failure) { return next(failure); }
    }
    return next(error);
  }
});
mfaRouter.get('/verify', (req, res) => {
  if (!req.mfaState.credential?.enabledAt) return redirect(req, res, '/mfa/setup');
  if (req.mfaVerified) return redirect(req, res, '/mfa/settings');
  return send(req, res, 'verify');
});
mfaRouter.post('/verify', verifyCsrfToken, async (req, res, next) => {
  try {
    const result = await service(req).prove(req.user, req.body);
    await completeMfa(req, result.credential);
    if (result.recovered) req.session.notice = '復旧コードを使用しました。スマートフォンを紛失した場合は、多要素認証の設定から認証アプリを変更してください。';
    const nextPath = safeMfaReturnTo(req.session.mfaReturnTo);
    delete req.session.mfaReturnTo;
    return redirect(req, res, nextPath);
  } catch (error) {
    if (error.status === 400) return send(req, res, 'verify', { formError: error.message }, 400);
    return next(error);
  }
});
mfaRouter.post('/continue', verifyCsrfToken, requireVerified, (req, res) => {
  const nextPath = safeMfaReturnTo(req.session.mfaReturnTo); delete req.session.mfaReturnTo;
  return redirect(req, res, nextPath);
});
mfaRouter.get('/settings', requireVerified, async (req, res, next) => {
  try { return send(req, res, 'settings', { recoveryCount: await service(req).recoveryCount(req.user) }); }
  catch (error) { next(error); }
});
for (const action of ['recovery', 'change']) {
  mfaRouter.post(`/settings/${action}`, verifyCsrfToken, requireVerified, async (req, res, next) => {
    try {
      await service(req).checkPassword(req.user, req.body.currentPassword);
      if (action === 'recovery') return await showCodes(req, res, await service(req).regenerateRecovery(req.user, req.body));
      const { credential } = await service(req).prove(req.user, req.body);
      req.session.mfaSetup = service(req).newSetup(req.user, credential.revision);
      return redirect(req, res, '/mfa/change');
    } catch (error) {
      if (error.status === 400) {
        try { return send(req, res, 'settings', { formError: error.message, recoveryCount: await service(req).recoveryCount(req.user) }, 400); }
        catch (failure) { return next(failure); }
      }
      return next(error);
    }
  });
}
mfaRouter.get('/change', requireVerified, async (req, res, next) => {
  try {
    if (!req.session.mfaSetup?.revision) return redirect(req, res, '/mfa/settings');
    return await setupView(req, res);
  } catch (error) { next(error); }
});
mfaRouter.post('/change', verifyCsrfToken, requireVerified, async (req, res, next) => {
  try {
    if (!req.session.mfaSetup?.revision) return redirect(req, res, '/mfa/settings');
    return await showCodes(req, res, await service(req).confirmSetup(req.user, req.session.mfaSetup, req.body.code));
  } catch (error) {
    if (error.status === 400 && req.session.mfaSetup?.expiresAt > Date.now()) {
      try { return await setupView(req, res, error.message, 400); } catch (failure) { return next(failure); }
    }
    return next(error);
  }
});
mfaRouter.post('/logout', verifyCsrfToken, (req, res, next) => {
  req.logout(error => {
    if (error) return next(error);
    req.session.destroy(failure => {
      if (failure) return next(failure);
      res.clearCookie('chounaikai.sid'); return redirect(req, res, '/login');
    });
  });
});

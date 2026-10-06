import express from 'express';
import { requireSystemAdmin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { passwordFingerprint } from '../services/mfaService.js';

export const siteSecurityRouter = express.Router();
siteSecurityRouter.use('/admin/security', requireSystemAdmin, provideCsrfToken, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
const render = async (req, res, formError = null, status = 200) => {
  const settings = await req.app.locals.siteSecurityService.get();
  const enrollment = await req.app.locals.mfaService.getEnrollmentState(req.user);
  return res.status(status).render('site-security', { title: 'サイトの多要素認証設定', settings, enrolled: Boolean(enrollment.credential?.enabledAt), formError });
};
siteSecurityRouter.get('/admin/security', async (req, res, next) => {
  try { await render(req, res); } catch (error) { next(error); }
});
siteSecurityRouter.post('/admin/security/mfa', verifyCsrfToken, async (req, res, next) => {
  try {
    if (!['true', 'false'].includes(req.body.enabled) || typeof req.body.revision !== 'string' || !req.body.revision || req.body.revision.length > 64) throw Object.assign(new Error('入力内容を確認してください。'), { status: 400 });
    const current = await req.app.locals.siteSecurityService.get();
    if (current.revision !== req.body.revision || current.mfaEnabled === (req.body.enabled === 'true')) throw Object.assign(new Error('設定が変更されています。画面を再読み込みしてください。'), { status: 409 });
    const mfa = req.app.locals.mfaService;
    await mfa.checkPassword(req.user, req.body.currentPassword);
    const enrollment = await mfa.getEnrollmentState(req.user);
    // Even while MFA is off, an enrolled admin must prove the saved factor
    // before changing this security policy.
    if (enrollment.credential?.enabledAt) await mfa.prove(req.user, req.body);
    const enabled = req.body.enabled === 'true';
    await req.app.locals.siteSecurityService.change({ enabled, revision: req.body.revision, actor: req.user });
    delete req.session.mfaVerified; delete req.session.mfaSetup;
    req.session.mfaPrimary = { userId: String(req.user._id), passwordFingerprint: passwordFingerprint(req.user), at: Date.now() };
    req.session.notice = enabled ? 'このサイトの多要素認証を使用する設定にしました。' : 'このサイトの多要素認証を使用しない設定にしました。';
    return res.redirect('/admin');
  } catch (error) {
    if (error.status === 400) { try { return await render(req, res, error.message, 400); } catch (failure) { return next(failure); } }
    next(error);
  }
});

import { MFA_PENDING_MS, MFA_SESSION_MS, passwordFingerprint } from '../services/mfaService.js';

export const safeMfaReturnTo = value => typeof value === 'string' && value.length <= 2048 && value.startsWith('/') && !value.startsWith('//') && !/[\\\r\n]/.test(value) ? value : '/dashboard';
export const mfaVerified = (req, state, now = Date.now()) => {
  const verified = req.session?.mfaVerified;
  return Boolean(state.credential?.enabledAt && verified && verified.userId === String(req.user._id)
    && verified.revision === state.credential.revision && verified.passwordFingerprint === passwordFingerprint(req.user)
    && verified.at <= now && now - verified.at < MFA_SESSION_MS);
};
export const recentPrimaryAuth = (req, now = Date.now()) => {
  const primary = req.session?.mfaPrimary;
  return Boolean(primary && primary.userId === String(req.user._id) && primary.passwordFingerprint === passwordFingerprint(req.user)
    && primary.at <= now && now - primary.at < MFA_PENDING_MS);
};
export const recordPrimaryAuth = async (req, user, returnTo) => {
  delete req.session.mfaVerified; delete req.session.mfaSetup;
  req.session.mfaPrimary = { userId: String(user._id), passwordFingerprint: passwordFingerprint(user), at: Date.now() };
  req.session.mfaReturnTo = safeMfaReturnTo(returnTo);
  return req.app.locals.mfaService.getState(user);
};
export const completeMfa = async (req, credential) => {
  const preserved = {};
  for (const name of ['mfaPrimary', 'mfaReturnTo', 'registrationChoice', 'householdInvitationId', 'notificationPromptPending']) {
    if (req.session[name] !== undefined) preserved[name] = req.session[name];
  }
  await new Promise((resolve, reject) => req.logIn(req.user, error => error ? reject(error) : resolve()));
  Object.assign(req.session, preserved);
  req.session.mfaVerified = { userId: String(req.user._id), revision: credential.revision, passwordFingerprint: passwordFingerprint(req.user), at: Date.now() };
};
export const enforceAdminMfa = service => async (req, res, next) => {
  if (!req.isAuthenticated?.()) return next();
  try {
    const state = await service.getState(req.user);
    req.mfaState = state; req.mfaVerified = mfaVerified(req, state);
    res.locals.mfaRequired = state.required; res.locals.mfaEnabled = Boolean(state.credential?.enabledAt);
    if (!state.required && !state.credential?.enabledAt) return next();
    const path = req.path.toLowerCase().replace(/\/+$/, '');
    const logout = ['/logout', '/api/auth/logout', '/mfa/logout', '/api/auth/mfa/logout'].includes(path);
    if (logout || req.mfaVerified) return next();
    res.set('Cache-Control', 'no-store');
    const api = req.originalUrl.toLowerCase().startsWith('/api/');
    if (!recentPrimaryAuth(req)) {
      return req.session.destroy(error => {
        if (error) return next(error);
        res.clearCookie('chounaikai.sid');
        return api ? res.status(401).json({ error: 'reauthentication_required', next: '/login' }) : res.redirect('/login');
      });
    }
    if (path === '/mfa' || path.startsWith('/mfa/') || path === '/api/auth/mfa' || path.startsWith('/api/auth/mfa/')) return next();
    const destination = state.credential?.enabledAt ? '/mfa/verify' : '/mfa/setup';
    if (req.method === 'GET' && !api && path !== '/login') req.session.mfaReturnTo = safeMfaReturnTo(req.originalUrl);
    if (api || req.method !== 'GET') return res.status(403).json({ error: 'mfa_required', setupRequired: !state.credential?.enabledAt, next: destination });
    return res.redirect(destination);
  } catch (error) { return next(error); }
};

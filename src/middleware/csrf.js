import crypto from 'node:crypto';

export const provideCsrfToken = (req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  next();
};

export const verifyCsrfToken = (req, res, next) => {
  const expected = String(req.session?.csrfToken || '');
  const received = String(req.body?._csrf || req.get('x-csrf-token') || '');
  const valid = expected.length === received.length && expected.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  if (!valid) return res.status(403).render('error', { title: '操作を確認できませんでした', message: '画面を再読み込みして、もう一度お試しください。' });
  return next();
};

const messages = Object.freeze({
  400: '入力内容または認証情報を確認して、もう一度お試しください。',
  401: 'ログインし直して、もう一度お試しください。',
  403: 'この操作を行う権限がないか、操作を確認できませんでした。画面を再読み込みしてください。',
  404: '指定されたページや情報を確認できませんでした。',
  409: '現在の状態では操作できません。画面を再読み込みして、もう一度お試しください。',
  413: '送信するデータが大きすぎます。サイズを小さくして、もう一度お試しください。',
  429: '操作回数の上限に達しました。時間をおいて再度お試しください。',
  503: '現在サービスを利用できません。時間をおいて再度お試しください。'
});
const codes = Object.freeze({ 400: 'invalid_request', 401: 'authentication_required', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'payload_too_large', 429: 'too_many_requests', 503: 'service_unavailable' });
const publicCodes = new Set(['authentication_required', 'invalid_credentials', 'email_not_verified', 'system_admin_required', 'active_membership_required', 'permission_denied', 'invalid_association_id', 'association_not_found', 'mfa_required', 'mfa_not_required', 'reauthentication_required', 'too_many_requests']);
export const publicErrorMessage = status => messages[status] || (status >= 500 ? '処理中にエラーが発生しました。時間をおいて再度お試しください。' : '操作を完了できませんでした。');
export const errorStatus = error => {
  const status = Number(error?.status ?? error?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  if (['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError'].includes(error?.name) || ['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH'].includes(error?.code)) return 503;
  if (error?.code === 11000) return 409;
  return 500;
};
const isApi = req => req.originalUrl?.toLowerCase().startsWith('/api/') || req.get('X-Requested-With') === 'XMLHttpRequest';
const safeJson = (status, data) => {
  const result = { error: status < 500 && publicCodes.has(data?.error) ? data.error : codes[status] || (status >= 500 ? 'internal_error' : 'request_failed'), message: publicErrorMessage(status) };
  if (result.error === 'mfa_required') {
    result.setupRequired = data?.setupRequired === true;
    result.next = result.setupRequired ? '/mfa/setup' : '/mfa/verify';
  }
  if (result.error === 'reauthentication_required') result.next = '/login';
  return result;
};
// No template engine, exception text, request path, user data or environment
// values are used in the fallback. This also works when EJS rendering fails.
const safeHtml = status => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>エラー | 町内会管理</title><link rel="stylesheet" href="/assets/app.css"></head><body><main class="page-shell page-narrow"><section class="empty-state"><h1>操作を完了できませんでした</h1><p>${publicErrorMessage(status)}</p><a class="button button-primary" href="/login">ログイン画面へ戻る</a></section></main></body></html>`;

export const productionErrorResponses = nodeEnv => (req, res, next) => {
  if (nodeEnv !== 'production') return next();
  const send = res.send.bind(res), json = res.json.bind(res), render = res.render.bind(res);
  let trusted = false;
  const protect = fn => { const previous = trusted; trusted = true; try { return fn(); } finally { trusted = previous; } };
  res.json = data => {
    if (res.statusCode < 400 && !data?.error && !data?.formError) return json(data);
    if (res.statusCode < 400) res.status(data?.formError ? 400 : 500);
    res.set('Cache-Control', 'no-store');
    return protect(() => json(safeJson(res.statusCode, data)));
  };
  res.send = data => {
    if (trusted || res.statusCode < 400) return send(data);
    res.set('Cache-Control', 'no-store');
    return isApi(req) ? res.json({}) : protect(() => { res.type('html'); return send(safeHtml(res.statusCode)); });
  };
  res.render = (view, options = {}, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const status = res.statusCode;
    if (view === 'error' || status >= 500) {
      if (status < 400) res.status(500);
      const html = safeHtml(res.statusCode);
      res.set('Cache-Control', 'no-store');
      if (callback) return callback(null, html);
      return res.send(html);
    }
    const sanitized = { ...options };
    for (const field of ['formError', 'errorMessage']) {
      if (sanitized[field]) sanitized[field] = publicErrorMessage(status >= 400 ? status : 400);
      if (res.locals[field]) res.locals[field] = publicErrorMessage(status >= 400 ? status : 400);
    }
    if (status >= 400) {
      res.set('Cache-Control', 'no-store');
      if (sanitized.message) sanitized.message = publicErrorMessage(status);
      for (const field of ['error', 'err', 'stack', 'details']) { delete sanitized[field]; delete res.locals[field]; }
    }
    // Preserve the form with sanitized validation feedback, bypassing send's
    // generic replacement only for output generated with these safe values.
    render(view, sanitized, (error, html) => {
      if (error) return callback ? callback(error) : next(error);
      if (callback) return callback(null, html);
      protect(() => send(html));
    });
    return res;
  };
  next();
};

export const applicationErrorHandler = nodeEnv => (error, req, res, _next) => {
  const status = errorStatus(error);
  if (status >= 500) console.error(error);
  if (res.headersSent) { req.socket.destroy(); return; }
  res.status(status).set('Cache-Control', 'no-store');
  if (isApi(req)) return res.json(nodeEnv === 'production' ? safeJson(status) : { error: status === 500 ? 'internal_error' : error?.message || codes[status] });
  if (nodeEnv === 'production') return res.type('html').send(safeHtml(status));
  res.render('error', { title: 'エラー', message: status < 500 ? error?.message || publicErrorMessage(status) : publicErrorMessage(status) }, (failure, html) => {
    // Render failures never escape to Express's default stack-trace renderer.
    res.type('html').send(failure ? safeHtml(status) : html);
  });
};

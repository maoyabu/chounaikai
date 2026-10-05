import crypto from 'node:crypto';
import { auditedViews, buildPrivacyEvent, writePrivacyAccess } from '../services/privacyAuditService.js';

export const privacyAudit = ({ writer = writePrivacyAccess } = {}) => (req, res, next) => {
  req.privacyRequestId = crypto.randomUUID();
  req.auditPersonalData = async options => {
    res.set('Cache-Control', 'private, no-store');
    try { await writer(buildPrivacyEvent(req, options)); }
    catch (cause) {
      // Never send sensitive data when persisting the audit record fails.
      const error = new Error('閲覧監査ログを保存できません。時間をおいて再度お試しください。', { cause });
      error.status = 503;
      throw error;
    }
  };
  const render = res.render.bind(res);
  res.render = (view, options = {}, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const category = auditedViews[view];
    if (!category || res.statusCode >= 400) return render(view, options, callback);
    // Render first, then persist, then send. Permission errors, redirects and
    // template failures do not produce a successful disclosure event.
    render(view, options, (error, html) => {
      if (error) return callback ? callback(error) : next(error);
      req.auditPersonalData({ category, resource: view, data: options }).then(() => {
        if (callback) return callback(null, html);
        res.send(html);
      }).catch(error => callback ? callback(error) : next(error));
    });
    return res;
  };
  next();
};

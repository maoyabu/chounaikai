import express from 'express';
import { requireSystemAdmin } from '../middleware/auth.js';
import { PrivacyAccessLog } from '../models/privacyAccessLog.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { privacyCategories } from '../services/privacyAuditService.js';
import { privacyAuditQuery, privacyAuditNextUrl } from '../services/privacyAuditQuery.js';

export const privacyAuditRouter = express.Router();
privacyAuditRouter.get('/admin/privacy-audit', requireSystemAdmin, async (req, res, next) => {
  try {
    const { filter, filters, cursor } = privacyAuditQuery(req.query);
    const [rows, associations] = await Promise.all([
      PrivacyAccessLog.find(filter).sort({ createdAt: -1, _id: -1 }).limit(51).lean(),
      NeighborhoodAssociation.find({}).select('name').sort({ name: 1 }).lean()
    ]);
    const names = new Map(associations.map(item => [String(item._id), item.name]));
    const logs = rows.slice(0, 50).map(log => ({ ...log, associationNames: (log.associations || []).map(id => ({ _id: id, name: names.get(String(id)) || '削除済み・名称不明' })) }));
    res.render('privacy-audit', {
      title: '個人情報の閲覧監査ログ', logs, filters, associations, categories: privacyCategories,
      nextUrl: rows.length > 50 ? privacyAuditNextUrl(filters, logs.at(-1)) : null,
      firstUrl: cursor ? privacyAuditNextUrl(filters) : null
    });
  } catch (error) { next(error); }
});

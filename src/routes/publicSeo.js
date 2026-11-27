import express from 'express';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AssociationGroup } from '../models/associationGroup.js';
import { publicPageCanonical } from '../services/publicPageSeoService.js';
export const publicSeoRouter = express.Router();
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
publicSeoRouter.get('/robots.txt', (req, res, next) => {
  try {
    const origin = new URL(publicPageCanonical(req, 'unused')).origin;
    res.type('text/plain').send(`User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`);
  } catch (error) { next(error); }
});
publicSeoRouter.get('/sitemap.xml', async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try {
    const associations = await NeighborhoodAssociation.find({ status: 'active', deletedAt: { $exists: false } }).select('_id optionalFeatures').sort({ _id: 1 }).lean();
    const groupAssociationIds = associations.filter(a => a.optionalFeatures?.groups === true).map(a => a._id);
    const groups = groupAssociationIds.length ? await AssociationGroup.find({ association: { $in: groupAssociationIds }, publicVisibility: 'open', status: { $in: ['active', 'suspended'] } }).select('_id association').sort({ _id: 1 }).lean() : [];
    const origin = new URL(publicPageCanonical(req, 'unused')).origin;
    const urls = [`${origin}/app/`, `${origin}/associations`, ...associations.map(a => publicPageCanonical(req, a._id)), ...groups.map(g => publicPageCanonical(req, g.association, g._id))];
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(url => `  <url><loc>${xml(url)}</loc></url>`).join('\n')}\n</urlset>\n`;
    if (urls.length > 50000 || Buffer.byteLength(body) > 50 * 1024 * 1024) throw Object.assign(new Error('サイトマップの分割が必要です。'), { status: 503 });
    return res.type('application/xml').send(body);
  } catch (error) { return next(error); }
});

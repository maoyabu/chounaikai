import { privacyCategories } from './privacyAuditService.js';

const invalid = () => Object.assign(new Error('検索条件を確認してください。'), { status: 400 });
const scalar = (query, key, limit = 160) => {
  const value = query[key];
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > limit) throw invalid();
  return value.trim();
};
const date = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid();
  const parsed = new Date(`${value}T00:00:00+09:00`);
  if (!Number.isFinite(parsed.getTime()) || new Date(parsed.getTime() + 9 * 3600000).toISOString().slice(0, 10) !== value) throw invalid();
  return parsed;
};
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const privacyAuditQuery = (query, now = new Date()) => {
  const today = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const initial = new Date(now.getTime() + 9 * 3600000 - 29 * 86400000).toISOString().slice(0, 10);
  const filters = Object.fromEntries(['from', 'to', 'actor', 'association', 'category', 'action', 'target'].map(key => [key, scalar(query, key)]));
  filters.from ||= initial; filters.to ||= today;
  const from = date(filters.from), to = date(filters.to);
  if (from > to) throw invalid();
  const filter = { createdAt: { $gte: from, $lt: new Date(to.getTime() + 86400000) } };
  if (filters.actor) {
    if (/^[a-f\d]{24}$/i.test(filters.actor)) filter.actor = filters.actor;
    else filter.actorName = { $regex: escapeRegex(filters.actor), $options: 'i' };
  }
  if (filters.association) {
    if (!/^[a-f\d]{24}$/i.test(filters.association)) throw invalid();
    filter.associations = filters.association;
  }
  if (filters.category) {
    if (!Object.hasOwn(privacyCategories, filters.category)) throw invalid();
    filter.category = filters.category;
  }
  if (filters.action) {
    if (!['view', 'download', 'export'].includes(filters.action)) throw invalid();
    filter.action = filters.action;
  }
  if (filters.target) {
    if (/^[a-f\d]{24}$/i.test(filters.target)) filter.targets = { $regex: `:${filters.target}$`, $options: 'i' };
    else if (/^[\w-]+:[\w-]{1,160}$/.test(filters.target)) filter.targets = filters.target;
    else throw invalid();
  }
  const cursor = scalar(query, 'cursor', 256);
  if (cursor) {
    let parsed;
    try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw invalid(); }
    if (!parsed || typeof parsed.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(parsed.at) || !Number.isFinite(Date.parse(parsed.at)) || !/^[a-f\d]{24}$/i.test(parsed.id)) throw invalid();
    const at = new Date(parsed.at);
    filter.$or = [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: parsed.id } }];
  }
  return { filter, filters, cursor };
};
export const privacyAuditNextUrl = (filters, log) => {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
  if (log) query.set('cursor', Buffer.from(JSON.stringify({ at: log.createdAt.toISOString(), id: String(log._id) })).toString('base64url'));
  return `/admin/privacy-audit?${query}`;
};

import express from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { acceptPublicPhotos } from '../services/publicPageImageService.js';
import { persistFaqImages, deleteFaqImage } from '../services/faqImageService.js';
import { attachmentContext } from '../services/messageAttachmentService.js';
import { assertDriveItem, driveId } from '../services/driveService.js';
import mongoose from 'mongoose';
import { requireLogin, requirePermission, requireSystemAdmin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { Faq } from '../models/faq.js';

export const faqsRouter = express.Router();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const wrap = handler => async (req, res, next) => { try { await handler(req, res); } catch (error) { next(error); } };
export const faqInput = (body, system = false) => {
  const result = {};
  for (const [key, max] of Object.entries({ category: 100, question: 1000, answer: 10000, relatedUrl: 2000 })) {
    if (body[key] !== undefined && typeof body[key] !== 'string') throw fail('入力内容を確認してください。');
    const value = (body[key] || '').trim();
    if ((!value && key !== 'relatedUrl') || value.length > max) throw fail('必須項目と文字数を確認してください。');
    result[key] = value;
  }
  if (result.relatedUrl) {
    let url;
    try { url = new URL(result.relatedUrl); } catch { throw fail('関連URLを確認してください。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw fail('関連URLはhttpまたはhttpsで入力してください。');
  }
  if (body.published !== undefined && body.published !== 'on') throw fail('公開設定を確認してください。');
  result.published = body.published === 'on';
  if (system) {
    if (body.openToPublic !== undefined && body.openToPublic !== 'on') throw fail('表示範囲を確認してください。');
    result.openToPublic = body.openToPublic === 'on';
  }
  return result;
};
const loadAssociation = async id => {
  if (!mongoose.isValidObjectId(id)) throw fail('町内会が見つかりません。', 404);
  const association = await NeighborhoodAssociation.findOne({ _id: id, status: 'active', deletedAt: { $exists: false } }).lean();
  if (!association) throw fail('町内会が見つかりません。', 404);
  return association;
};
export const publishedFaqFilter = association => ({ published: true, association: { $in: [null, association] } });
const publicPage = async (req, res, association, support, directory = false) => {
  const memberships = res.locals?.dangerMemberships || [];
  const contactAssociation = memberships.find(item => String(item.association._id) === String(association?._id))?.association
    || memberships[0]?.association;
  const supportContactUrl = contactAssociation ? `/associations/${contactAssociation._id}/questions` : null;
  const baseFilter = directory || !req.isAuthenticated?.()
    ? { published: true, association: null, openToPublic: true }
    : association ? publishedFaqFilter(association._id) : { published: true, association: null };
  if (!directory) res.set?.('Cache-Control', 'private, no-store');
  const supportUrl = association ? `/associations/${association._id}/support` : '/support';
  const faqUrl = directory ? '/faq' : association ? `/associations/${association._id}/faq` : '/support/faqs';
  const category = !support && typeof req.query?.category === 'string' ? req.query.category : '';
  const filter = category ? { ...baseFilter, category } : baseFilter;
  let query = Faq.find(filter).sort({ association: 1, position: 1, _id: 1 });
  if (support) query = query.limit(10);
  const [items, categories] = await Promise.all([
    query.lean(),
    support ? Promise.resolve([]) : Faq.distinct('category', baseFilter)
  ]);
  res.render(support ? 'support' : 'faq-public', {
    title: support ? 'サポートページ' : 'Q&A一覧', association, items,
    categories: categories.sort((a, b) => a.localeCompare(b, 'ja')), category,
    supportUrl, faqUrl, supportContactUrl, directory
  });
};
faqsRouter.get('/faq', wrap(async (req, res) => publicPage(req, res, null, false, true)));
for (const support of [true, false]) {
  faqsRouter.get(support ? '/support' : '/support/faqs', wrap(async (req, res) => {
    // Carry the current association through navigation; users with no association
    // still have access to system-wide support.
    const context = res.locals?.dangerMemberships?.[0]?.association
      || res.locals?.currentManagerAssociations?.[0]
      || res.locals?.currentOfficerQuestionBoxes?.[0]
      || res.locals?.currentLeaderAssociations?.[0];
    if (context) {
      const suffix = !support && typeof req.query?.category === 'string' ? `?category=${encodeURIComponent(req.query.category)}` : '';
      return res.redirect(`/associations/${context._id}/${support ? 'support' : 'faq'}${suffix}`);
    }
    await publicPage(req, res, null, support);
  }));
  faqsRouter.get(`/associations/:associationId/${support ? 'support' : 'faq'}`, wrap(async (req, res) => {
    const association = await loadAssociation(req.params.associationId);
    await publicPage(req, res, association, support);
  }));
}
for (const system of [false, true]) {
  const base = system ? '/admin/faqs' : '/associations/:associationId/manage/faqs';
  const guard = system ? requireSystemAdmin : requirePermission('association.manage');
  const url = req => system ? base : `/associations/${req.params.associationId}/manage/faqs`;
  const scope = req => ({ association: system ? null : req.params.associationId });
  const association = req => system ? null : loadAssociation(req.params.associationId);
  const load = async req => {
    if (!mongoose.isValidObjectId(req.params.faqId)) throw fail('Q&Aが見つかりません。', 404);
    const item = await Faq.findOne({ _id: req.params.faqId, ...scope(req) }).lean();
    if (!item) throw fail('Q&Aが見つかりません。', 404);
    return item;
  };
  faqsRouter.get(base, requireLogin, guard, wrap(async (req, res) => {
    const assoc = await association(req);
    const items = await Faq.find(scope(req)).sort({ position: 1, _id: 1 }).lean();
    res.render('faq-manage', { title: 'Q&Aの管理', association: assoc, system, baseUrl: url(req), items });
  }));
  faqsRouter.get(`${base}/:faqId/edit`, requireLogin, guard, wrap(async (req, res) => {
    const assoc = await association(req), item = await load(req);
    const categories = await Faq.distinct('category', scope(req));
    res.render('faq-form', { title: 'Q&Aの編集', association: assoc, system, baseUrl: url(req), item, categories, error: null });
  }));
  faqsRouter.get(`${base}/new`, requireLogin, guard, wrap(async (req, res) => {
    const assoc = await association(req), categories = await Faq.distinct('category', scope(req));
    res.render('faq-form', { title: 'Q&Aの登録', association: assoc, system, baseUrl: url(req), item: {}, categories, error: null });
  }));
  for (const edit of [false, true]) faqsRouter.post(edit ? `${base}/:faqId/edit` : base, requireLogin, guard, acceptPublicPhotos, verifyCsrfToken, wrap(async (req, res) => {
    const assoc = await association(req), original = edit ? await load(req) : {};
    let data;
    try { data = faqInput(req.body, system); } catch (error) {
      if (error.status !== 400) throw error;
      const item = { ...original, ...Object.fromEntries(['category', 'question', 'answer', 'relatedUrl'].map(key => [key, typeof req.body[key] === 'string' ? req.body[key] : ''])), published: req.body.published === 'on', openToPublic: system && req.body.openToPublic === 'on' };
      return res.status(400).render('faq-form', { title: edit ? 'Q&Aの編集' : 'Q&Aの登録', association: assoc, system, baseUrl: url(req), item, categories: await Faq.distinct('category', scope(req)), error: error.message });
    }
    await persistFaqImages({ files: req.files, body: req.body, previous: original.images, association: system ? null : assoc._id,
      persist: async images => {
        if (edit) await Faq.updateOne({ _id: original._id, ...scope(req) }, { $set: { ...data, images } }, { runValidators: true });
        else {
          const last = await Faq.findOne(scope(req)).sort({ position: -1 }).lean();
          await Faq.create({ ...data, images, ...scope(req), position: (last?.position ?? -1) + 1 });
        }
      }
    });
    req.session.notice = 'Q&Aを保存しました。';
    res.redirect(url(req));
  }));
  faqsRouter.post(`${base}/reorder`, requireLogin, guard, verifyCsrfToken, wrap(async (req, res) => {
    await association(req);
    const ids = req.body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !mongoose.isValidObjectId(id)) || new Set(ids).size !== ids.length) throw fail('並び順を確認してください。');
    const items = await Faq.find(scope(req)).sort({ position: 1, _id: 1 }).lean();
    // A filtered reorder may change only the slots occupied by that category.
    const category = typeof req.body.category === 'string' ? req.body.category : '';
    const subset = items.filter(item => !category || item.category === category);
    if (subset.length !== ids.length || subset.some(item => !ids.includes(String(item._id)))) throw fail('一覧が変更されています。再読み込みしてください。', 409);
    let index = 0;
    const ordered = items.map(item => !category || item.category === category ? ids[index++] : String(item._id));
    await Faq.bulkWrite(ordered.map((id, position) => ({ updateOne: { filter: { _id: id, ...scope(req) }, update: { $set: { position } } } })));
    res.json({ ok: true });
  }));
  faqsRouter.post(`${base}/:faqId/delete`, requireLogin, guard, verifyCsrfToken, wrap(async (req, res) => {
    await association(req);
    const item = await load(req);
    await Faq.deleteOne({ _id: item._id, ...scope(req) });
    await Promise.allSettled((item.images || []).filter(Boolean).map(deleteFaqImage));
    req.session.notice = 'Q&Aを削除しました。';
    res.redirect(url(req));
  }));
}

faqsRouter.get('/faq-images/:associationId/:fileId/:token', wrap(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const { associationId, fileId, token } = req.params;
  await loadAssociation(associationId);
  driveId(fileId);
  if (!/^[a-f0-9]{64}$/.test(token)) throw fail('画像が見つかりません。', 404);
  const imageUrl = `/faq-images/${associationId}/${fileId}/${token}`;
  const item = await Faq.findOne({ association: associationId, 'images.url': imageUrl }).lean();
  if (!item) throw fail('画像が見つかりません。', 404);
  if (!req.isAuthenticated?.()) throw fail('ログインしてください。', 403);
  if (!item.published) {
    return requirePermission('association.manage')(req, res, error => {
      if (error) return res.sendStatus(error.status || 403);
      serveFaqImage(req, res, associationId, fileId).catch(error => res.sendStatus(error.status || 500));
    });
  }
  await serveFaqImage(req, res, associationId, fileId);
}));
const serveFaqImage = async (req, res, associationId, fileId) => {
  const context = await attachmentContext(associationId);
  const image = await assertDriveItem(context.client, context.root, fileId, { allowRoot: false });
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'].includes(image.mimeType) || image.capabilities?.canDownload === false) throw fail('画像が見つかりません。', 404);
  const response = await context.client.request(`drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`);
  res.set({ 'Content-Type': image.mimeType, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
  await pipeline(Readable.fromWeb(response.body), res);
};

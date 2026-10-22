import { goodPlaceIdsByLikes, loadGoodPlaceHistoryReactions, parseCommentsEnabled, setGoodPlaceLike, addGoodPlaceComment, moderateGoodPlaceComment, loadGoodPlaceReactions } from '../services/goodPlaceReactionService.js';
import { canViewGoodPlaceAuthors, goodPlaceAuthorQuery, redactGoodPlaceAuthor } from '../services/goodPlaceDisclosureService.js';
import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { GoodPlace } from '../models/goodPlace.js';
import { dangerAccess, validateDangerReport } from '../services/dangerReportService.js';
import { loadGoodPlaceAssociation, createGoodPlaceWithPhoto, queueGoodPlaceNotifications, deleteGoodPlace } from '../services/goodPlaceService.js';
import { loadQuestionBoxAccess } from '../services/questionBoxService.js';
import { streamFile } from './messageAttachments.js';

export const goodPlacesRouter = express.Router();
goodPlacesRouter.get('/good-places/new', requireLogin, (req, res) => {
  const memberships = res.locals.dangerMemberships || [];
  if (!memberships.length) return res.status(403).render('error', { title: '投稿できません', message: '参加中の町内会からいいところを投稿できます。' });
  res.render('good-place-new', { title: 'わがまちのいいところ投稿', memberships });
});
goodPlacesRouter.use('/associations/:associationId/good-places', async (req, res, next) => {
  try {
    res.locals.goodPlaceAssociation = await loadGoodPlaceAssociation(req.params.associationId);
    res.set('Cache-Control', 'private, no-store');
    next();
  } catch (error) { next(error); }
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 } }).single('photo');
goodPlacesRouter.post('/associations/:associationId/good-places', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try { await dangerAccess(req.params.associationId, req.user._id); next(); } catch (error) { next(error); }
}, (req, res, next) => upload(req, res, error => {
  if (error) return next(Object.assign(new Error('写真は10MB以下で1枚選択してください。'), { status: 400 }));
  next();
}), async (req, res, next) => {
  try {
    const data = { ...validateDangerReport(req.body, req.file), commentsEnabled: parseCommentsEnabled(req.body.commentsEnabled) };
    const report = await createGoodPlaceWithPhoto({ data, association: req.params.associationId, author: req.user._id });
    try { await queueGoodPlaceNotifications(report); }
    catch (error) { console.error('Good place notification queue failed:', error.name); }
    req.session.notice = 'いいところ投稿を公開しました。';
    res.status(201).json({ url: `/associations/${report.association}/public` });
  } catch (error) { next(error); }
});
goodPlacesRouter.get('/associations/:associationId/good-places', async (req, res, next) => {
  try {
    const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
    const showGoodPlaceAuthors = await canViewGoodPlaceAuthors(req.params.associationId, req.user?._id);
    const sort = showGoodPlaceAuthors && req.query.sort === 'likes' ? 'likes' : 'newest';
    let reports;
    if (sort === 'likes') {
      const ids = await goodPlaceIdsByLikes(req.params.associationId, page);
      const rows = await goodPlaceAuthorQuery(GoodPlace.find({ association: req.params.associationId, _id: { $in: ids } }), showGoodPlaceAuthors).lean();
      const byId = new Map(rows.map(report => [String(report._id), report]));
      reports = ids.map(id => byId.get(String(id))).filter(Boolean);
    } else {
      reports = await goodPlaceAuthorQuery(GoodPlace.find({ association: req.params.associationId }), showGoodPlaceAuthors).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 50).limit(51).lean();
    }
    const historyReports = reports.slice(0, 50).map(report => redactGoodPlaceAuthor(report, showGoodPlaceAuthors));
    const visibleReports = showGoodPlaceAuthors ? await loadGoodPlaceHistoryReactions(req.params.associationId, historyReports) : historyReports;
    res.render('good-place-history', { sort, title: 'わがまちのいいところ', association: res.locals.goodPlaceAssociation, showGoodPlaceAuthors, reports: visibleReports, hasNext: reports.length > 50, page });
  } catch (error) { next(error); }
});
goodPlacesRouter.get('/associations/:associationId/good-places/:reportId/:photo(photo)?', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.reportId)) throw Object.assign(new Error('投稿が見つかりません。'), { status: 404 });
    const showGoodPlaceAuthors = !req.params.photo && await canViewGoodPlaceAuthors(req.params.associationId, req.user?._id);
    const rawReport = await goodPlaceAuthorQuery(GoodPlace.findOne({ _id: req.params.reportId, association: req.params.associationId }), showGoodPlaceAuthors).lean();
    const report = rawReport && redactGoodPlaceAuthor(rawReport, showGoodPlaceAuthors);
    if (!report) throw Object.assign(new Error('投稿が見つかりません。'), { status: 404 });
    if (req.params.photo) return await streamFile(req, res, report.photoAttachment);
    let canDelete = false;
    if (req.user && showGoodPlaceAuthors) {
      try { canDelete = (await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id })).canAnswer || String(report.author?._id || report.author) === String(req.user._id); }
      catch (error) { if (error.status !== 403) throw error; }
    }
    const owner = showGoodPlaceAuthors && String(report.author?._id || report.author) === String(req.user._id);
    const commentPage = Math.max(1, Math.min(100000, Number.parseInt(req.query?.commentPage, 10) || 1));
    const reactions = showGoodPlaceAuthors ? await loadGoodPlaceReactions({ associationId: req.params.associationId, reportId: req.params.reportId, userId: req.user._id, owner, page: commentPage }) : null;
    res.render('good-place-detail', { reactions, title: report.title, association: res.locals.goodPlaceAssociation, report, canDelete, showGoodPlaceAuthors });
  } catch (error) { next(error); }
});
goodPlacesRouter.post('/associations/:associationId/good-places/:reportId/delete', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try {
    const { photoCleanupPending } = await deleteGoodPlace({ associationId: req.params.associationId, reportId: req.params.reportId, userId: req.user._id });
    req.session.notice = photoCleanupPending ? 'いいところ投稿を削除しました。Google Driveの写真は削除できませんでした。' : 'いいところ投稿を削除しました。';
    res.redirect(`/associations/${req.params.associationId}/public`);
  } catch (error) { next(error); }
});

const reactionInput = req => ({ associationId: req.params.associationId, reportId: req.params.reportId, userId: req.user._id });
const reactionReturn = (req, res) => res.redirect(`/associations/${req.params.associationId}/good-places/${req.params.reportId}#good-place-reactions`);
goodPlacesRouter.post('/associations/:associationId/good-places/:reportId/like', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!['0', '1'].includes(req.body.liked)) throw Object.assign(new Error('ライク♡の操作を確認してください。'), { status: 400 });
    await setGoodPlaceLike(reactionInput(req), req.body.liked === '1');
    res.redirect(`/associations/${req.params.associationId}/good-places/${req.params.reportId}`);
  } catch (error) { next(error); }
});
goodPlacesRouter.post('/associations/:associationId/good-places/:reportId/comments', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try {
    await addGoodPlaceComment(reactionInput(req), req.body.body);
    req.session.notice = 'コメントを投稿しました。';
    reactionReturn(req, res);
  } catch (error) { next(error); }
});
goodPlacesRouter.post('/associations/:associationId/good-places/:reportId/comments/:commentId/visibility', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!['0', '1'].includes(req.body.hidden)) throw Object.assign(new Error('コメントの表示設定を確認してください。'), { status: 400 });
    await moderateGoodPlaceComment(reactionInput(req), req.params.commentId, req.body.hidden === '1');
    req.session.notice = req.body.hidden === '1' ? 'コメントを非表示にしました。' : 'コメントを再表示しました。';
    reactionReturn(req, res);
  } catch (error) { next(error); }
});

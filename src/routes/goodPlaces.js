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
    const data = validateDangerReport(req.body, req.file);
    const report = await createGoodPlaceWithPhoto({ data, association: req.params.associationId, author: req.user._id });
    try { await queueGoodPlaceNotifications(report); }
    catch (error) { console.error('Good place notification queue failed:', error.name); }
    res.status(201).json({ url: `/associations/${report.association}/good-places/${report._id}` });
  } catch (error) { next(error); }
});
goodPlacesRouter.get('/associations/:associationId/good-places', async (req, res, next) => {
  try {
    const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
    const showGoodPlaceAuthors = await canViewGoodPlaceAuthors(req.params.associationId, req.user?._id);
    const reports = await goodPlaceAuthorQuery(GoodPlace.find({ association: req.params.associationId }), showGoodPlaceAuthors).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 50).limit(51).lean();
    res.render('good-place-history', { title: 'わがまちのいいところの地図・履歴', association: res.locals.goodPlaceAssociation, showGoodPlaceAuthors, reports: reports.slice(0, 50).map(report => redactGoodPlaceAuthor(report, showGoodPlaceAuthors)), hasNext: reports.length > 50, page });
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
      try { canDelete = (await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id })).canAnswer; }
      catch (error) { if (error.status !== 403) throw error; }
    }
    res.render('good-place-detail', { title: report.title, association: res.locals.goodPlaceAssociation, report, canDelete, showGoodPlaceAuthors });
  } catch (error) { next(error); }
});
goodPlacesRouter.post('/associations/:associationId/good-places/:reportId/delete', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try {
    const { photoCleanupPending } = await deleteGoodPlace({ associationId: req.params.associationId, reportId: req.params.reportId, userId: req.user._id });
    req.session.notice = photoCleanupPending ? 'いいところ投稿を削除しました。Google Driveの写真は削除できませんでした。' : 'いいところ投稿を削除しました。';
    res.redirect(`/associations/${req.params.associationId}/good-places`);
  } catch (error) { next(error); }
});

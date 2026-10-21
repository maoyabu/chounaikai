import { deleteDangerReport } from '../services/dangerReportDeletionService.js';
import { loadQuestionBoxAccess } from '../services/questionBoxService.js';
import { createDangerReportWithPhoto, ensureDangerReportDrivePhoto } from '../services/dangerReportPhotoService.js';
import { streamFile } from './messageAttachments.js';
import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { DangerReport } from '../models/dangerReport.js';
import { dangerAccess, validateDangerReport } from '../services/dangerReportService.js';
export const dangerReportsRouter = express.Router();
dangerReportsRouter.use(requireLogin);
dangerReportsRouter.use('/:associationId/dangers', async (req, res, next) => {
  try { res.locals.dangerAssociation = await dangerAccess(req.params.associationId, req.user._id); res.set('Cache-Control', 'private, no-store'); next(); } catch (error) { next(error); }
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 } }).single('photo');
dangerReportsRouter.post('/:associationId/dangers', verifyCsrfToken, (req, res, next) => upload(req, res, error => {
  if (error) return next(Object.assign(new Error('写真は10MB以下で1枚選択してください。'), { status: 400 }));
  next();
}), async (req, res, next) => {
  try {
    const data = validateDangerReport(req.body, req.file);
    const report = await createDangerReportWithPhoto({ data, association: req.params.associationId, author: req.user._id });
    res.status(201).json({ url: `/associations/${report.association}/dangers/${report._id}` });
  } catch (error) { next(error); }
});
dangerReportsRouter.get('/:associationId/dangers', async (req, res, next) => {
  try {
    const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
    const reports = await DangerReport.find({ association: req.params.associationId }).populate('author', 'displayname').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 50).limit(51).lean();
    res.render('danger-history', { title: '緊急・危険情報の地図・履歴', association: res.locals.dangerAssociation, reports: reports.slice(0,50), hasNext: reports.length > 50, page, mapsKey: process.env.GOOGLE_MAPS_BROWSER_KEY || '' });
  } catch (error) { next(error); }
});
dangerReportsRouter.get('/:associationId/dangers/:reportId/:photo(photo)?', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.reportId)) throw Object.assign(new Error('投稿が見つかりません。'), { status: 404 });
    const query = DangerReport.findOne({ _id: req.params.reportId, association: req.params.associationId });
    if (req.params.photo) query.select('+photo');
    const report = await query.populate('author', 'displayname').lean();
    if (!report) throw Object.assign(new Error('投稿が見つかりません。'), { status: 404 });
    if (req.params.photo) {
      const attachment = await ensureDangerReportDrivePhoto(report);
      return await streamFile(req, res, attachment);
    }
    const { canAnswer: canDelete } = await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id });
    res.render('danger-detail', { title: report.title, association: res.locals.dangerAssociation, report, canDelete });
  } catch (error) { next(error); }
});

dangerReportsRouter.post('/:associationId/dangers/:reportId/delete', verifyCsrfToken, async (req, res, next) => {
  try {
    const { photoCleanupPending } = await deleteDangerReport({ associationId: req.params.associationId, reportId: req.params.reportId, userId: req.user._id });
    req.session.notice = photoCleanupPending
      ? '緊急・危険情報を削除しました。Google Driveの写真は削除できませんでした。Driveのメッセージ添付フォルダをご確認ください。'
      : '緊急・危険情報を削除しました。';
    res.redirect(`/associations/${req.params.associationId}/dangers`);
  } catch (error) { next(error); }
});

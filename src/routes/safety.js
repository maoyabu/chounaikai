import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { buildingStatuses, safetyStatuses, safetyEventKey, memberSafetyStatus, householdSafetyState } from '../lib/safetyStatus.js';
import { saveResidentSafety, loadOfficerSafety } from '../services/safetyService.js';
import { listSafetyHistory, loadSafetyHistory } from '../services/safetyHistoryService.js';
import { createSafetyReport, loadSafetyReport } from '../services/safetyReportService.js';
import { safetyReportPdf } from '../services/safetyReportPdf.js';

export const safetyRouter = express.Router();
safetyRouter.use(requireLogin);
const options = { buildingStatuses, safetyStatuses, safetyEventKey, memberSafetyStatus, householdSafetyState };

safetyRouter.get('/:associationId/safety/officer/report', async (req, res, next) => {
  try {
    const report = await createSafetyReport(req.params.associationId, req.user._id, req.session);
    res.set('Cache-Control', 'private, no-store');
    return res.redirect(`/associations/${req.params.associationId}/safety/officer/report/${report.token}`);
  } catch (error) { return next(error); }
});

safetyRouter.get('/:associationId/safety/officer/report/:token', async (req, res, next) => {
  try {
    const report = await loadSafetyReport(req.params.associationId, req.user._id, req.params.token, req.session);
    res.set('Cache-Control', 'private, no-store');
    return res.render('safety-report', { report, title: '災害時安否状況報告書' });
  } catch (error) { return next(error); }
});

safetyRouter.get('/:associationId/safety/officer/report/:token/pdf', async (req, res, next) => {
  try {
    const report = await loadSafetyReport(req.params.associationId, req.user._id, req.params.token, req.session);
    const pdf = await safetyReportPdf(report);
    res.set('Cache-Control', 'private, no-store');
    res.type('application/pdf');
    if (req.query.download === '1') res.attachment('災害時安否状況報告書.pdf');
    else res.set('Content-Disposition', 'inline; filename="safety-report.pdf"');
    return res.send(pdf);
  } catch (error) { return next(error); }
});

safetyRouter.get('/:associationId/safety/officer/history', async (req, res, next) => {
  try {
    const context = await listSafetyHistory(req.params.associationId, req.user._id);
    return res.render('alert-history-list', { ...context, historyType: 'safety', title: '過去の安否確認一覧' });
  } catch (error) { return next(error); }
});

safetyRouter.get('/:associationId/safety/officer/history/:eventKey', async (req, res, next) => {
  try {
    const context = await loadSafetyHistory(req.params.associationId, req.user._id, req.params.eventKey);
    return res.render(context.legacyHistory ? 'safety-legacy-history' : 'safety-officer', { ...options, ...context, title: '過去の安否確認' });
  } catch (error) { return next(error); }
});

safetyRouter.get('/:associationId/safety', async (req, res, next) => {
  try {
    return res.redirect(`/associations/${req.params.associationId}/disaster?tab=safety`);
  } catch (error) { return next(error); }
});

safetyRouter.post('/:associationId/safety', verifyCsrfToken, async (req, res, next) => {
  try {
    await saveResidentSafety({ associationId: req.params.associationId, userId: req.user._id, body: req.body });
    req.session.notice = '安否情報を送信しました。';
    return res.redirect(`/associations/${req.params.associationId}/disaster?tab=safety`);
  } catch (error) { return next(error); }
});

safetyRouter.get('/:associationId/safety/officer', async (req, res, next) => {
  try {
    const context = await loadOfficerSafety(req.params.associationId, req.user._id);
    return res.render('safety-officer', { ...options, ...context, title: `${context.association.name} 安否確認` });
  } catch (error) { return next(error); }
});

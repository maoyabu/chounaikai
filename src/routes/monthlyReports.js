import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { loadQuestionBoxAccess } from '../services/questionBoxService.js';
import { currentReportMonth, loadMonthlyReport, reportPeriod, reportMonthLabel, eventSchedule, saveMonthlyInformation } from '../services/monthlyReportService.js';
import { monthlyReportWorkbook } from '../services/monthlyReportExcel.js';

export const monthlyReportsRouter = express.Router();
monthlyReportsRouter.use(requireLogin);
const access = async req => {
  const result = await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id });
  if (!result.canAnswer) throw Object.assign(new Error('月次報告は役員と町内会管理者のみ利用できます。'), { status: 403 });
  return result.association;
};

monthlyReportsRouter.get('/:associationId/monthly-reports', async (req, res, next) => {
  try {
    const association = await access(req);
    const month = req.query.month === undefined ? currentReportMonth() : req.query.month;
    const report = await loadMonthlyReport({ association, month });
    res.set('Cache-Control', 'private, no-store');
    return res.render('monthly-report', { title: `${association.name} 月次報告`, association, report, reportMonthLabel, eventSchedule });
  } catch (error) { return next(error); }
});

monthlyReportsRouter.post('/:associationId/monthly-reports', verifyCsrfToken, async (req, res, next) => {
  try {
    const association = await access(req);
    const { month } = reportPeriod(req.body.month);
    await saveMonthlyInformation({ association: association._id, month, information: req.body.information, user: req.user._id });
    req.session.notice = `${reportMonthLabel(month)}の情報共有事項を保存しました。`;
    return res.redirect(`/associations/${association._id}/monthly-reports?month=${month}`);
  } catch (error) { return next(error); }
});

monthlyReportsRouter.get('/:associationId/monthly-reports.xlsx', async (req, res, next) => {
  try {
    const association = await access(req);
    const report = await loadMonthlyReport({ association, month: req.query.month });
    const buffer = await monthlyReportWorkbook(association, report).xlsx.writeBuffer();
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${association.name}_${report.month}_月次報告.xlsx`)}`);
    return res.send(buffer);
  } catch (error) { return next(error); }
});

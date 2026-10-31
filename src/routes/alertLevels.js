import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { alertLevels } from '../public/alert-level-data.js';
import { loadAlertLevelOfficer, saveAlertLevel } from '../services/alertLevelService.js';
import { listAlertHistory, loadAlertHistory } from '../services/safetyHistoryService.js';
import { loadShelters } from '../services/shelterService.js';

export const alertLevelsRouter = express.Router();
alertLevelsRouter.use(requireLogin);

alertLevelsRouter.get('/:associationId/alert-level/history', async (req, res, next) => {
  try {
    const context = await listAlertHistory(req.params.associationId, req.user._id);
    return res.render('alert-history-list', { ...context, historyType: 'alert', title: '過去の警戒情報一覧' });
  } catch (error) { return next(error); }
});

alertLevelsRouter.get('/:associationId/alert-level/history/:eventKey', async (req, res, next) => {
  try {
    const context = await loadAlertHistory(req.params.associationId, req.user._id, req.params.eventKey);
    return res.render('alert-history-detail', { ...context, title: '警戒情報の履歴' });
  } catch (error) { return next(error); }
});

alertLevelsRouter.get('/:associationId/alert-level', async (req, res, next) => {
  try {
    const association = await loadAlertLevelOfficer(req.params.associationId, req.user._id);
    if (req.query.tab === 'shelters') {
      const context = await loadShelters(req.params.associationId, req.user._id);
      return res.render('association-shelters-manage', { ...context, title: `${association.name} 防災関連情報` });
    }
    return res.render('association-alert-level', { title: `${association.name} 防災関連情報`, association, alertLevels });
  } catch (error) { return next(error); }
});

alertLevelsRouter.post('/:associationId/alert-level', verifyCsrfToken, async (req, res, next) => {
  try {
    const level = await saveAlertLevel({ associationId: req.params.associationId, userId: req.user._id, value: req.body.alertLevel, actorName: req.user.displayname || req.user.username });
    req.session.notice = level ? `警戒レベル${level}を登録しました。` : '警戒レベルを解除しました。';
    return res.redirect(`/associations/${req.params.associationId}/alert-level`);
  } catch (error) { return next(error); }
});

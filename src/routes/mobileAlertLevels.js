import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { loadAlertLevelOfficer, saveAlertLevel } from '../services/alertLevelService.js';
import { listAlertHistory } from '../services/safetyHistoryService.js';
import { mobileDisasterInformation } from './disasterInformation.js';

export const mobileAlertLevelsRouter = express.Router({ mergeParams: true });
const handle = callback => async (req, res, next) => { try { await callback(req, res); } catch (error) { next(error); } };
export const mobileAlertHistoryEvent = event => ({
  id: event.eventKey, startedAt: event.startedAt || null, endedAt: event.endedAt || null,
  peakLevel: event.peakLevel || 0, historyIncomplete: Boolean(event.historyIncomplete),
  changes: [...(event.changes || [])].sort((a, b) => new Date(a.at) - new Date(b.at)).map((change, index) => ({
    id: String(change._id || index), level: change.level, at: change.at || null, kind: change.kind,
    byName: change.byName || change.by?.displayname || change.by?.username || '未記録'
  }))
});
mobileAlertLevelsRouter.use(requireLogin, provideCsrfToken, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
mobileAlertLevelsRouter.get('/', handle(async (req, res) => {
  const association = await loadAlertLevelOfficer(req.params.associationId, req.user._id);
  res.json({ information: mobileDisasterInformation({ association, informationLinks: [], shelters: [] }), csrfToken: res.locals.csrfToken });
}));
mobileAlertLevelsRouter.post('/', verifyCsrfToken, handle(async (req, res) => {
  const level = await saveAlertLevel({ associationId: req.params.associationId, userId: req.user._id,
    value: req.body.alertLevel, actorName: req.user.displayname || req.user.username });
  res.json({ level });
}));
mobileAlertLevelsRouter.get('/history', handle(async (req, res) => {
  const { events } = await listAlertHistory(req.params.associationId, req.user._id);
  res.json({ events: events.map(mobileAlertHistoryEvent) });
}));

import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { loadDisasterInformation } from '../services/disasterInformationService.js';

export const disasterInformationRouter = express.Router();
disasterInformationRouter.use(requireLogin);
disasterInformationRouter.get('/:associationId/disaster', async (req, res, next) => {
  try {
    const context = await loadDisasterInformation(req.params.associationId, req.user._id, req.query);
    res.set('Cache-Control', 'private, no-store');
    return res.render('disaster-information', { ...context, title: `${context.association.name} 防災情報` });
  } catch (error) { return next(error); }
});

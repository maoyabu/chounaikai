import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { loadDisasterInformation } from '../services/disasterInformationService.js';
import { loadShelters } from '../services/shelterService.js';
import { alertLevels, alertLevelSource } from '../public/alert-level-data.js';

export const mobileDisasterInformation = context => ({
  associationName: context.association.name,
  alertLevel: context.association.alertLevel || 0,
  alertLevelUpdatedAt: context.association.alertLevelUpdatedAt || null,
  alertLevels: alertLevels.map(({ level, name, action, description, guidance }) => ({ level, name, action, description, guidance })),
  alertImagePath: '/assets/images/alert-levels.jpg',
  alertSourceURL: alertLevelSource,
  informationLinks: context.informationLinks.map(({ name, url }) => ({ name, url })),
  shelters: context.shelters.map(shelter => ({
    id: String(shelter._id), name: shelter.name, address: shelter.address,
    phone: shelter.phone || '', capacity: shelter.capacity ?? null, kind: shelter.kind || '',
    dangerPoints: shelter.dangerPoints || '', photos: (shelter.photos || []).map(photo => photo.url),
    acceptance: shelter.acceptance ? { status: shelter.acceptance.status, comment: shelter.acceptance.comment || '',
      registeredAt: shelter.acceptance.registeredAt, registeredByName: shelter.acceptance.registeredByName || '' } : null
  }))
});

export const mobileDisasterRouter = express.Router();
mobileDisasterRouter.use(requireLogin);
mobileDisasterRouter.get('/:associationId/disaster', async (req, res, next) => {
  try {
    const context = await loadShelters(req.params.associationId, req.user._id);
    res.set('Cache-Control', 'private, no-store');
    res.json(mobileDisasterInformation(context));
  } catch (error) { next(error); }
});

export const disasterInformationRouter = express.Router();
disasterInformationRouter.use(requireLogin);
disasterInformationRouter.get('/:associationId/disaster', async (req, res, next) => {
  try {
    const context = await loadDisasterInformation(req.params.associationId, req.user._id, req.query);
    res.set('Cache-Control', 'private, no-store');
    return res.render('disaster-information', { ...context, title: `${context.association.name} 防災情報` });
  } catch (error) { return next(error); }
});

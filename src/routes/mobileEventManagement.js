import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { AssociationEvent } from '../models/associationEvent.js';
import { associationFeatureEnabled } from '../services/associationFeatureService.js';
import { acceptEventImage } from '../services/publicPageImageService.js';
import { officerAccess, createAssociationEvent, updateAssociationEvent, completeAssociationEvent, deleteAssociationEvent } from './associationEvents.js';
import { mobileCalendarEvent } from './mobileEvents.js';

export const mobileManagedEvent = event => ({
  ...mobileCalendarEvent(event), id: String(event._id), hasEndDate: event.hasEndDate !== false,
  visible: Boolean(event.visible), open: Boolean(event.open), implementationReport: event.implementationReport || ''
});
export const mobileEventManagementRouter = express.Router({ mergeParams: true });
mobileEventManagementRouter.use(requireLogin, provideCsrfToken, async (req, res, next) => {
  try {
    const association = await officerAccess(req);
    if (!associationFeatureEnabled(association, 'events')) throw Object.assign(new Error('この町内会では行事カレンダーを利用していません。'), { status: 404 });
    res.locals.mobileEvents = true;
    res.locals.eventAssociation = association;
    res.set('Cache-Control', 'private, no-store');
    next();
  } catch (error) { next(error); }
});
mobileEventManagementRouter.get('/', async (req, res, next) => {
  try {
    const association = res.locals.eventAssociation;
    const events = await AssociationEvent.find({ association: association._id }).sort({ startDate: -1, startTime: -1 }).lean();
    const categories = [...new Set([...(association.eventCategories || []), ...events.map(event => event.category)])].sort((a, b) => a.localeCompare(b, 'ja'));
    res.json({ associationName: association.name, events: events.map(mobileManagedEvent), categories, csrfToken: res.locals.csrfToken });
  } catch (error) { next(error); }
});
// Reuse the Web handlers for validation, tenant-scoped writes, images and notices.
mobileEventManagementRouter.post('/', acceptEventImage, verifyCsrfToken, createAssociationEvent);
mobileEventManagementRouter.post('/:eventId', acceptEventImage, verifyCsrfToken, updateAssociationEvent);
mobileEventManagementRouter.post('/:eventId/complete', verifyCsrfToken, completeAssociationEvent);
mobileEventManagementRouter.post('/:eventId/delete', verifyCsrfToken, deleteAssociationEvent);

import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { dangerAccess } from '../services/dangerReportService.js';
import { associationFeatureEnabled } from '../services/associationFeatureService.js';
import { visibleEvents, calendarWindow } from '../services/associationEventService.js';

export const mobileEventsRouter = express.Router();
export const mobileCalendarEvent = event => ({
  id: `${event._id}:${event.startDate}`, eventId: String(event._id), title: event.title, body: event.body,
  startDate: event.startDate, endDate: event.endDate, startTime: event.startTime, endTime: event.endTime,
  allDay: Boolean(event.allDay), category: event.category, color: event.color, completed: Boolean(event.completed),
  recurrence: event.recurrence || { frequency: 'none' }, imageURL: event.image?.url || null,
  imageCaption: event.imageCaption || '', youtubeURL: event.youtubeUrl || '', qrURL: event.qrUrl || '', qrCaption: event.qrCaption || ''
});
mobileEventsRouter.use(requireLogin);
mobileEventsRouter.get('/:associationId/calendar', async (req, res, next) => {
  try {
    const association = await dangerAccess(req.params.associationId, req.user._id);
    if (!associationFeatureEnabled(association, 'events')) throw Object.assign(new Error('この町内会では行事カレンダーを利用していません。'), { status: 404 });
    const window = calendarWindow(req.query.month);
    const events = await visibleEvents([association._id], { publicOnly: false, now: window.first });
    events.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.startTime.localeCompare(b.startTime) || String(a._id).localeCompare(String(b._id)));
    res.set('Cache-Control', 'private, no-store');
    res.json({ associationName: association.name, currentMonth: window.currentMonth, previousMonth: window.previousMonth,
      nextMonth: window.nextMonth, months: window.months, events: events.map(mobileCalendarEvent) });
  } catch (error) { next(error); }
});

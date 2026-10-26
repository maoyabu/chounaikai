import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { eventValues, expandRecurringEvents } from '../src/services/associationEventService.js';
import { AssociationEvent } from '../src/models/associationEvent.js';

const input = { title: '活動', body: '活動内容', startDate: '2026-10-01', startTime: '09:00', endTime: '12:00', category: '交流', color: '#287b68' };

test('single-day end time is saved and checked independently of the end-date toggle', () => {
  const event = eventValues(input);
  assert.equal(event.endDate, input.startDate);
  assert.equal(event.endTime, '12:00');
  assert.equal(event.hasEndDate, false);
  for (const endTime of ['08:00', '09:00', '']) assert.throws(() => eventValues({ ...input, endTime }), /時間/);
  const overnight = eventValues({ ...input, hasEndDate: 'on', endDate: '2026-10-02', endTime: '08:00' });
  assert.equal(overnight.endDate, '2026-10-02');
  assert.equal(overnight.endTime, '08:00');
  assert.throws(() => eventValues({ ...input, hasEndDate: 'on', endDate: input.startDate, endTime: '08:00' }), /終了時間/);
  const allDay = eventValues({ ...input, allDay: 'on', startTime: '', endTime: '' });
  assert.equal(allDay.startTime, '00:00');
  assert.equal(allDay.endTime, '23:59');
});

test('monthly ordinal weekday survives schema casting and expands to third Saturdays', () => {
  const event = eventValues({ ...input, recurrenceFrequency: 'monthly', monthlyMode: 'weekday', monthWeek: '3', monthWeekday: '6', recurrenceUntil: '2027-01-31' });
  const saved = new AssociationEvent(event).toObject();
  assert.equal(saved.recurrence.monthWeek, 3);
  assert.equal(saved.recurrence.monthWeekday, 6);
  assert.deepEqual(expandRecurringEvents([saved], '2026-10-01', '2027-02-01').map(item => item.startDate), ['2026-10-17', '2026-11-21', '2026-12-19', '2027-01-16']);
  assert.throws(() => eventValues({ ...input, recurrenceFrequency: 'monthly', monthlyMode: 'weekday', monthWeek: '6', monthWeekday: '6' }), /第何曜日/);
  assert.throws(() => eventValues({ ...input, recurrenceFrequency: 'monthly', monthlyMode: 'weekday', monthWeek: '3', monthWeekday: '7' }), /第何曜日/);
});

test('fifth weekdays skip absent months and legacy monthly dates still work', () => {
  const event = { ...eventValues(input), recurrence: { frequency: 'monthly', monthlyMode: 'weekday', monthWeek: 5, monthWeekday: 6 } };
  assert.deepEqual(expandRecurringEvents([event], '2026-10-01', '2026-12-31').map(item => item.startDate), ['2026-10-31']);
  event.recurrence = { frequency: 'monthly', monthDays: [15, 31] };
  assert.deepEqual(expandRecurringEvents([event], '2026-10-01', '2026-11-30').map(item => item.startDate), ['2026-10-15', '2026-10-31', '2026-11-15']);
});

test('multi-day repetitions preserve duration and time across month/year boundaries', () => {
  const event = eventValues({ ...input, startDate: '2026-12-31', hasEndDate: 'on', endDate: '2027-01-02', endTime: '08:00', recurrenceFrequency: 'monthly', monthDays: '31' });
  const occurrences = expandRecurringEvents([event], '2027-01-01', '2027-02-28');
  assert.deepEqual(occurrences.map(item => [item.startDate, item.endDate, item.endTime]), [['2026-12-31', '2027-01-02', '08:00'], ['2027-01-31', '2027-02-02', '08:00']]);
});

test('shared form offers monthly ordinal weekdays and keeps end time enabled without an end date', async () => {
  const html = await ejs.renderFile('src/views/partials/association-event-form.ejs', { event: null, action: '/events', csrfToken: 'token', categories: [] });
  assert.match(html, /name="monthWeek"/);
  assert.match(html, /name="monthWeekday"/);
  assert.match(html, /第何曜日で指定/);
  assert.match(html, /endTime.disabled = allDay.checked;/);
  assert.doesNotMatch(html, /endTime.disabled = allDay.checked \|\| !hasEnd.checked/);
});

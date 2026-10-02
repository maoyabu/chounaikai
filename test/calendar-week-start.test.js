import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { calendarMonths, calendarWindow, expandRecurringEvents } from '../src/services/associationEventService.js';

const weekdays = ['月', '火', '水', '木', '金', '土', '日'];

test('event calendar aligns every weekday, leap February and year boundaries with Monday', () => {
  for (const [month, blanks, days] of [
    ['2026-06', 0, 30], ['2026-09', 1, 30], ['2026-04', 2, 30],
    ['2026-10', 3, 31], ['2026-05', 4, 31], ['2026-08', 5, 31],
    ['2026-11', 6, 30], ['2024-02', 3, 29], ['2025-12', 0, 31], ['2027-01', 4, 31]
  ]) {
    const cells = calendarWindow(month).months[0].cells;
    assert.deepEqual(cells.slice(0, blanks), Array(blanks).fill(null), month);
    assert.equal(cells[blanks], `${month}-01`, month);
    assert.equal(cells.length, blanks + days, month);
    for (const [index, date] of cells.entries()) {
      if (date) assert.equal(index % 7, (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7, date);
    }
  }
});

test('shared event and equipment calendar headings render Monday through Sunday', async () => {
  const eventHtml = await ejs.renderFile('src/views/partials/association-event-calendar.ejs', {
    calendarAnchor: 'events', calendarPath: '/dashboard', calendarWindow: calendarWindow('2026-11'),
    months: calendarMonths(new Date(2026, 10, 1)), events: []
  });
  assert.deepEqual([...eventHtml.matchAll(/class="association-event-weekday">([^<]+)</g)].slice(0, 7).map(match => match[1]), weekdays);
  const equipmentHtml = await ejs.renderFile('src/views/equipment-loans.ejs', {
    assetVersion: 'test', showNotificationPrompt: false, title: '貸出', currentUser: null, currentPath: '', notice: null,
    csrfToken: 'test', base: '/equipment', canAnswer: false,
    item: { _id: 'test', name: '備品', quantity: 1, unit: '個', lendable: false },
    cells: [], requests: [], month: '2026-11', previous: '2026-10', next: '2026-12', today: '2026-11-01'
  });
  const grid = equipmentHtml.split('class="equipment-calendar">')[1].split('</div>')[0];
  assert.deepEqual([...grid.matchAll(/<strong>([^<]+)<\/strong>/g)].map(match => match[1]), weekdays);
});

test('weekly recurrence retains stored Sunday and Monday weekday values', () => {
  const events = expandRecurringEvents([
    { startDate: '2026-11-01', recurrence: { frequency: 'weekly', weekdays: [0, 1] } }
  ], '2026-11-01', '2026-11-09');
  assert.deepEqual(events.map(event => event.startDate), ['2026-11-01', '2026-11-02', '2026-11-08', '2026-11-09']);
});

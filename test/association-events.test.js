import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import { calendarMonths, calendarWindow, eventValues } from '../src/services/associationEventService.js';

test('event dates and times are validated for single and multiple day events', () => {
  const input = { title: '夏祭り', body: '会場案内', startDate: '2026-09-17', startTime: '18:00', endTime: '20:00', category: '祭り', color: '#287b68', visible: 'on' };
  assert.deepEqual(eventValues(input), { title: '夏祭り', body: '会場案内', startDate: '2026-09-17', endDate: '2026-09-17', startTime: '18:00', endTime: '20:00', category: '祭り', color: '#287b68', visible: true, open: false, imageCaption: '', youtubeUrl: '', qrUrl: '', qrCaption: '' });
  assert.throws(() => eventValues({ ...input, endTime: '17:00' }), /終了時間/);
  assert.throws(() => eventValues({ ...input, startDate: '2026-02-30' }), /日付/);
  assert.throws(() => eventValues({ ...input, endDate: '2026-09-16' }), /日付/);
  assert.equal(eventValues({ ...input, endDate: '2026-09-18', endTime: '09:00' }).endDate, '2026-09-18');
});

test('calendar starts at the current month and includes three months', () => {
  const months = calendarMonths(new Date(2026, 8, 17));
  assert.deepEqual(months.map(month => month.label), ['2026年9月', '2026年10月', '2026年11月']);
  assert.equal(months[0].cells.filter(Boolean).length, 30);
  assert.equal(months[1].cells.filter(Boolean).length, 31);
});

test('calendar can move to past and future months', () => {
  const past = calendarWindow('2025-12', new Date(2026, 8, 17));
  assert.deepEqual(past.months.map(month => month.label), ['2025年12月', '2026年1月', '2026年2月']);
  assert.equal(past.previousMonth, '2025-11');
  assert.equal(past.nextMonth, '2026-01');
  assert.equal(calendarWindow('2027-03').currentMonth, '2027-03');
  assert.equal(calendarWindow('invalid', new Date(2026, 8, 17)).currentMonth, '2026-09');
});

test('public association page shows photos, introduction, counts, officers and districts', async () => {
  const association = { _id: '507f1f77bcf86cd799439011', name: 'テスト町内会', serviceArea: '横浜市', introduction: '地域の活動を紹介します。', publicPhotos: [{ url: 'https://example.test/one.jpg' }, { url: 'https://example.test/two.jpg' }] };
  const html = await ejs.renderFile(fileURLToPath(new URL('../src/views/association-public-events.ejs', import.meta.url)), {
    title: '公開ページ', currentUser: null, association, events: [], months: calendarMonths(new Date(2026, 8, 1)), calendarWindow: calendarWindow('2026-09'), fiscalYear: 2026,
    officers: [{ user: { displayname: '山田 花子' }, role: { name: '会長' }, department: { name: '総務部' } }],
    householdCount: 12, residentCount: 34, districtStats: [{ name: '１班', householdCount: 5, residentCount: 16 }]
  });
  for (const label of ['one.jpg', 'two.jpg', '地域の活動を紹介します。', '12', '34', '山田 花子', '１班', '5世帯', '16人', '町内会行事カレンダー']) assert.match(html, new RegExp(label));
});

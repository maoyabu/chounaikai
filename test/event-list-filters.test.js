import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ejs from 'ejs';

test('event list combines completion, fiscal year, department and normalized keywords independently per list', async () => {
  const control = value => ({ value, addEventListener(type, callback) { this.update = callback; } });
  const controls = { completed: control('show'), year: control(''), department: control(''), search: control('') };
  Object.entries(controls).forEach(([key, input]) => input.dataset = { eventFilter: key });
  const items = [
    { dataset: { completed: 'true', startDate: '2026-03-31', department: 'a', search: '春祭り ＡＢＣ' } },
    { dataset: { completed: 'false', startDate: '2026-04-01', department: 'b', search: '春祭り 案内' } },
    { dataset: { completed: 'false', startDate: '2026-04-02', department: '', search: '清掃活動' } }
  ];
  const empty = {};
  const scope = { querySelectorAll: selector => selector === '[data-event-filter]' ? Object.values(controls) : items, querySelector: () => empty };
  vm.runInNewContext(await readFile(new URL('../src/public/event-list-filters.js', import.meta.url), 'utf8'), { document: { querySelectorAll: () => [scope] } });
  const change = (key, value) => { controls[key].value = value; controls[key].update(); };
  change('search', '春祭り abc');
  assert.deepEqual(items.map(item => item.hidden), [false, true, true]);
  change('completed', 'hide');
  assert.equal(empty.hidden, false);
  change('search', '');
  change('year', '2026');
  change('department', 'b');
  assert.deepEqual(items.map(item => item.hidden), [true, false, true]);
  change('department', 'unset');
  assert.deepEqual(items.map(item => item.hidden), [true, true, false]);
  change('year', '2025');
  assert.equal(empty.hidden, false);
});

test('management filter renders fiscal year boundary and escapes department labels', async () => {
  const html = await ejs.renderFile(new URL('../src/views/partials/event-list-filters.ejs', import.meta.url).pathname, {
    manageFilters: true, events: [{ startDate: '2026-03-31' }, { startDate: '2026-04-01' }], departments: [{ _id: 'a', name: '<総務部>' }]
  });
  assert.match(html, /2025年度/);
  assert.match(html, /2026年度/);
  assert.match(html, /&lt;総務部&gt;/);
});

test('management and shared calendar render filter controls with event metadata', async () => {
  const { renderView } = await import('../test-support/renderView.js');
  const { calendarWindow } = await import('../src/services/associationEventService.js');
  const events = [{ _id: 'event1', title: '夏祭り', body: '地域のお祭り', startDate: '2026-07-01', endDate: '2026-07-01', category: '祭り', completed: true, department: 'dep1', image: { url: '/large.jpg' } }];
  const data = { title: '行事', csrfToken: 'test', events, categories: [], departments: [{ _id: 'dep1', name: '総務部' }], association: { _id: 'assoc1', name: '町内会' }, group: { _id: 'group1', association: 'assoc1', name: 'クラブ' } };
  for (const name of ['association-events-manage', 'association-group-events-manage']) {
    const html = await renderView(new URL(`../src/views/${name}.ejs`, import.meta.url).pathname, data);
    assert.match(html, /data-event-filter="year"/);
    assert.match(html, /data-completed="true"/);
    assert.match(html, /data-department="dep1"/);
    assert.match(html, /event-edit-image/);
  }
  const window = calendarWindow('2026-07');
  const html = await renderView(new URL('../src/views/partials/association-event-calendar.ejs', import.meta.url).pathname, { events, calendarWindow: window, months: window.months, calendarAnchor: 'events', calendarPath: '/dashboard' });
  assert.match(html, /data-event-filter="completed"/);
  assert.match(html, /data-filter-event data-completed="true"/);
});

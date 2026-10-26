import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { associationGroupsRouter } from '../src/routes/associationGroups.js';
import { AssociationGroup, AssociationGroupMembership } from '../src/models/associationGroup.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../src/models/officerAnnouncement.js';
import { AssociationEvent } from '../src/models/associationEvent.js';
import { eventValues } from '../src/services/associationEventService.js';

const form = event => ejs.renderFile('src/views/partials/association-event-form.ejs', { event, action: '/events', csrfToken: 'token', categories: [] });

test('new events default to published while saved drafts remain drafts when edited', async () => {
  assert.match(await form(null), /name="visible" checked/);
  assert.doesNotMatch(await form({ visible: false }), /name="visible" checked/);
  assert.match(await form({ visible: true }), /name="visible" checked/);
});

test('published club events appear on their dates in the club calendar including monthly repetitions', async t => {
  const group = { _id: 'club', association: 'association', name: 'クラブ' };
  const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
  t.mock.method(AssociationGroupMembership, 'findOne', async () => ({ status: 'active' }));
  t.mock.method(AssociationGroup, 'findOne', () => query(group));
  t.mock.method(OfficerAnnouncement, 'find', () => ({ ...query([]), limit() { return this; } }));
  t.mock.method(OfficerAnnouncementReceipt, 'countDocuments', async () => 0);
  const registered = eventValues({ title: 'クラブ練習会', body: '活動内容', startDate: '2026-10-01', startTime: '09:00', endTime: '12:00', category: '活動', color: '#287b68', visible: 'on', recurrenceFrequency: 'monthly', monthlyMode: 'weekday', monthWeek: '3', monthWeekday: '6' });
  t.mock.method(AssociationEvent, 'find', filter => {
    assert.deepEqual(filter, { association: 'association', group: 'club', visible: true });
    return query([{ ...registered, _id: 'event' }]);
  });
  const handler = associationGroupsRouter.stack.find(layer => layer.route?.path === '/:associationId/groups/:groupId/messages' && layer.route.methods.get).route.stack.at(-1).handle;
  for (const [month, expected] of [['2026-10', '2026-10-17'], ['2026-11', '2026-11-21']]) {
    let values;
    await handler({ params: { associationId: 'association', groupId: 'club' }, user: { _id: 'user' }, query: { month } }, { render: (view, data) => { values = data; } }, error => { throw error; });
    assert.equal(values.events[0].startDate, expected);
    const html = await ejs.renderFile('src/views/partials/association-event-calendar.ejs', { ...values, calendarAnchor: 'club-calendar', calendarPath: '/club', calendarTitle: 'クラブカレンダー' });
    assert.match(html, /has-event/);
    assert.match(html, /title="クラブ練習会"/);
    assert.match(html, /毎月 第3土曜日/);
  }
});

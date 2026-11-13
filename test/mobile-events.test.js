import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileEventsRouter, mobileCalendarEvent } from '../src/routes/mobileEvents.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AssociationEvent } from '../src/models/associationEvent.js';
import { requireLogin } from '../src/middleware/auth.js';
const aid = 'aaaaaaaaaaaaaaaaaaaaaaaa', uid = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const query = value => ({ sort() { return this; }, lean: async () => value });
const handler = mobileEventsRouter.stack.find(layer => layer.route).route.stack[0].handle;
const req = { params: { associationId: aid }, user: { _id: uid }, query: { month: '2026-11' } };
const next = error => { throw error; };
function access(t, member = true, enabled = true) {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: aid, name: '町内会', optionalFeatures: { events: enabled } }));
  t.mock.method(AssociationMembership, 'exists', async filter => { assert.equal(filter.user, uid); return member; });
}

test('mobile calendar requires login, active membership and enabled feature', async t => {
  assert.equal(mobileEventsRouter.stack[0].handle, requireLogin);
  access(t, false);
  await assert.rejects(handler(req, {}, next), { status: 403 });
  AssociationMembership.exists.mock.mockImplementation(async () => true);
  NeighborhoodAssociation.findOne.mock.mockImplementation(() => query({ _id: aid, optionalFeatures: { events: false } }));
  await assert.rejects(handler(req, {}, next), { status: 404 });
});

test('mobile calendar shares visibility, Monday-first cells, three-month range and recurrence expansion', async t => {
  access(t);
  t.mock.method(AssociationEvent, 'find', filter => {
    assert.deepEqual(filter, { association: { $in: [aid] }, visible: true });
    return query([
      { _id: 'weekly', title: '定例', startDate: '2026-10-26', endDate: '2026-10-26', startTime: '10:00', endTime: '11:00', recurrence: { frequency: 'weekly', weekdays: [1], until: '2026-11-09' } },
      { _id: 'span', title: '連日', startDate: '2026-10-31', endDate: '2026-11-02', startTime: '09:00', endTime: '17:00' },
      { _id: 'out', startDate: '2027-02-01', endDate: '2027-02-01', startTime: '09:00', endTime: '10:00' }
    ]);
  });
  let result;
  await handler(req, { set() {}, json(value) { result = value; } }, next);
  assert.equal(result.previousMonth, '2026-10'); assert.equal(result.nextMonth, '2026-12');
  assert.equal(result.months.length, 3);
  assert.deepEqual(result.months[0].cells.slice(0, 7), [null, null, null, null, null, null, '2026-11-01']);
  assert.deepEqual(result.events.map(event => event.startDate), ['2026-10-31', '2026-11-02', '2026-11-09']);
  assert.equal(new Set(result.events.map(event => event.id)).size, 3);
});

test('modal payload carries media and captions without Drive credentials or storage IDs', () => {
  const event = mobileCalendarEvent({ _id: 'event', startDate: '2026-11-01', image: { url: '/image', fileId: 'private', publicId: 'private' }, imageCaption: '案内', youtubeUrl: 'https://youtu.be/abcdefghijk', qrUrl: 'https://example.com', qrCaption: '申込み', completed: true, allDay: true });
  assert.equal(event.imageURL, '/image'); assert.equal(event.imageCaption, '案内');
  assert.equal(event.youtubeURL, 'https://youtu.be/abcdefghijk'); assert.equal(event.qrCaption, '申込み');
  assert.equal(event.completed, true); assert.equal(event.allDay, true); assert.equal(event.image, undefined);
});

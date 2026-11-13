import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileEventManagementRouter as router, mobileManagedEvent } from '../src/routes/mobileEventManagement.js';
import { createAssociationEvent, updateAssociationEvent, completeAssociationEvent, deleteAssociationEvent, associationEventsRouter } from '../src/routes/associationEvents.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';
import { AssociationEvent } from '../src/models/associationEvent.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleDefinition } from '../src/models/role.js';
import { Notification } from '../src/models/notification.js';
const aid = 'aaaaaaaaaaaaaaaaaaaaaaaa', uid = 'bbbbbbbbbbbbbbbbbbbbbbbb', eid = 'cccccccccccccccccccccccc';
const q = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value, distinct: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const next = error => { if (error) throw error; };
const route = (path, method = 'post') => router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const response = () => ({ locals: { mobileEvents: true, csrfToken: 'token' }, set() {}, json(value) { this.value = value; } });
const fields = { title: '定例会', body: '会議の案内', startDate: '2026-11-14', startTime: '09:00', endTime: '10:00', category: '総務部', color: '#287b68', visible: 'on', recurrenceFrequency: 'weekly', weekdays: ['1', '3'], recurrenceUntil: '2027-03-31', imageCaption: '案内', youtubeUrl: 'https://youtu.be/abcdefghijk', qrUrl: 'https://example.com', qrCaption: '申込み' };
const request = () => ({ params: { associationId: aid, eventId: eid }, user: { _id: uid }, body: { ...fields } });
function access(t) {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => q({ _id: aid, name: '町内会', eventCategories: ['総務部'], optionalFeatures: { events: true } }));
  t.mock.method(AssociationMembership, 'findOne', () => q({ status: 'active' }));
  t.mock.method(RoleDefinition, 'find', () => q([]));
  t.mock.method(AnnualOfficer, 'exists', async () => true);
  t.mock.method(NeighborhoodAssociation, 'updateOne', async () => ({ matchedCount: 1 }));
  t.mock.method(AssociationMembership, 'find', () => q([uid]));
  t.mock.method(Notification, 'insertMany', async () => []);
}

test('mobile mutations require CSRF and use exactly the Web save/delete/report handlers', () => {
  assert.equal(router.stack[0].handle, requireLogin);
  for (const [path, handler] of [['/', createAssociationEvent], ['/:eventId', updateAssociationEvent], ['/:eventId/complete', completeAssociationEvent], ['/:eventId/delete', deleteAssociationEvent]]) {
    assert.equal(route(path), handler);
    const stack = router.stack.find(layer => layer.route?.path === path && layer.route.methods.post).route.stack;
    assert.ok(stack.some(layer => layer.handle === verifyCsrfToken));
    assert.ok(associationEventsRouter.stack.some(layer => layer.route?.stack.at(-1).handle === handler));
  }
});
test('management rejects ordinary residents, nonmembers and disabled features', async t => {
  access(t);
  const check = router.stack[2].handle;
  await check(request(), response(), next);
  AnnualOfficer.exists.mock.mockImplementation(async () => false);
  await assert.rejects(check(request(), response(), next), { status: 403 });
  AnnualOfficer.exists.mock.mockImplementation(async () => true);
  AssociationMembership.findOne.mock.mockImplementation(() => q(null));
  await assert.rejects(check(request(), response(), next), { status: 403 });
  AssociationMembership.findOne.mock.mockImplementation(() => q({ status: 'active' }));
  NeighborhoodAssociation.findOne.mock.mockImplementation(() => q({ _id: aid, optionalFeatures: { events: false } }));
  await assert.rejects(check(request(), response(), next), { status: 404 });
});
test('list includes drafts and report/editor fields, scoped to association and newest first', async t => {
  access(t);
  t.mock.method(AssociationEvent, 'find', filter => {
    assert.deepEqual(filter, { association: aid });
    return { sort(order) { assert.deepEqual(order, { startDate: -1, startTime: -1 }); return q([{ _id: eid, ...fields, visible: false, completed: true, implementationReport: '実施済み', recurrence: { frequency: 'weekly', until: '2027-03-31' } }]); } };
  });
  const res = response(); await router.stack[2].handle(request(), res, next);
  await route('/', 'get')(request(), res, next);
  assert.equal(res.value.events[0].id, eid); assert.equal(res.value.events[0].visible, false);
  assert.equal(res.value.events[0].implementationReport, '実施済み'); assert.equal(res.value.events[0].recurrence.until, '2027-03-31');
  assert.equal(res.value.csrfToken, 'token');
  assert.equal(mobileManagedEvent({ _id: eid, image: { url: '/image', fileId: 'secret' } }).image, undefined);
});
test('registration validates dates and saves recurring media settings and resident notices', async t => {
  access(t);
  const create = t.mock.method(AssociationEvent, 'create', async values => { assert.equal(values.association, aid); assert.deepEqual(values.recurrence.weekdays, [1, 3]); assert.equal(values.qrCaption, '申込み'); return { _id: eid, ...values }; });
  const res = response(); await route('/')(request(), res, next);
  assert.equal(res.value.success, true); assert.equal(create.mock.callCount(), 1);
  assert.equal(Notification.insertMany.mock.calls[0].arguments[0][0].relatedId, eid);
  const req = request(); req.body.endTime = '08:00';
  await assert.rejects(route('/')(req, response(), next), { status: 400 });
  assert.equal(create.mock.callCount(), 1);
});
test('editing keeps existing images without replacement and never writes a foreign event', async t => {
  access(t);
  const old = { _id: eid, association: aid, visible: true, image: { url: '/existing' }, toObject() { return { ...this }; } };
  t.mock.method(AssociationEvent, 'findOne', filter => { assert.deepEqual(filter, { _id: eid, association: aid }); return q(old); });
  const update = t.mock.method(AssociationEvent, 'findOneAndUpdate', async (filter, change) => { assert.deepEqual(filter, { _id: eid, association: aid }); assert.equal(change.$set.image, undefined); return old; });
  await route('/:eventId')(request(), response(), next); assert.equal(update.mock.callCount(), 1);
  AssociationEvent.findOne.mock.mockImplementation(() => q(null));
  await assert.rejects(route('/:eventId')(request(), response(), next), { status: 404 });
  assert.equal(update.mock.callCount(), 1);
});
test('completion saves trimmed report; undo preserves report; unknown event is rejected', async t => {
  access(t);
  t.mock.method(AssociationEvent, 'findOne', filter => { assert.deepEqual(filter, { _id: eid, association: aid }); return q({ _id: eid }); });
  const write = t.mock.method(AssociationEvent.collection, 'updateOne', async (filter, update) => { assert.deepEqual(filter, { _id: eid, association: aid }); return { matchedCount: 1 }; });
  const req = request(); req.body = { completed: 'on', implementationReport: '  無事に終了  ' };
  const res = response(); await route('/:eventId/complete')(req, res, next);
  assert.deepEqual(write.mock.calls[0].arguments[1].$set, { completed: true, implementationReport: '無事に終了' });
  assert.equal(res.value.success, true);
  req.body = { completed: '' }; await route('/:eventId/complete')(req, response(), next);
  assert.deepEqual(write.mock.calls[1].arguments[1].$set, { completed: false });
  AssociationEvent.findOne.mock.mockImplementation(() => q(null));
  await assert.rejects(route('/:eventId/complete')(req, response(), next), { status: 404 });
});
test('deletion is tenant scoped and reports missing events instead of success', async t => {
  access(t);
  t.mock.method(AssociationEvent, 'findOne', () => q({ _id: eid, association: aid, visible: true }));
  t.mock.method(AssociationEvent, 'deleteOne', async filter => { assert.deepEqual(filter, { _id: eid, association: aid }); return { deletedCount: 1 }; });
  const res = response(); await route('/:eventId/delete')(request(), res, next); assert.equal(res.value.success, true);
  AssociationEvent.deleteOne.mock.mockImplementation(async () => ({ deletedCount: 0 }));
  await assert.rejects(route('/:eventId/delete')(request(), response(), next), { status: 404 });
});

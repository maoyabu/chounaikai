import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileEquipmentRouter, mobileEquipmentCalendar } from '../src/routes/mobileEquipment.js';
import { AssociationEquipment, EquipmentLoan, EquipmentSettings } from '../src/models/equipment.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { RoleDefinition } from '../src/models/role.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';

const aid = 'aaaaaaaaaaaaaaaaaaaaaaaa', uid = 'bbbbbbbbbbbbbbbbbbbbbbbb', eid = 'cccccccccccccccccccccccc';
const q = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
const req = { params: { associationId: aid, equipmentId: eid }, user: { _id: uid }, query: { month: '2026-11' } };
const next = error => { if (error) throw error; };
const route = (path, method = 'get') => mobileEquipmentRouter.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const item = { _id: eid, name: '会議室', place: '町内会館', quantity: 2, unit: '室', lendable: true };
function access(t) {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => q({ _id: aid, optionalFeatures: { equipment: true } }));
  t.mock.method(AssociationMembership, 'findOne', () => q({ status: 'active' }));
  t.mock.method(RoleDefinition, 'find', () => q([]));
  t.mock.method(AnnualOfficer, 'exists', async () => null);
  t.mock.method(EquipmentSettings, 'findOne', () => q({ loanPublic: true }));
}

test('mobile rentals enforce membership, public lending and feature settings; writes have CSRF', async t => {
  assert.equal(mobileEquipmentRouter.stack[0].handle, requireLogin);
  for (const layer of mobileEquipmentRouter.stack.filter(layer => layer.route?.methods.post)) {
    assert.equal(layer.route.stack[0].handle, verifyCsrfToken);
  }
  access(t);
  const check = mobileEquipmentRouter.stack[1].handle;
  const res = { locals: {}, set() {} };
  let continued = false;
  await check(req, res, error => { if (error) throw error; continued = true; });
  assert.equal(continued, true);
  EquipmentSettings.findOne.mock.mockImplementation(() => q({ loanPublic: false }));
  await assert.rejects(check(req, res, next), { status: 403 });
  EquipmentSettings.findOne.mock.mockImplementation(() => q(null));
  NeighborhoodAssociation.findOne.mock.mockImplementation(() => q({ optionalFeatures: { equipment: false } }));
  await assert.rejects(check(req, res, next), { status: 404 });
  AssociationMembership.findOne.mock.mockImplementation(() => q(null));
  await assert.rejects(check(req, res, next), { status: 403 });
});

test('list is scoped to lendable, undeleted equipment, excluding purchase wishes', async t => {
  t.mock.method(AssociationEquipment, 'find', filter => {
    assert.deepEqual(filter, { association: aid, deletedAt: null, lendable: true, wishlist: { $ne: true } });
    return q([{ ...item, reservations: [{ borrower: 'private' }] }]);
  });
  let result;
  await route('/')(req, { json(value) { result = value; } }, next);
  assert.equal(result.items[0].name, '会議室');
  assert.equal(result.items[0].reservations, undefined);
});

test('calendar counts everyone in availability but returns only own application details', async t => {
  t.mock.method(AssociationEquipment, 'findOne', filter => {
    assert.equal(filter.association, aid); assert.equal(filter.lendable, true);
    return q(item);
  });
  t.mock.method(EquipmentLoan, 'find', filter => {
    assert.deepEqual(filter, { association: aid, equipment: eid });
    return q([
      { _id: 'mine', borrower: uid, startDate: '2026-11-20', endDate: '2026-11-20', quantity: 1, status: 'pending', purpose: '会議' },
      { _id: 'other', borrower: 'other-user', startDate: '2026-11-20', endDate: '2026-11-20', quantity: 1, status: 'approved', purpose: 'private purpose' }
    ]);
  });
  let result;
  await route('/:equipmentId/calendar')(req, { locals: { csrfToken: 'token' }, json(value) { result = value; } }, next);
  assert.equal(result.cells.find(cell => cell?.day === 20).capacity, 0);
  assert.deepEqual(result.requests.map(loan => loan.id), ['mine']);
  assert.equal(result.requests[0].status, 'pending');
  assert.equal(result.csrfToken, 'token');
  assert.ok(!JSON.stringify(result).includes('private purpose'));
});

test('calendar handles Monday start, leap month, blocked times and period boundaries', () => {
  const calendar = mobileEquipmentCalendar({ ...item, availableFrom: '2028-02-02', loanBlocks: [{ startDate: '2028-02-03', endDate: '2028-02-03', allDay: false, startTime: '09:00', endTime: '12:00' }] }, [], '2028-02', '2028-02-01');
  assert.equal(calendar.cells[0], null);
  assert.equal(calendar.cells.at(-1).day, 29);
  assert.equal(calendar.cells[1].available, false);
  const segments = calendar.cells.find(cell => cell?.day === 3).segments;
  assert.deepEqual(segments.map(s => [s.startTime, s.endTime, s.available]), [['00:00', '09:00', 2], ['09:00', '12:00', 0], ['12:00', '24:00', 2]]);
  assert.throws(() => mobileEquipmentCalendar(item, [], '2028-13'), { status: 400 });
});

test('cancel endpoint rejects another borrowers application even before service invocation', async t => {
  t.mock.method(EquipmentLoan, 'exists', async filter => {
    assert.equal(filter.association, aid); assert.equal(filter.borrower, uid);
    return null;
  });
  await assert.rejects(route('/loans/:loanId/cancel', 'post')({ ...req, params: { associationId: aid, loanId: eid } }, {}, next), { status: 403 });
});

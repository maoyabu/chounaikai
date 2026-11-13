import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { mobileInventoryRouter, inventoryItem } from '../src/routes/mobileInventory.js';
import { mobileProfileRouter, profileValues, basicProfile } from '../src/routes/mobileProfile.js';
import { AssociationEquipment, EquipmentInventory, EquipmentSettings } from '../src/models/equipment.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleDefinition } from '../src/models/role.js';
import { User } from '../src/models/user.js';
import { Household, HouseholdMember } from '../src/models/organization.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';
import { japanDate } from '../src/services/equipmentService.js';
const aid = 'aaaaaaaaaaaaaaaaaaaaaaaa', uid = 'bbbbbbbbbbbbbbbbbbbbbbbb', eid = 'cccccccccccccccccccccccc';
const q = value => ({ select() { return this; }, sort() { return this; }, populate() { return this; }, session() { return this; }, distinct: async () => value, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const next = error => { if (error) throw error; };
const route = (router, path, method = 'get') => router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const res = () => ({ locals: { csrfToken: 'token' }, set() {}, json(value) { this.value = value; } });
const user = { _id: uid, username: 'user', displayname: '確認者', email: 'old@example.com', toObject() { return { ...this }; } };
const req = () => ({ params: { associationId: aid, equipmentId: eid }, user: { ...user }, body: {} });
function access(t) {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => q({ _id: aid, optionalFeatures: { equipment: true } }));
  t.mock.method(AssociationMembership, 'findOne', () => q({ status: 'active' }));
  t.mock.method(RoleDefinition, 'find', () => q([]));
  t.mock.method(AnnualOfficer, 'exists', async () => ({ _id: eid }));
  t.mock.method(EquipmentSettings, 'findOne', () => q({ inventoryStartMonth: japanDate().slice(0, 7), inventoryIntervalMonths: 1 }));
}
test('inventory requires officers and enabled equipment; profile and inventory writes verify CSRF', async t => {
  for (const router of [mobileInventoryRouter, mobileProfileRouter]) {
    assert.equal(router.stack[0].handle, requireLogin);
    for (const layer of router.stack.filter(layer => layer.route?.methods.post)) assert.ok(layer.route.stack.some(m => m.handle === verifyCsrfToken));
  }
  access(t);
  const check = mobileInventoryRouter.stack[1].handle;
  let continued = false;
  await check(req(), res(), error => { if (error) throw error; continued = true; }); assert.ok(continued);
  AnnualOfficer.exists.mock.mockImplementation(async () => null);
  await assert.rejects(check(req(), res(), next), { status: 403 });
  AnnualOfficer.exists.mock.mockImplementation(async () => ({ _id: eid }));
  NeighborhoodAssociation.findOne.mock.mockImplementation(() => q({ _id: aid }));
  await assert.rejects(check(req(), res(), next), { status: 404 });
});
test('inventory lists tracked items by current period and includes photo, required count and audit fields', async t => {
  access(t);
  t.mock.method(AssociationEquipment, 'find', filter => { assert.deepEqual(filter, { association: aid, deletedAt: null, tracked: true, wishlist: { $ne: true } }); return q([{ _id: eid, name: '水', place: '倉庫', quantity: 10, minimumQuantity: 20, unit: '本', expiryDate: '2026-01-01', productImageUrl: 'https://example.com/image.jpg' }]); });
  t.mock.method(EquipmentInventory, 'find', filter => { assert.equal(filter.association, aid); assert.equal(filter.period, japanDate().slice(0, 7)); return q([{ equipment: eid, count: 8, checked: true, comment: '確認', checkedBy: { displayname: '担当' }, checkedAt: new Date('2026-11-13T00:00:00Z') }]); });
  const response = res(); await route(mobileInventoryRouter, '/')(req(), response, next);
  const item = response.value.items[0];
  assert.equal(item.count, 8); assert.equal(item.requiredQuantity, 20); assert.equal(item.checkedBy, '担当'); assert.equal(item.checked, true);
  assert.equal(item.imageURL, 'https://example.com/image.jpg'); assert.equal(item.comment, '確認');
  assert.equal(inventoryItem({ _id: eid, quantity: 5 }, null).checked, false);
});
test('inventory saving preserves actor/time/history and unchecking retains stock', async t => {
  access(t);
  t.mock.method(mongoose.connection, 'transaction', async callback => callback('session'));
  let stock = 10, history;
  const item = { quantity: stock, lendable: false, async save() { stock = this.quantity; } };
  t.mock.method(AssociationEquipment, 'findOneAndUpdate', filter => { assert.equal(filter.association, aid); assert.equal(filter.tracked, true); return q(item); });
  t.mock.method(EquipmentInventory, 'findOneAndUpdate', async (filter, update) => { assert.equal(filter.association, aid); history = update.$push.history; return update.$set; });
  const request = req(); request.body = { period: japanDate().slice(0, 7), count: '8', comment: '棚卸し', checked: '1' };
  let response = res(); await route(mobileInventoryRouter, '/:equipmentId', 'post')(request, response, next);
  assert.equal(stock, 8); assert.equal(response.value.checked, true); assert.equal(response.value.checkedBy, '確認者');
  assert.equal(history.actor, uid); assert.ok(history.at instanceof Date);
  request.body = { ...request.body, checked: '0', count: '7' };
  response = res(); await route(mobileInventoryRouter, '/:equipmentId', 'post')(request, response, next);
  assert.equal(stock, 8); assert.equal(response.value.checked, false); assert.equal(history.checked, false);
  request.body.period = '2000-01'; await assert.rejects(route(mobileInventoryRouter, '/:equipmentId', 'post')(request, res(), next), { status: 409 });
});
test('basic profile validation only permits basic fields and validates date/email/sex', () => {
  const body = { displayname: '氏名', email: 'USER@EXAMPLE.COM', birth_date: '2000-02-29', sex: 'female', username: 'forged', isAdmin: true, avatar: 'forged' };
  const values = profileValues(body);
  assert.equal(values.email, 'user@example.com'); assert.equal(values.username, undefined); assert.equal(values.isAdmin, undefined); assert.equal(values.avatar, undefined);
  assert.equal(basicProfile({ ...user, ...values }).birthDate, '2000-02-29');
  for (const patch of [{ displayname: '' }, { email: 'bad' }, { birth_date: '2001-02-29' }, { sex: 'bad' }]) assert.throws(() => profileValues({ ...body, ...patch }), { status: 400 });
});
test('profile fetch fills legacy resident birthday and sex only for current user', async t => {
  t.mock.method(HouseholdMember, 'findOne', filter => { assert.equal(filter.user, uid); return q({ birthDate: new Date('2000-01-02'), gender: 'male' }); });
  const response = res(); await route(mobileProfileRouter, '/')(req(), response, next);
  assert.equal(response.value.profile.birthDate, '2000-01-02'); assert.equal(response.value.profile.sex, 'male');
});
test('profile update keeps username, synchronizes household details and rejects duplicate email', async t => {
  t.mock.method(User, 'exists', async filter => { assert.equal(filter._id.$ne, uid); return false; });
  t.mock.method(User, 'updateOne', async (filter, update) => { assert.equal(filter._id, uid); assert.equal(update.$set.username, undefined); return { matchedCount: 1 }; });
  t.mock.method(HouseholdMember, 'find', () => q([eid]));
  t.mock.method(HouseholdMember, 'updateMany', async (filter, update) => { assert.equal(filter.user, uid); assert.equal(update.$set.name, '新氏名'); });
  t.mock.method(Household, 'updateMany', async filter => { assert.equal(filter.representative, uid); });
  const request = req(); request.body = { displayname: '新氏名', email: 'new@example.com', sex: 'other', username: 'forged' };
  const response = res(); await route(mobileProfileRouter, '/', 'post')(request, response, next);
  assert.equal(response.value.profile.username, 'user'); assert.equal(response.value.profile.displayname, '新氏名');
  User.exists.mock.mockImplementation(async () => true);
  await assert.rejects(route(mobileProfileRouter, '/', 'post')(request, res(), next), { status: 409 });
});

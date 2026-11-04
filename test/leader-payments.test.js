import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import fs from 'node:fs';
import mongoose from 'mongoose';
import { householdsRouter } from '../src/routes/households.js';
import { Household, DistrictGroup } from '../src/models/organization.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationFeePayment } from '../src/models/associationFeePayment.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleAssignment } from '../src/models/role.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
const id = () => new mongoose.Types.ObjectId();
const date = new Date();
const year = date.getMonth() < 3 ? date.getFullYear() - 1 : date.getFullYear();
const query = value => ({ populate() { return this; }, select() { return this; }, sort() { return this; }, lean() { return Promise.resolve(value); }, distinct() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const handler = method => householdsRouter.stack.find(layer => layer.route?.path === (method === 'get' ? '/:associationId/leader/payments' : '/:associationId/leader/payments/:householdId/toggle') && layer.route.methods[method]).route.stack.at(-1).handle;
const req = () => ({ params: { associationId: String(id()), householdId: String(id()) }, user: { _id: id() }, query: {}, body: { fiscalYear: year }, session: {} });
const next = error => { throw error; };

test('担当班の登録世帯を表示し年度別の記録を分ける', async t => {
  const user = id();
  const request = req(), district = id(), household = { _id: id(), displayName: '青木家', districtLabel: '01', feeRepresentative: { _id: user, displayname: '青木 太郎' } };
  const unlinkedHousehold = { _id: id(), displayName: '未加入世帯', districtLabel: '02' };
  request.query.year = String(year - 1);
  t.mock.method(AnnualLeaderAssignment, 'find', filter => {
    if (filter.representative) return query([district]);
    assert.equal(filter.fiscalYear, year - 1);
    assert.equal(filter.cancelledAt, null);
    return query([{ household: household._id, representative: user }]);
  });
  t.mock.method(AssociationMembership, 'find', () => query([{ household: household._id, user }]));
  t.mock.method(AnnualOfficer, 'find', filter => {
    assert.equal(filter.fiscalYear, year - 1);
    assert.equal(filter.cancelledAt, null);
    return query([{ user, role: { name: '会計' } }]);
  });
  t.mock.method(RoleAssignment, 'find', filter => {
    assert.equal(filter.startsAt.$lt.getFullYear(), year);
    return query([{ user, role: { name: '会計' } }, { user, role: { name: '町内会管理者' } }]);
  });
  t.mock.method(NeighborhoodAssociation, 'findById', () => query({ _id: request.params.associationId }));
  t.mock.method(DistrictGroup, 'find', () => query([{ name: '1班' }]));
  t.mock.method(Household, 'find', filter => {
    assert.deepEqual(filter.districtGroup.$in, [district]);
    assert.equal(filter.active, true);
    assert.ok(filter.districtLabel);
    return query([household, unlinkedHousehold]);
  });
  t.mock.method(AssociationFeePayment, 'find', filter => {
    assert.deepEqual(filter.household.$in, [household._id, unlinkedHousehold._id]);
    return query([{ household: household._id, fiscalYear: year, paid: false }, { household: household._id, fiscalYear: year - 1, paid: true }]);
  });
  let data;
  await handler('get')(request, { render(view, locals) { assert.equal(view, 'leader-payments'); data = locals; } }, next);
  assert.equal(data.households[0].payment.paid, true);
  assert.equal(data.households[0].currentPayment.paid, false);
  assert.equal(data.households[0].history.length, 1);
  assert.equal(data.households[0].isLinked, true);
  assert.deepEqual(data.households[0].roleTags, ['班長', '会計', '町内会管理者']);
  assert.equal(data.households[1].isLinked, false);
  assert.deepEqual(data.households[1].roleTags, []);
  const template = fs.readFileSync('src/views/leader-payments.ejs', 'utf8').replace(/<%- include\('partials\/(?:head|header|foot)'\) %>/g, '');
  const html = ejs.render(template, { ...data, csrfToken: 'token' });
  const fullHtml = await ejs.renderFile('src/views/leader-payments.ejs', { ...data, csrfToken: 'token', assetVersion: 'test', currentUser: null, currentPath: '/', hideDangerCompose: true });
  assert.match(fullHtml, /町内会費納付管理/);
  assert.match(html, /role="switch"/);
  assert.match(html, /青木家/);
  assert.match(html, /紐付け会員：青木 太郎/);
  assert.match(html, />班長<\/span>/);
  assert.match(html, />非会員<\/span>/);
  assert.ok(!html.includes('世帯情報を修正'));
  assert.ok(!html.includes('/delete'));
  assert.match(ejs.render(template, { ...data, households: [], csrfToken: 'token' }), /登録された世帯はありません/);
});

for (const paid of [true, false]) test(`今年度の納付を${paid ? 'ON' : 'OFF'}に保存する`, async t => {
  const request = req(), district = id();
  if (paid) request.body.paid = 'on';
  t.mock.method(AnnualLeaderAssignment, 'find', () => query([district]));
  t.mock.method(Household, 'findOne', filter => {
    assert.deepEqual(filter.districtGroup.$in, [district]);
    assert.equal(filter.association, request.params.associationId);
    return query({ _id: request.params.householdId });
  });
  const save = t.mock.method(AssociationFeePayment, 'findOneAndUpdate', async (filter, update) => {
    assert.equal(filter.fiscalYear, year);
    assert.equal(update.$set.paid, paid);
    assert.equal(update.$set.checkedBy, request.user._id);
    assert.equal(update.$set.paidAt === null, !paid);
  });
  let url;
  await handler('post')(request, { redirect(value) { url = value; } }, next);
  assert.equal(save.mock.callCount(), 1);
  assert.ok(url.endsWith(`#payment-${request.params.householdId}`));
});

test('過年度の更新を拒否する', async () => {
  const request = req(); request.body.fiscalYear = year - 1;
  await assert.rejects(handler('post')(request, {}, next), /今年度のみ/);
});

test('班長以外は閲覧も更新もできない', async t => {
  t.mock.method(AnnualLeaderAssignment, 'find', () => query([]));
  for (const method of ['get', 'post']) await assert.rejects(handler(method)(req(), {}, next), error => error.status === 403);
});

test('担当外の世帯への保存を拒否する', async t => {
  t.mock.method(AnnualLeaderAssignment, 'find', () => query([id()]));
  t.mock.method(Household, 'findOne', () => query(null));
  await assert.rejects(handler('post')(req(), {}, next), error => error.status === 403);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import nodemailer from 'nodemailer';
import { mobileHouseholdsRouter } from '../src/routes/mobileHouseholds.js';
import { Household, HouseholdMember } from '../src/models/organization.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { Invitation } from '../src/models/workflow.js';
import { User } from '../src/models/user.js';
const aid = 'aaaaaaaaaaaaaaaaaaaaaaaa', hid = 'bbbbbbbbbbbbbbbbbbbbbbbb', uid = 'cccccccccccccccccccccccc', mid = 'dddddddddddddddddddddddd', other = 'eeeeeeeeeeeeeeeeeeeeeeee';
const q = value => ({ populate() { return this; }, select() { return this; }, sort() { return this; }, lean: async () => value, then: (yes, no) => Promise.resolve(value).then(yes, no) });
async function start(t) {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.user = { _id: uid, displayname: '世帯主', email: 'head@example.test' }; req.isAuthenticated = () => req.get('x-auth') !== 'no'; req.session = { csrfToken: 'valid' }; res.render = (_view, data) => res.json(data); next(); });
  app.use('/api/profile/households', mobileHouseholdsRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return (path, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/profile/households${path}`, {
    headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {})
  });
}
function owned(t) {
  const household = { _id: hid, association: { _id: aid, name: '町内会', status: 'active' }, representative: uid, active: true, address: { postalCode: '123', street: '住所' }, save: async () => {} };
  t.mock.method(Household, 'findOne', filter => {
    assert.equal(filter._id, hid); assert.equal(filter.association, aid);
    if (filter.representative) assert.equal(filter.representative, uid);
    return q(household);
  });
  return household;
}
test('only household heads see the menu; reads are authenticated and not cached', async t => {
  const request = await start(t);
  assert.equal((await request('/access', null, { 'x-auth': 'no' })).status, 401);
  const find = t.mock.method(Household, 'find', filter => { assert.deepEqual(filter, { representative: uid, active: true }); return q([]); });
  const response = await request('/access'); assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await response.json(), { isHouseholdHead: false });
  find.mock.mockImplementation(() => q([{ association: null }, { association: { _id: aid } }]));
  assert.equal((await (await request('/access')).json()).isHouseholdHead, true);
});
test('family DTO preserves linked-account profile, missing accounts, support and invitation eligibility', async t => {
  const request = await start(t);
  t.mock.method(Household, 'find', () => q([{ _id: hid, association: { _id: aid, name: '町内会' } }, { association: null }]));
  t.mock.method(HouseholdMember, 'find', filter => {
    assert.deepEqual(filter.household.$in, [hid]); assert.equal(filter.endsAt, null);
    return q([
      { _id: mid, household: hid, user: other, name: '以前の名前', birthDate: new Date('2000-01-01'), supportRequired: true, supportPriority: 2 },
      { _id: uid, household: hid, name: '子', email: 'child@example.test' },
      { _id: aid, household: hid, user: aid, name: '削除済み' }
    ]);
  });
  t.mock.method(AssociationMembership, 'find', filter => { assert.equal(filter.user, uid); return q([{ household: hid }]); });
  t.mock.method(User, 'find', () => q([{ _id: other, displayname: '現在の名前', username: 'family', email: 'family@example.test', birth_date: new Date('2001-02-03'), sex: 'female' }]));
  t.mock.method(Invitation, 'find', () => q([{ _id: mid, householdMember: uid, status: 'pending', expiresAt: new Date(Date.now() + 10000) }]));
  const result = await (await request('/')).json(); assert.equal(result.households.length, 1);
  const [linked, child, missing] = result.households[0].members;
  assert.equal(linked.name, '現在の名前'); assert.equal(linked.birthDate, '2001-02-03'); assert.equal(linked.canEdit, false); assert.equal(linked.canInvite, false);
  assert.equal(linked.supportRequired, true); assert.equal(linked.supportPriority, 2);
  assert.equal(child.canEdit, true); assert.equal(child.canInvite, true); assert.equal(child.invitationId, mid);
  assert.equal(missing.linkedAccountMissing, true); assert.equal(missing.canEdit, false); assert.equal(missing.canInvite, false);
});
test('all writes reject foreign households and missing CSRF', async t => {
  const request = await start(t); owned(t);
  const paths = ['update', 'members', `members/${mid}/update`, `members/${mid}/delete`, `members/${mid}/support`, `members/${mid}/invite`, `invitations/${mid}/cancel`];
  for (const path of paths) assert.equal((await request(`/${aid}/${hid}/${path}`, { _csrf: 'bad' })).status, 403);
  Household.findOne.mock.mockImplementation(() => q(null));
  for (const path of paths) assert.equal((await request(`/${aid}/${hid}/${path}`, { _csrf: 'valid' })).status, 403);
});
test('address and family registration reuse Web validation and return JSON rather than redirects', async t => {
  const request = await start(t), household = owned(t);
  assert.equal((await request(`/${aid}/${hid}/update`, { _csrf: 'valid', postalCode: '' })).status, 400);
  const saved = await request(`/${aid}/${hid}/update`, { _csrf: 'valid', postalCode: '123-4567', street: '住所', building: '建物', phone: '0123' });
  assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), { success: true }); assert.equal(household.phone, '0123');
  const create = t.mock.method(HouseholdMember, 'create', async value => { assert.equal(value.association, aid); assert.equal(value.household, hid); assert.equal(value.name, '子'); assert.equal(value.user, undefined); });
  assert.equal((await request(`/${aid}/${hid}/members`, { _csrf: 'valid', name: '子', nameKana: 'こ', birthDate: '2020-01-02', gender: 'unspecified', user: other })).status, 200);
  assert.equal(create.mock.callCount(), 1);
});
test('head may update linked support but cannot modify another linked account profile', async t => {
  const request = await start(t); owned(t);
  t.mock.method(HouseholdMember, 'findOne', () => q({ _id: mid, user: other }));
  t.mock.method(AssociationMembership, 'exists', async filter => { assert.equal(filter.user, uid); assert.equal(filter.household, hid); return true; });
  t.mock.method(NeighborhoodAssociation, 'exists', async () => true);
  const writes = t.mock.method(HouseholdMember, 'updateOne', async (filter, change) => { assert.equal(filter.association, aid); assert.equal(filter.household, hid); assert.deepEqual(change.$set, { supportRequired: true, supportPriority: 2 }); return { modifiedCount: 1 }; });
  assert.equal((await request(`/${aid}/${hid}/members/${mid}/support`, { _csrf: 'valid', supportRequired: 'yes', supportPriority: '2' })).status, 200);
  assert.equal(writes.mock.callCount(), 1);
  assert.equal((await request(`/${aid}/${hid}/members/${mid}/update`, { _csrf: 'valid', name: '変更' })).status, 403);
});
test('invitation sends the existing Web signup link via mocked transport and cancels older invitations', async t => {
  const request = await start(t); owned(t);
  const previousEnv = {};
  for (const [key, value] of Object.entries({ PUBLIC_BASE_URL: 'https://example.test', MAIL_FROM: 'sender@example.test', SMTP_HOST: 'mock', SMTP_USER: 'mock', SMTP_PASS: 'mock' })) { previousEnv[key] = process.env[key]; process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let delivered;
  t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async value => { delivered = value; } }));
  const member = { _id: mid, name: '家族', save: async () => {} };
  t.mock.method(HouseholdMember, 'findOne', filter => { assert.equal(filter.user, null); assert.equal(filter.isRepresentative, false); return q(member); });
  t.mock.method(AssociationMembership, 'exists', async () => true);
  const pending = t.mock.method(Invitation, 'exists', async () => false);
  t.mock.method(Invitation, 'create', async value => { assert.equal(value.invitedBy, uid); assert.equal(value.token, undefined); assert.match(value.tokenDigest, /^[a-f0-9]{64}$/); return { ...value, _id: other }; });
  const cancelled = t.mock.method(Invitation, 'updateMany', async filter => { assert.equal(filter.householdMember, mid); assert.equal(filter._id.$ne, other); return {}; });
  const result = await request(`/${aid}/${hid}/members/${mid}/invite`, { _csrf: 'valid', email: 'family@example.test' });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { success: true });
  assert.equal(delivered.to, 'family@example.test'); assert.match(delivered.text, /https:\/\/example.test\/household-invitations\?token=[a-f0-9]{64}/);
  assert.equal(member.email, 'family@example.test'); assert.equal(cancelled.mock.callCount(), 1);
  pending.mock.mockImplementation(async () => true);
  assert.equal((await request(`/${aid}/${hid}/members/${mid}/invite`, { _csrf: 'valid', email: 'family@example.test' })).status, 429);
});
test('pending invitation cancellation is scoped to current household and inviter', async t => {
  const request = await start(t); owned(t);
  const update = t.mock.method(Invitation, 'updateOne', async filter => { assert.equal(filter.association, aid); assert.equal(filter.household, hid); assert.equal(filter.invitedBy, uid); assert.equal(filter.status, 'pending'); return { modifiedCount: 1 }; });
  assert.equal((await request(`/${aid}/${hid}/invitations/${mid}/cancel`, { _csrf: 'valid' })).status, 200);
  update.mock.mockImplementation(async () => ({ modifiedCount: 0 }));
  assert.equal((await request(`/${aid}/${hid}/invitations/${mid}/cancel`, { _csrf: 'valid' })).status, 409);
});

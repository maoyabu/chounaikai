import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createMobileAccountSettingsRouter } from '../src/routes/mobileAccountSettings.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { DisclosureConsent } from '../src/models/disclosureConsent.js';
import { defaultPolicy } from '../src/services/disclosurePolicy.js';
import { currentFiscalYear } from '../src/services/officerDisclosureService.js';
const aid = 'aaaaaaaaaaaaaaaaaaaaaaaa', uid = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const q = value => ({ select() { return this; }, lean: async () => value });
const start = async (t, enabled = true) => {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    req.user = { _id: uid }; req.isAuthenticated = () => req.get('x-auth') !== 'no'; req.session = { csrfToken: 'valid' };
    res.render = (_view, locals) => res.json(locals); next();
  });
  app.use('/api/profile', createMobileAccountSettingsRouter({ lineService: { enabled, status: async id => { assert.equal(id, uid); return true; } }, passkeys: { enabled } }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return (path, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/profile${path}`, {
    headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {})
  });
};
function stub(t, consent = null) {
  const association = { _id: aid, name: '町内会', officerDisclosurePolicy: defaultPolicy, officerDisclosureHistory: [] };
  t.mock.method(AnnualOfficer, 'find', filter => { assert.equal(filter.user, uid); return q([{ association: aid }]); });
  t.mock.method(NeighborhoodAssociation, 'find', () => q([association]));
  t.mock.method(AssociationMembership, 'find', () => q([{ association: aid }]));
  t.mock.method(DisclosureConsent, 'find', filter => { assert.equal(filter.user, uid); return q(consent ? [consent] : []); });
  t.mock.method(NeighborhoodAssociation, 'findOne', () => q(association));
  t.mock.method(AnnualOfficer, 'exists', async () => true);
  t.mock.method(AssociationMembership, 'exists', async () => true);
}
test('login settings require authentication, return own linking status and never cache', async t => {
  const request = await start(t);
  assert.equal((await request('/login-settings', null, { 'x-auth': 'no' })).status, 401);
  const response = await request('/login-settings');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await response.json(), { lineEnabled: true, lineLinked: true, passkeyEnabled: true, csrfToken: 'valid' });
});
test('disabled login services stay unavailable', async t => {
  const request = await start(t, false);
  const result = await (await request('/login-settings')).json();
  assert.equal(result.lineLinked, false); assert.equal(result.passkeyEnabled, false);
});
test('disclosure options honor per-field caps and prior-year consent remains private', async t => {
  stub(t, { association: aid, fiscalYear: currentFiscalYear() - 1, confirmedAt: new Date(), scopes: defaultPolicy });
  const request = await start(t); const { rows } = await (await request('/disclosure')).json();
  assert.equal(rows[0].confirmed, false); assert.equal(rows[0].fields.length, 5);
  for (const field of rows[0].fields) assert.equal(field.value, 'private');
  assert.deepEqual(rows[0].fields.find(field => field.id === 'photo').options.map(option => option.id), ['private', 'officers']);
  assert.deepEqual(rows[0].fields.find(field => field.id === 'address').options.map(option => option.id), ['private']);
});
test('nonmembers are excluded from disclosure even with an officer assignment', async t => {
  stub(t); AssociationMembership.find.mock.mockImplementation(() => q([]));
  const request = await start(t); assert.deepEqual((await (await request('/disclosure')).json()).rows, []);
});
test('saving enforces CSRF, explicit agreement, caps and revision; binds audit to current user', async t => {
  stub(t); const writes = [];
  t.mock.method(DisclosureConsent, 'findOneAndUpdate', async (...args) => { writes.push(args); });
  const request = await start(t), body = { ...defaultPolicy, _csrf: 'valid', confirmDisclosure: 'yes', policyRevision: '0', user: 'other' };
  for (const [patch, status] of [[{ _csrf: 'bad' }, 403], [{ confirmDisclosure: '' }, 400], [{ policyRevision: '4' }, 409], [{ name: 'open' }, 400], [{ address: 'residents' }, 400]]) {
    assert.equal((await request(`/disclosure/${aid}`, { ...body, ...patch })).status, status);
  }
  assert.equal(writes.length, 0);
  assert.equal((await request(`/disclosure/${aid}`, body)).status, 200);
  assert.deepEqual(writes[0][0], { association: aid, user: uid });
  assert.equal(writes[0][1].$set.fiscalYear, currentFiscalYear()); assert.equal(writes[0][1].$push.history.actor, uid);
});
test('retired officers cannot save public scopes', async t => {
  stub(t); AnnualOfficer.exists.mock.mockImplementation(async () => false);
  const request = await start(t);
  assert.equal((await request(`/disclosure/${aid}`, { ...defaultPolicy, _csrf: 'valid', confirmDisclosure: 'yes', policyRevision: '0' })).status, 403);
});

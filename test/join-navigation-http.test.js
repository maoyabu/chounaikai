import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { webRouter } from '../src/routes/web.js';
import { associationEventsRouter } from '../src/routes/associationEvents.js';
import { householdsRouter } from '../src/routes/households.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { ResidentRegistration } from '../src/models/residentRegistration.js';
import { JoinApplication } from '../src/models/workflow.js';
import { DistrictGroup, HouseholdMember } from '../src/models/organization.js';
import { stubNavigation } from '../test-support/navigation.js';

const id = '6aabd0c3e5e589b3df2f6f30';
const query = value => ({ sort() { return this; }, populate() { return this; }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const start = async (t, { pending = false } = {}) => {
  stubNavigation(t);
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: id, name: 'テスト町内会' }));
  t.mock.method(AssociationMembership, 'findOne', () => query(null));
  t.mock.method(ResidentRegistration, 'findOne', () => query({ association: id }));
  t.mock.method(JoinApplication, 'findOne', filter => query(pending && filter.status ? { association: id } : null));
  t.mock.method(DistrictGroup, 'find', () => query([]));
  t.mock.method(HouseholdMember, 'findOne', () => query(null));
  const app = express();
  const session = {};
  app.use((req, res, next) => {
    req.session = session;
    req.isAuthenticated = () => req.get('x-auth') === 'yes';
    req.user = req.isAuthenticated() ? { _id: id, displayname: '申請者', email: 'resident@example.test' } : null;
    // Inspect the actual handler and form values without unrelated view dependencies.
    res.render = (view, values) => res.json({ view, values });
    next();
  });
  app.use(webRouter);
  // Same order as src/app.js: the public router precedes the application router.
  app.use('/associations', associationEventsRouter);
  app.use('/associations', householdsRouter);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return (path, authenticated = true) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { redirect: 'manual', headers: { 'x-auth': authenticated ? 'yes' : 'no' } });
};

test('anonymous invitation leads to account registration; authenticated participation button reaches application form', async t => {
  const request = await start(t);
  const publicPage = await request(`/associations/${id}/join`, false);
  assert.equal((await publicPage.json()).view, 'association-join');
  const anonymous = await request(`/associations/${id}/register/start`, false);
  assert.equal(anonymous.headers.get('location'), '/register');
  const button = await request(`/associations/${id}/register/start`);
  assert.equal(button.headers.get('location'), `/associations/${id}/join`);
  const form = await request(button.headers.get('location'));
  assert.equal(form.status, 200);
  assert.equal(form.headers.get('cache-control'), 'no-store');
  assert.equal((await form.json()).view, 'household-application');
});

test('login after email verification resumes the association application using stored registration', async t => {
  const request = await start(t);
  const login = await request('/login/complete');
  assert.equal(login.headers.get('location'), `/associations/${id}/join`);
  assert.equal((await (await request(login.headers.get('location'))).json()).view, 'household-application');
});

test('pending application redirects to participation status instead of reopening the form', async t => {
  const request = await start(t, { pending: true });
  const response = await request(`/associations/${id}/join`);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `/associations/${id}/participation`);
});

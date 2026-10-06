import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import { webRouter } from '../src/routes/web.js';
import { once } from 'node:events';
import { disclosureRouter } from '../src/routes/disclosure.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { DisclosureConsent } from '../src/models/disclosureConsent.js';
import { RoleAssignment } from '../src/models/role.js';
import { defaultPolicy } from '../src/services/disclosurePolicy.js';
const id = '123456789012345678901234', userId = '223456789012345678901234';
const query = value => ({ lean: async () => value });
const start = async (t, { realRender = false } = {}) => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../src/views', import.meta.url).pathname);
  app.locals.assetVersion = 'test';
  app.locals.showNotificationPrompt = false;
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.user = { _id: userId, isAdmin: req.get('x-admin') === 'yes' };
    req.isAuthenticated = () => req.get('x-auth') === 'yes';
    req.session = { csrfToken: 'valid' };
    if (!realRender) res.render = (view, locals) => res.json({ view, ...locals });
    next();
  });
  if (realRender) app.use(webRouter);
  app.use(disclosureRouter); app.get('/login', (_req, res) => res.send('login accessible'));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return async (url, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, { redirect: 'manual', headers: { 'x-auth': 'yes', ...headers }, ...(body ? { method: 'POST', body: new URLSearchParams(body) } : {}) });
};
const stub = t => {
  const association = { _id: id, name: '町内会', officerDisclosurePolicy: defaultPolicy, officerDisclosureHistory: [] };
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query(association));
  t.mock.method(AssociationMembership, 'exists', async () => true);
  t.mock.method(AnnualOfficer, 'exists', async () => true);
  return association;
};
test('router leaves public login accessible and protects disclosure pages', async t => {
  const request = await start(t);
  assert.equal((await request('/login', null, { 'x-auth': 'no' })).status, 200);
  const result = await request('/profile/disclosure', null, { 'x-auth': 'no' });
  assert.equal(result.status, 302); assert.equal(result.headers.get('location'), '/login');
});
test('consent writes bind actor and association, require CSRF and explicit confirmation', async t => {
  stub(t); const saved = [];
  t.mock.method(DisclosureConsent, 'findOneAndUpdate', async (...args) => { saved.push(args); });
  const request = await start(t), body = { ...defaultPolicy, _csrf: 'valid', policyRevision: '0', confirmDisclosure: 'yes', user: 'other-user' };
  assert.equal((await request(`/profile/disclosure/${id}`, { ...body, _csrf: 'bad' })).status, 403);
  assert.equal((await request(`/profile/disclosure/${id}`, { ...body, confirmDisclosure: '' })).status, 400);
  assert.equal((await request(`/profile/disclosure/${id}`, { ...body, photo: 'open' })).status, 400);
  assert.equal((await request(`/profile/disclosure/${id}`, { ...body, policyRevision: '1' })).status, 409);
  assert.equal(saved.length, 0);
  assert.equal((await request(`/profile/disclosure/${id}`, body)).status, 302);
  assert.deepEqual(saved[0][0], { association: id, user: userId });
  assert.equal(saved[0][1].$set.policyRevision, 0);
  assert.equal(saved[0][1].$push.history.actor, userId);
});
test('former officer and another association member cannot submit consent', async t => {
  stub(t); t.mock.method(AnnualOfficer, 'exists', async () => false);
  let writes = 0; t.mock.method(DisclosureConsent, 'findOneAndUpdate', async () => { writes++; });
  const request = await start(t);
  assert.equal((await request(`/profile/disclosure/${id}`, { ...defaultPolicy, _csrf: 'valid', policyRevision: '0', confirmDisclosure: 'yes' })).status, 403);
  assert.equal(writes, 0);
});
test('only managers update policy, with CSRF, revision and audit history', async t => {
  stub(t); t.mock.method(RoleAssignment, 'findOne', () => ({ populate: async () => null }));
  const writes = []; t.mock.method(NeighborhoodAssociation, 'updateOne', async (...args) => { writes.push(args); return { matchedCount: 1 }; });
  const request = await start(t), url = `/associations/${id}/manage/disclosure`, body = { ...defaultPolicy, _csrf: 'valid', policyRevision: '0' };
  assert.equal((await request(url, body)).status, 403);
  assert.equal((await request(url, { ...body, _csrf: 'bad' }, { 'x-admin': 'yes' })).status, 403);
  assert.equal(writes.length, 0);
  assert.equal((await request(url, body, { 'x-admin': 'yes' })).status, 302);
  assert.equal(writes[0][1].$push.officerDisclosureHistory.actor, userId);
  assert.deepEqual(writes[0][1].$push.officerDisclosureHistory.before, defaultPolicy);
});

// The real web router initializes locals consumed by the shared header and notices.
test('manager disclosure GET renders actual template after common locals', async t => {
  stub(t);
  const request = await start(t, { realRender: true });
  const result = await request(`/associations/${id}/manage/disclosure`, null, { 'x-admin': 'yes' });
  assert.equal(result.status, 200);
  const html = await result.text();
  assert.ok(html.includes('個人情報の公開ルール'));
  assert.ok(html.includes('公開ルールを保存'));
  assert.ok(html.includes('name="_csrf" value="valid"'));
});
test('personal disclosure GET also renders actual template with common locals', async t => {
  t.mock.method(AnnualOfficer, 'find', () => ({ select: () => query([]) }));
  t.mock.method(NeighborhoodAssociation, 'find', () => query([]));
  t.mock.method(AssociationMembership, 'find', () => ({ select: () => query([]) }));
  t.mock.method(DisclosureConsent, 'find', () => query([]));
  const request = await start(t, { realRender: true });
  const result = await request('/profile/disclosure', null, { 'x-admin': 'yes' });
  assert.equal(result.status, 200);
  assert.ok((await result.text()).includes('公開設定の対象となる現年度の役員登録はありません'));
});
test('application initializes web locals before mounting disclosure router', async () => {
  const source = await fs.readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf("app.use('/', webRouter)") < source.indexOf("app.use('/', disclosureRouter)"));
});

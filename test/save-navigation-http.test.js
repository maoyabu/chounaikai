import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { webRouter } from '../src/routes/web.js';
import { managementRouter } from '../src/routes/management.js';
import { NotificationSettings } from '../src/models/notificationSettings.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { JoinApplication } from '../src/models/workflow.js';
import { AssociationGroupRequest } from '../src/models/associationGroup.js';
const id = '123456789012345678901234';
const start = async t => {
  const session = { csrfToken: 'valid' };
  const app = express();
  app.set('view engine', 'ejs'); app.set('views', new URL('../src/views', import.meta.url).pathname);
  app.locals.assetVersion = 'test'; app.locals.showNotificationPrompt = false;
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.session = session;
    req.isAuthenticated = () => req.get('x-auth') !== 'no';
    req.user = req.isAuthenticated() ? { _id: id, isAdmin: true, displayname: '管理者' } : null;
    next();
  });
  app.use(webRouter); app.use('/associations', managementRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).send(error.message));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return (path, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    redirect: 'manual', headers,
    ...(body ? { method: 'POST', body: new URLSearchParams(body) } : {})
  });
};
test('notification save redirects to management and completion notice appears once on that page', async t => {
  const changes = [];
  t.mock.method(NotificationSettings, 'findOneAndUpdate', async (...args) => { changes.push(args); });
  t.mock.method(NeighborhoodAssociation, 'findOne', () => ({ lean: async () => ({ _id: id, name: '町内会' }) }));
  t.mock.method(JoinApplication, 'countDocuments', async () => 0);
  t.mock.method(AssociationGroupRequest, 'countDocuments', async () => 0);
  const request = await start(t);
  const saved = await request(`/associations/${id}/manage/notifications`, { _csrf: 'valid', join_email: 'on', join_push: 'on' });
  assert.equal(saved.status, 302); assert.equal(saved.headers.get('location'), `/associations/${id}/manage`);
  assert.equal(changes.length, 1);
  const page = await request(saved.headers.get('location'));
  assert.equal(page.status, 200); assert.ok((await page.text()).includes('通知設定を保存しました。'));
  assert.ok(!(await (await request(saved.headers.get('location'))).text()).includes('通知設定を保存しました。'));
});
test('unauthenticated and invalid-CSRF requests do not save or redirect to management as success', async t => {
  let writes = 0;
  t.mock.method(NotificationSettings, 'findOneAndUpdate', async () => { writes++; });
  const request = await start(t), path = `/associations/${id}/manage/notifications`;
  const anonymous = await request(path, { _csrf: 'valid' }, { 'x-auth': 'no' });
  assert.equal(anonymous.status, 302); assert.equal(anonymous.headers.get('location'), '/login');
  const invalid = await request(path, { _csrf: 'invalid' });
  assert.equal(invalid.status, 403); assert.equal(invalid.headers.get('location'), null); assert.equal(writes, 0);
});

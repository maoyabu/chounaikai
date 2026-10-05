import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import { privacyAudit } from '../src/middleware/privacyAudit.js';
import { PrivacyAccessLog } from '../src/models/privacyAccessLog.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { auditedViews, buildPrivacyEvent, collectPrivacyTargets } from '../src/services/privacyAuditService.js';
import { privacyAuditQuery, privacyAuditNextUrl } from '../src/services/privacyAuditQuery.js';
import { privacyAuditRouter } from '../src/routes/privacyAudit.js';
import { authRouter } from '../src/routes/auth.js';
import { associationsRouter } from '../src/routes/associations.js';
import { AssociationMembership } from '../src/models/associationMembership.js';

const actorId = '507f1f77bcf86cd799439011', associationId = '507f1f77bcf86cd799439012';
const targetId = '507f1f77bcf86cd799439013', householdId = '507f1f77bcf86cd799439014';
const actor = { _id: actorId, username: 'system-admin', displayname: '管理者', isAdmin: true, email: 'admin@example.invalid', hash: 'secret-hash' };

test('privacy audit collects identifiers without copying personal values or tokens', () => {
  const data = { association: { _id: associationId }, members: [{ _id: targetId, user: { _id: targetId, email: 'private@example.invalid', hash: 'hidden' }, household: householdId, name: '秘密の名前', phone: '秘密の電話' }], body: 'private body', invitation: { _id: targetId, token: 'private-token' } };
  const req = { user: actor, params: {}, method: 'GET', ip: '127.0.0.1', baseUrl: '/associations', route: { path: '/:associationId/manage/members' }, originalUrl: '/path?token=never-log' };
  const event = buildPrivacyEvent(req, { category: 'residents', resource: 'association-members', data });
  assert.equal(event.actor, actorId); assert.equal(event.actorKind, 'system_admin');
  assert.equal(event.association, associationId); assert.deepEqual(event.associations, [associationId]);
  assert.ok(event.targets.includes(`user:${targetId}`)); assert.ok(event.targets.includes(`household:${householdId}`));
  const serialized = JSON.stringify(event);
  for (const secret of ['private@example.invalid', 'secret-hash', 'private-token', 'never-log', '秘密の名前', '秘密の電話', 'private body']) assert.ok(!serialized.includes(secret));
  assert.equal(event.route, '/associations/:associationId/manage/members');
  assert.ok(event.actorName.includes('system-admin'));
});

test('privacy audit handles ObjectIds, multiple associations, anonymous views and bounded target lists', () => {
  const req = { params: { fileId: 'drive-file_01' }, method: 'GET', ip: '127.0.0.1', route: { path: '/:fileId' } };
  const event = buildPrivacyEvent(req, { category: 'documents', resource: 'file', data: { associations: [{ _id: new mongoose.Types.ObjectId(associationId) }, { _id: new mongoose.Types.ObjectId(targetId) }] } });
  assert.equal(event.actor, null); assert.equal(event.actorKind, 'anonymous');
  assert.deepEqual(event.associations, [associationId, targetId]); assert.ok(event.targets.includes('file:drive-file_01'));
  const many = collectPrivacyTargets({ members: Array.from({ length: 5001 }, (_, i) => ({ _id: String(i) })) });
  assert.equal(many.targets.length, 5000); assert.equal(many.targetCount, 5001); assert.equal(many.targetsTruncated, true);
  const cycle = {}; cycle.self = cycle; assert.deepEqual(collectPrivacyTargets(cycle).targets, []);
});

test('privacy audit query uses JST day boundaries and escapes historical actor names', () => {
  const { filter, filters } = privacyAuditQuery({ from: '2026-10-01', to: '2026-10-05', actor: 'a.*', association: associationId, category: 'residents', action: 'view', target: targetId });
  assert.equal(filter.createdAt.$gte.toISOString(), '2026-09-30T15:00:00.000Z');
  assert.equal(filter.createdAt.$lt.toISOString(), '2026-10-05T15:00:00.000Z');
  assert.equal(filter.actorName.$regex, 'a\\.\\*'); assert.equal(filter.associations, associationId);
  assert.equal(filter.targets.$regex, `:${targetId}$`);
  assert.equal(filters.category, 'residents');
  assert.equal(privacyAuditQuery({}, new Date('2026-10-05T12:00:00Z')).filters.from, '2026-09-06');
});

test('privacy audit rejects malformed filters, operators, impossible dates and cursors', () => {
  for (const query of [{ actor: { $ne: null } }, { from: '2026-02-30' }, { from: '2026-10-06', to: '2026-10-05' }, { action: 'delete' }, { category: '__proto__' }, { association: 'wrong' }, { target: '.*' }, { cursor: 'broken' }, { from: ['2026-10-01'] }]) {
    assert.throws(() => privacyAuditQuery(query), error => error.status === 400);
  }
});

test('privacy audit cursor keeps filters and uses timestamp plus ID for stable pages', () => {
  const filters = privacyAuditQuery({ actor: 'admin', category: 'residents' }, new Date('2026-10-05')).filters;
  const log = { _id: targetId, createdAt: new Date('2026-10-04T00:00:00Z') };
  const url = privacyAuditNextUrl(filters, log);
  const parsed = privacyAuditQuery(Object.fromEntries(new URL(url, 'http://local').searchParams));
  assert.equal(parsed.filter.actorName.$regex, 'admin');
  assert.equal(parsed.filter.$or[1]._id.$lt, targetId); assert.equal(parsed.filter.$or[1].createdAt.toISOString(), log.createdAt.toISOString());
});

async function withServer({ writer = async () => {}, user = actor, engine, routes = () => {} }, task) {
  const app = express();
  app.set('views', path.resolve('src/views')); app.set('view engine', 'ejs');
  if (engine) app.engine('ejs', engine);
  app.locals.assetVersion = 'test';
  app.use((req, res, next) => {
    req.user = user; req.isAuthenticated = () => Boolean(user);
    Object.assign(res.locals, { currentUser: user, currentPath: req.path, csrfToken: 'test-csrf', showNotificationPrompt: false }); next();
  });
  app.use(privacyAudit({ writer })); routes(app);
  app.use((error, req, res, _next) => res.status(error.status || 500).send('request-failed'));
  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const request = async (route, options = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { ...options, redirect: 'manual' });
      return { status: response.status, headers: response.headers, text: await response.text() };
    };
    await task(request);
  } finally { await new Promise(resolve => server.close(resolve)); }
}

const fakeEngine = (_file, options, callback) => callback(null, options.secret || 'rendered');
test('HTTP: sensitive HTML is sent only after the audit record is persisted, exactly once', async () => {
  const events = [];
  await withServer({ engine: fakeEngine, writer: async event => { await new Promise(resolve => setTimeout(resolve, 10)); events.push(event); }, routes(app) {
    app.get('/associations/:associationId/manage/members', (req, res) => res.render('association-members', { secret: 'personal-data', members: [{ user: { _id: targetId } }] }));
  } }, async request => {
    const response = await request(`/associations/${associationId}/manage/members?email=never-log`);
    assert.equal(response.status, 200); assert.equal(response.text, 'personal-data');
    assert.equal(events.length, 1); assert.equal(events[0].association, associationId);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.ok(!JSON.stringify(events).includes('never-log'));
  });
});

test('HTTP: failed audit persistence blocks HTML, JSON and downloads without data disclosure', async () => {
  await withServer({ engine: fakeEngine, writer: async () => { throw new Error('offline'); }, routes(app) {
    app.get('/html', (req, res) => res.render('association-members', { secret: 'never-disclose' }));
    for (const route of ['/json', '/download']) app.get(route, async (req, res, next) => {
      try { await req.auditPersonalData({ category: 'documents', resource: route, action: 'download' }); res.send('never-disclose'); } catch (error) { next(error); }
    });
  } }, async request => {
    for (const route of ['/html', '/json', '/download']) { const response = await request(route); assert.equal(response.status, 503); assert.ok(!response.text.includes('never-disclose')); }
  });
});

test('HTTP: denied requests, redirects, rendering errors and untracked pages do not record successful views', async () => {
  const events = [];
  await withServer({ engine: (file, options, callback) => options.fail ? callback(new Error('template-failure')) : fakeEngine(file, options, callback), writer: async event => events.push(event), routes(app) {
    app.get('/denied', (req, res) => res.status(403).render('association-members'));
    app.get('/redirect', (req, res) => res.redirect('/login'));
    app.get('/error', (req, res) => res.render('association-members', { fail: true }));
    app.get('/login', (req, res) => res.render('login'));
  } }, async request => {
    for (const route of ['/denied', '/redirect', '/error', '/login']) await request(route);
    assert.equal(events.length, 0);
  });
});

test('HTTP: real profile API records the viewed user after authentication', async () => {
  const events = [];
  await withServer({ writer: async event => events.push(event), routes(app) { app.use('/api/auth', authRouter); } }, async request => {
    const response = await request('/api/auth/me');
    assert.equal(response.status, 200); assert.ok(events[0].targets.includes(`user:${actorId}`));
    assert.ok(!response.text.includes('secret-hash'));
  });
  await withServer({ user: null, writer: async event => events.push(event), routes(app) { app.use('/api/auth', authRouter); } }, async request => {
    assert.equal((await request('/api/auth/me')).status, 401); assert.equal(events.length, 1);
  });
});

test('HTTP: association API permission checks happen before recording disclosure', async () => {
  const events = [], original = { association: NeighborhoodAssociation.findById, membership: AssociationMembership.findOne };
  NeighborhoodAssociation.findById = () => ({ async lean() { return { _id: associationId, requestedBy: targetId }; } });
  AssociationMembership.findOne = async () => null;
  try {
    await withServer({ user: { ...actor, isAdmin: false }, writer: async event => events.push(event), routes(app) { app.use('/api/associations', associationsRouter); } }, async request => {
      assert.equal((await request(`/api/associations/${associationId}`)).status, 404); assert.equal(events.length, 0);
    });
    await withServer({ writer: async event => events.push(event), routes(app) { app.use('/api/associations', associationsRouter); } }, async request => {
      assert.equal((await request(`/api/associations/${associationId}`)).status, 200); assert.equal(events.length, 1);
    });
  } finally { NeighborhoodAssociation.findById = original.association; AssociationMembership.findOne = original.membership; }
});

test('HTTP: audit screen is system-admin-only, paginated, escaped and itself audited', async () => {
  const originals = { logs: PrivacyAccessLog.find, associations: NeighborhoodAssociation.find };
  let reads = 0, lastQuery, limit;
  const events = [];
  const rows = Array.from({ length: 51 }, (_, i) => ({ _id: new mongoose.Types.ObjectId(), actor: actorId, actorName: '<script>alert(1)</script>', actorKind: 'system_admin', associations: [associationId, targetId], action: 'view', category: 'residents', resource: 'association-members', targets: [`user:${targetId}`], targetCount: 1, route: '/:associationId/manage/members', method: 'GET', ip: '127.0.0.1', requestId: `request-${i}`, createdAt: new Date('2026-10-05T00:00:00Z') }));
  PrivacyAccessLog.find = query => { reads++; lastQuery = query; return { sort() { return this; }, limit(value) { limit = value; return this; }, async lean() { return rows; } }; };
  NeighborhoodAssociation.find = () => ({ select() { return this; }, sort() { return this; }, async lean() { return [{ _id: associationId, name: 'テスト町内会' }]; } });
  try {
    for (const user of [null, { ...actor, isAdmin: false }]) await withServer({ user, writer: async event => events.push(event), engine: fakeEngine, routes(app) { app.use(privacyAuditRouter); } }, async request => {
      const response = await request('/admin/privacy-audit'); assert.equal(response.status, user ? 403 : 302); assert.equal(reads, 0);
    });
    await withServer({ writer: async event => events.push(event), routes(app) { app.use(privacyAuditRouter); } }, async request => {
      const response = await request(`/admin/privacy-audit?from=2026-10-01&to=2026-10-05&association=${associationId}`);
      assert.equal(response.status, 200); assert.equal(limit, 51); assert.equal(lastQuery.associations, associationId);
      assert.ok(response.text.includes('次の50件')); assert.ok(response.text.includes('テスト町内会')); assert.ok(response.text.includes('削除済み・名称不明'));
      assert.ok(response.text.includes('&lt;script&gt;')); assert.ok(!response.text.includes('<script>alert(1)</script>'));
      assert.equal(events.length, 1); assert.equal(events[0].category, 'audit'); assert.equal(events[0].targets.filter(target => target.startsWith('audit:')).length, 50);
      assert.equal((await request('/admin/privacy-audit?from=bad')).status, 400); assert.equal(reads, 1);
    });
  } finally { PrivacyAccessLog.find = originals.logs; NeighborhoodAssociation.find = originals.associations; }
});

test('personal information view inventory includes management, family, communications, finance and documents', () => {
  for (const view of ['admin-dashboard', 'association-members', 'profile', 'leader-dashboard', 'association-annual-settings', 'officer-announcement-detail', 'system-contact', 'question-detail', 'association-finance-entries', 'documents-view', 'privacy-audit']) assert.ok(auditedViews[view]);
  for (const view of ['login', 'mfa', 'error', 'password-reset']) assert.equal(auditedViews[view], undefined);
});

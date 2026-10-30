import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';
import { Passport } from 'passport';
import { createLineLoginService, lineLoginConfig } from '../src/services/lineLoginService.js';
import { createLineLoginRouter, enforceLineSession } from '../src/routes/lineLogin.js';
import { provideCsrfToken } from '../src/middleware/csrf.js';
import { enforceAdminMfa, completeMfa } from '../src/middleware/mfa.js';
import { authRatePolicy } from '../src/middleware/authRateLimit.js';
import { LineIdentity, LineFlow } from '../src/models/lineIdentity.js';
import ejs from 'ejs';
import MongoStore from 'connect-mongo';
import { createApp } from '../src/app.js';
import { User } from '../src/models/user.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { ResidentRegistration } from '../src/models/residentRegistration.js';

const config = { channelId: '123456', channelSecret: 'test-secret', callbackUrl: 'https://example.com/auth/line/callback' };
const baseUser = { _id: 'u1', hash: 'password-hash', emailVerifiedAt: new Date(), authenticate(password, cb) { cb(null, password === 'correct' ? this : false); } };
function fixture() {
  let time = Date.now(), counter = 0;
  const identities = [], flows = [], users = [{ ...baseUser }], requests = [];
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object') {
      if ('$exists' in value) return (row[key] !== undefined) === value.$exists;
      if ('$gt' in value) return row[key] > value.$gt;
    }
    return String(row[key]) === String(value);
  });
  const query = fn => ({ async lean() { return fn(); } });
  const unique = row => {
    if (identities.some(other => other._id !== row._id && other.channelId === row.channelId &&
      (other.user === row.user || (row.subject && row.subject === other.subject)))) throw Object.assign(new Error('duplicate'), { code: 11000 });
  };
  const Identity = {
    findOne: filter => query(() => identities.find(row => matches(row, filter)) || null),
    findOneAndUpdate: (filter, update, options = {}) => query(() => {
      let row = identities.find(row => matches(row, filter));
      if (!row && options.upsert) { row = { _id: `i${++counter}`, ...update.$setOnInsert }; unique(row); identities.push(row); }
      if (!row) return null;
      const next = { ...row, ...update.$set }; unique(next); Object.assign(row, next); return { ...row };
    }),
    async deleteOne(filter) { const i = identities.findIndex(row => matches(row, filter)); if (i >= 0) identities.splice(i, 1); },
    async exists(filter) { return identities.some(row => matches(row, filter)); }
  };
  const Flow = {
    async create(values) { flows.push({ ...values }); },
    findOneAndDelete: filter => query(() => { const i = flows.findIndex(row => matches(row, filter)); return i < 0 ? null : flows.splice(i, 1)[0]; }),
    async deleteMany(filter) { for (let i = flows.length - 1; i >= 0; i--) if (matches(flows[i], filter)) flows.splice(i, 1); }
  };
  let overrides = {}, rejected = false;
  const service = createLineLoginService({ config, Identity, Flow,
    Users: { findById(id) { return { async select() { return users.find(u => u._id === String(id)); } }; } },
    now: () => time,
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: Object.fromEntries(options.body) });
      if (url.endsWith('/token')) return { ok: !rejected, async json() { return { id_token: 'test-id-token', access_token: 'not-persisted', refresh_token: 'not-persisted' }; } };
      return { ok: true, async json() { return { iss: 'https://access.line.me', aud: config.channelId, sub: 'line-user', nonce: options.body.get('nonce'), exp: Math.floor(time / 1000) + 100, ...overrides }; } };
    }
  });
  return { service, identities, flows, users, requests, advance(ms) { time += ms; }, claims(value) { overrides = value; }, reject() { rejected = true; } };
}
async function start(f, mode = 'login', binding = 'browser-binding') {
  const url = new URL(await f.service.start({ binding, mode, user: mode === 'link' ? f.users[0] : undefined }));
  return { url, binding, state: url.searchParams.get('state') };
}
const consume = (f, flow) => f.service.consume({ state: flow.state, binding: flow.binding });

test('LINE configuration is optional, paired and pinned to a trusted HTTPS origin', () => {
  assert.equal(lineLoginConfig({ env: {} }), null);
  assert.throws(() => lineLoginConfig({ env: { LINE_LOGIN_CHANNEL_ID: '123' } }), /together/);
  for (const origin of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path']) {
    assert.throws(() => lineLoginConfig({ env: { LINE_LOGIN_CHANNEL_ID: '123', LINE_LOGIN_CHANNEL_SECRET: 'secret' }, publicBaseUrl: origin, nodeEnv: 'production' }));
  }
  assert.equal(lineLoginConfig({ env: { LINE_LOGIN_CHANNEL_ID: '123', LINE_LOGIN_CHANNEL_SECRET: 'secret' }, publicBaseUrl: 'https://example.com/' }).callbackUrl, 'https://example.com/auth/line/callback');
});

test('authorization uses minimal scope, nonce, PKCE and no client secret in the browser URL', async () => {
  const f = fixture(), { url } = await start(f);
  assert.equal(url.origin, 'https://access.line.me');
  assert.equal(url.searchParams.get('scope'), 'openid');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), crypto.createHash('sha256').update(f.flows[0].verifier).digest('base64url'));
  assert.ok(!url.toString().includes(config.channelSecret));
});

test('flows reject another browser, expiry, invalid state and simultaneous replay', async () => {
  const f = fixture(), begun = await start(f);
  await assert.rejects(f.service.consume({ state: begun.state, binding: 'another-browser' }));
  await assert.rejects(f.service.consume({ state: [begun.state], binding: begun.binding }));
  const results = await Promise.allSettled([consume(f, begun), consume(f, begun)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const expired = await start(f); f.advance(10 * 60 * 1000);
  await assert.rejects(consume(f, expired));
});

test('ID token is verified by LINE; issuer, audience, nonce, expiry and subject are checked', async () => {
  const f = fixture(), flow = await consume(f, await start(f));
  assert.equal(await f.service.authenticate('code', flow), 'line-user');
  assert.equal(f.requests[0].body.redirect_uri, config.callbackUrl);
  assert.equal(f.requests[0].body.code_verifier, flow.verifier);
  assert.equal(f.requests[1].body.nonce, flow.nonce);
  for (const invalid of [{ iss: 'https://evil.example' }, { aud: 'another-channel' }, { nonce: 'wrong' }, { exp: 1 }, { sub: '' }]) {
    f.claims(invalid); await assert.rejects(f.service.authenticate('code', flow));
  }
  f.reject(); await assert.rejects(f.service.authenticate('code', flow));
  assert.ok(!JSON.stringify(f.flows).includes('not-persisted'));
});

test('linking is individual, unique and cannot replace an existing identity', async () => {
  const f = fixture(), user = f.users[0], flow = await consume(f, await start(f, 'link'));
  await assert.rejects(f.service.link('line-user', flow, { ...user, _id: 'other' }));
  await assert.rejects(f.service.link('line-user', flow, { ...user, hash: 'changed' }));
  const identity = await f.service.link('line-user', flow, user);
  assert.equal((await f.service.resolve('line-user')).user._id, user._id);
  await assert.rejects(f.service.link('other-line', flow, user));
  f.users.push({ ...baseUser, _id: 'u2' });
  const other = await f.service.start({ mode: 'link', user: f.users[1], binding: 'other' });
  const otherFlow = await f.service.consume({ state: new URL(other).searchParams.get('state'), binding: 'other' });
  await assert.rejects(f.service.link('line-user', otherFlow, f.users[1]), /すでに/);
  assert.equal(identity.subject, 'line-user');
});

test('unlink invalidates sessions, pending and already-consumed link operations; passwords and account status matter', async () => {
  const f = fixture(), user = f.users[0];
  const flow = await consume(f, await start(f, 'link'));
  await f.service.unlink(user._id);
  await assert.rejects(f.service.link('line-user', flow, user));
  const nextFlow = await consume(f, await start(f, 'link'));
  const identity = await f.service.link('line-user', nextFlow, user);
  const marker = { identityId: identity._id, fingerprint: crypto.createHash('sha256').update(user.hash).digest('hex') };
  assert.ok(await f.service.validSession(user, marker));
  assert.equal(await f.service.validSession({ ...user, hash: 'changed' }, marker), false);
  user.unsubscribe_date = new Date(); await assert.rejects(f.service.resolve('line-user'));
  delete user.unsubscribe_date; user.emailVerificationRequired = true; delete user.emailVerifiedAt;
  await assert.rejects(f.service.resolve('line-user'));
  await f.service.unlink(user._id);
  assert.equal(await f.service.validSession(user, marker), false);
  await assert.rejects(f.service.resolve('unknown'));
});

test('production schemas enforce per-user and per-LINE uniqueness and flow expiry', () => {
  assert.equal(LineIdentity.collection.name, 'chounaikai_line_identities');
  assert.equal(LineIdentity.schema.indexes().filter(([, options]) => options.unique).length, 2);
  assert.ok(LineFlow.schema.indexes().some(([, options]) => options.expireAfterSeconds === 0));
  for (const path of ['/profile/line/link', '/profile/line/unlink']) assert.equal(authRatePolicy({ method: 'POST', path }), 'password');
  assert.equal(authRatePolicy({ method: 'GET', path: '/auth/line/callback' }), 'token');
});

test('real login and settings templates render enabled, disabled, linked and unlinked states', async () => {
  const locals = { title: 'LINEログイン設定', assetVersion: 'test', csrfToken: 'token', currentUser: null, notice: null, errorMessage: null, currentPath: '/profile/line', showNotificationPrompt: false };
  const login = await ejs.renderFile('src/views/login.ejs', { ...locals, lineLoginEnabled: true });
  assert.match(login, /action="\/auth\/line"/);
  assert.match(login, /line-login-icon.png/);
  assert.ok(!(await ejs.renderFile('src/views/login.ejs', { ...locals, lineLoginEnabled: false })).includes('action="/auth/line"'));
  for (const linked of [null, { _id: 'identity' }]) {
    const html = await ejs.renderFile('src/views/line-settings.ejs', { ...locals, currentUser: baseUser, lineEnabled: true, linked });
    assert.match(html, new RegExp(`action="/profile/line/${linked ? 'unlink' : 'link'}"`));
    assert.match(html, /name="currentPassword"/);
    assert.match(html, /name="_csrf"/);
    const profile = await ejs.renderFile('src/views/profile.ejs', { ...locals, currentUser: baseUser,
      currentPath: '/profile', values: {}, formError: null, lineLoginEnabled: true, lineLinked: linked });
    assert.ok(profile.indexOf('id="notification-settings-title"') < profile.indexOf('id="line-login"'));
    const basic = profile.slice(profile.indexOf('id="account-panel-basic"'), profile.indexOf('id="account-panel-login"'));
    assert.ok(!basic.includes('notification-settings-title'));
    assert.ok(!basic.includes('id="line-login"'));
    assert.match(basic, /<details id="password-change" class="form-card profile-line-settings">/);
    assert.match(profile, /data-account-panel="login" hidden/);
    assert.match(profile, /data-account-tab="disclosure">個人情報の公開/);
    assert.match(profile, /data-account-tab="withdrawals">退会申請/);
    assert.match(profile, /data-account-content="disclosure"/);
    assert.match(profile, /data-account-content="withdrawals"/);
    assert.match(profile, /<details id="line-login" class="form-card profile-line-settings">/);
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(profile.slice(profile.indexOf('id="line-login"')))[1];
    assert.ok(summary.includes(linked ? '連携済み' : '未連携'));
    assert.match(profile, new RegExp(`action="/profile/line/${linked ? 'unlink' : 'link'}"`));
  }
  assert.match(await ejs.renderFile('src/views/line-settings.ejs', { ...locals, lineEnabled: false, linked: null }), /現在準備中/);
});

async function withHttp(task, { mfa = false } = {}) {
  const f = fixture(), passport = new Passport(), app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(session({ secret: 'line-http-test-secret', resave: false, saveUninitialized: false }));
  passport.serializeUser((user, cb) => cb(null, user._id));
  passport.deserializeUser((id, cb) => cb(null, f.users.find(user => user._id === id)));
  app.use(passport.initialize()); app.use(passport.session());
  app.use(enforceLineSession(f.service));
  app.locals.mfaService = { async getState() { return { required: mfa, credential: mfa ? { enabledAt: new Date(), revision: 1 } : null }; } };
  app.use(enforceAdminMfa(app.locals.mfaService));
  app.use(provideCsrfToken);
  app.use((_req, res, next) => { res.render = (_name, data) => res.json(data); next(); });
  app.get('/test/session', (req, res) => res.json({ csrf: req.session.csrfToken, user: req.user?._id, marker: req.session.lineLogin, invitation: req.session.householdInvitationId, choice: req.session.registrationChoice }));
  app.post('/test/local', (req, res, next) => req.logIn(f.users[0], error => error ? next(error) : res.end()));
  app.post('/test/context', (req, res) => { req.session.householdInvitationId = 'invite'; req.session.registrationChoice = { purpose: 'join' }; res.end(); });
  app.post('/mfa/test-complete', async (req, res, next) => { try { await completeMfa(req, { revision: 1 }); res.redirect('/test/session'); } catch (error) { next(error); } });
  app.use(createLineLoginRouter(f.service));
  app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (path, body) => {
      const response = await fetch(origin + path, { redirect: 'manual', method: body ? 'POST' : 'GET',
        headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: body ? new URLSearchParams(body) : undefined });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const text = await response.text();
      return { status: response.status, location: response.headers.get('location'), text, json: () => JSON.parse(text) };
    };
  };
  try { await task({ f, client }); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('HTTP linking requires login, CSRF and password; cancel and unlinked login do not authenticate', async () => withHttp(async ({ f, client }) => {
  const request = client();
  assert.equal((await request('/profile/line')).location, '/login');
  const csrf = (await request('/test/session')).json().csrf;
  assert.equal((await request('/auth/line', {})).status, 403);
  const begin = await request('/auth/line', { _csrf: csrf });
  const state = new URL(begin.location).searchParams.get('state');
  assert.equal((await request(`/auth/line/callback?state=${state}&code=code`)).location, '/login');
  assert.equal((await request('/test/session')).json().user, undefined);
  await request('/test/local', {});
  const token = (await request('/test/session')).json().csrf;
  assert.equal((await request('/profile/line/link', { _csrf: token, currentPassword: 'wrong' })).location, '/profile?tab=login#line-login');
  assert.equal(f.flows.length, 0);
  const link = await request('/profile/line/link', { _csrf: token, currentPassword: 'correct' });
  const linkState = new URL(link.location).searchParams.get('state');
  assert.equal((await request(`/auth/line/callback?state=${linkState}&error=access_denied`)).location, '/profile?tab=login#line-login');
  assert.equal(await f.service.status('u1'), null);
}));

test('HTTP LINE login preserves invitation context, requires MFA, retains revocation marker across MFA, and rejects revoked sessions', async () => withHttp(async ({ f, client }) => {
  const flow = await consume(f, await start(f, 'link'));
  await f.service.link('line-user', flow, f.users[0]);
  const request = client();
  const csrf = (await request('/test/session')).json().csrf;
  await request('/test/context', {});
  const begin = await request('/auth/line', { _csrf: csrf });
  const state = new URL(begin.location).searchParams.get('state');
  const callback = await request(`/auth/line/callback?state=${state}&code=code`);
  assert.equal(callback.location, '/mfa/verify');
  assert.equal((await request('/test/session')).location, '/mfa/verify');
  await request('/mfa/test-complete', {});
  assert.equal((await request('/test/session')).json().user, 'u1');
  assert.equal((await request('/test/session')).json().invitation, 'invite');
  assert.deepEqual((await request('/test/session')).json().choice, { purpose: 'join' });
  assert.ok((await request('/test/session')).json().marker);
  await f.service.unlink('u1');
  assert.equal((await request('/test/session')).location, '/login');
}, { mfa: true }));

test('HTTP successful linking, ordinary login and password-confirmed unlink work end to end', async () => withHttp(async ({ f, client }) => {
  const owner = client();
  await owner('/test/local', {});
  const csrf = (await owner('/test/session')).json().csrf;
  const start = await owner('/profile/line/link', { _csrf: csrf, currentPassword: 'correct' });
  const state = new URL(start.location).searchParams.get('state');
  assert.equal((await owner(`/auth/line/callback?state=${state}&code=code`)).location, '/profile?tab=login#line-login');
  assert.ok(await f.service.status('u1'));
  const login = client();
  const token = (await login('/test/session')).json().csrf;
  const begin = await login('/auth/line', { _csrf: token });
  const loginState = new URL(begin.location).searchParams.get('state');
  assert.equal((await login(`/auth/line/callback?state=${loginState}&code=code`)).location, '/login/complete');
  assert.equal((await login('/test/session')).json().user, 'u1');
  assert.equal((await owner('/profile/line/unlink', { _csrf: csrf, currentPassword: 'wrong' })).location, '/profile?tab=login#line-login');
  assert.ok(await f.service.status('u1'));
  assert.equal((await owner('/profile/line/unlink', { _csrf: csrf, currentPassword: 'correct' })).location, '/login');
  assert.equal(await f.service.status('u1'), null);
  assert.equal((await login('/test/session')).location, '/login');
}));

test('actual application mounts LINE routes with common locals, CSRF, security headers and Passport sessions', async t => {
  const f = fixture();
  f.users[0].isAdmin = true; // Keep the common navigation fixture independent of membership queries.
  t.mock.method(MongoStore, 'create', () => new session.MemoryStore());
  t.mock.method(User, 'findOne', async () => f.users[0]);
  t.mock.method(User, 'findById', () => ({ select: async () => f.users[0] }));
  t.mock.method(AssociationMembership, 'find', () => ({ populate() { return this; }, async lean() { return []; } }));
  t.mock.method(ResidentRegistration, 'findOne', () => ({ async lean() { return null; } }));
  const app = createApp({ mongoUri: 'mongodb://127.0.0.1:27017/unused', sessionSecret: 'line-app-test', lineLoginService: f.service,
    mfaService: { async getState() { return { required: false, credential: null }; } },
    siteSecurityService: { async get() { return { mfaEnabled: true, revision: 'test' }; } },
    privacyAuditWriter: async () => {}, rateLimitStore: { async increment() { return 1; } } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  let cookie = '';
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body ? 'POST' : 'GET',
      redirect: 'manual', headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: body ? new URLSearchParams(body) : undefined });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, location: response.headers.get('location'), headers: response.headers, text: await response.text() };
  };
  try {
    const page = await request('/login');
    assert.match(page.text, /LINEでログイン/);
    assert.match(page.headers.get('content-security-policy'), /form-action[^;]*https:\/\/access.line.me/);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
    assert.equal((await request('/login', { identifier: 'resident', password: 'correct', _csrf: csrf })).location, '/dashboard');
    const settings = await request('/profile/line');
    assert.equal(settings.status, 200);
    assert.match(settings.text, /LINEは連携されていません/);
    const token = /name="_csrf" value="([^"]+)"/.exec(settings.text)[1];
    const begin = await request('/profile/line/link', { currentPassword: 'correct', _csrf: token });
    const state = new URL(begin.location).searchParams.get('state');
    assert.equal((await request(`/auth/line/callback?state=${state}&code=code`)).location, '/profile?tab=login#line-login');
    const linked = await request('/profile/line');
    assert.match(linked.text, /LINEと連携済みです/);
    assert.match(linked.text, /次回から/);
    assert.equal(linked.headers.get('cache-control'), 'no-store');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

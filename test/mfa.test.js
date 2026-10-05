import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generate, generateSecret } from 'otplib';
import { createMfaService, encryptMfaSecret, decryptMfaSecret, recoveryDigest, passwordFingerprint, MFA_PENDING_MS, MFA_SESSION_MS } from '../src/services/mfaService.js';
import { enforceAdminMfa, mfaVerified, recentPrimaryAuth, safeMfaReturnTo } from '../src/middleware/mfa.js';
import { mfaEncryptionKey } from '../src/config/mfa.js';
import { authRatePolicy, createAuthRateLimiter, createMemoryRateStore } from '../src/middleware/authRateLimit.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';

const key = crypto.randomBytes(32);
const user = { _id: '507f1f77bcf86cd799439011', isAdmin: true, email: 'admin@example.invalid', hash: 'password-hash' };
const response = () => ({ statusCode: 200, headers: {}, set(name, value) { this.headers[name] = value; return this; }, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; }, redirect(value) { this.redirected = value; }, render(_view, data) { this.data = data; }, clearCookie() { this.cleared = true; } });

// A repository double exercises the protocol and the update filters; real MongoDB
// atomicity and unique indexes are tested separately in mfa-mongo.test.js.
export function fixture() {
  let time = Date.now();
  const rows = new Map(), events = [], roleCalls = [];
  const clone = value => value ? structuredClone(value) : null;
  const matches = (row, filter) => row && Object.entries(filter).every(([field, value]) => {
    if (field === 'lastUsedStep') return row[field] < value.$lt;
    if (field === 'recoveryCodeDigests') return row[field]?.includes(value);
    return String(row[field]) === String(value);
  });
  const Credential = {
    findOne(filter) {
      let fields;
      return { select(value) { fields = value; return this; }, async lean() {
        const row = clone(rows.get(String(filter.user)));
        if (!row || fields?.startsWith('+')) return row;
        return Object.fromEntries(fields.split(' ').filter(field => field in row).map(field => [field, row[field]]));
      } };
    },
    async create(values) {
      if (rows.has(String(values.user))) throw Object.assign(new Error('duplicate'), { code: 11000 });
      rows.set(String(values.user), clone(values)); return clone(values);
    },
    findOneAndUpdate(filter, update) { return { async lean() {
      const row = rows.get(String(filter.user)); if (!matches(row, filter)) return null;
      Object.assign(row, update.$set || {});
      if (update.$pull) row.recoveryCodeDigests = row.recoveryCodeDigests.filter(value => value !== update.$pull.recoveryCodeDigests);
      return clone(row);
    } }; }
  };
  const Roles = { async distinct(_field, filter) { roleCalls.push(filter); return ['manager-role']; } };
  const Assignments = { async exists(filter) { roleCalls.push(filter); return filter.user === 'manager' ? { _id: 'assignment' } : null; } };
  const service = createMfaService({ key, Credential, Event: { async create(value) { events.push(value); } }, Roles, Assignments, now: () => time });
  return { service, rows, events, roleCalls, now: () => time, advance(ms = 30000) { time += ms; } };
}
const enroll = async f => {
  const setup = f.service.newSetup(user);
  const details = await f.service.setupDetails(user, setup);
  const code = await generate({ secret: details.secret, epoch: Math.floor(f.now() / 1000) });
  const result = await f.service.confirmSetup(user, setup, code);
  return { setup, details, code, ...result };
};

test('TOTP compatibility uses the RFC6238 SHA1 vector and local QR generation', async () => {
  assert.equal(await generate({ secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', epoch: 59 }), '287082');
  const f = fixture(), setup = f.service.newSetup(user), details = await f.service.setupDetails(user, setup);
  assert.match(details.qrCode, /^data:image\/png;base64,/);
  assert.match(details.secret, /^[A-Z2-7]+$/);
  assert.ok(!JSON.stringify(setup).includes(details.secret));
  f.advance(MFA_PENDING_MS);
  await assert.rejects(f.service.confirmSetup(user, setup, '287082'), /有効期限/);
});

test('encryption binds secrets to user and key, detecting tampering', () => {
  const secret = generateSecret(), encrypted = encryptMfaSecret(secret, user._id, key);
  assert.equal(decryptMfaSecret(encrypted, user._id, key), secret);
  assert.ok(!encrypted.includes(secret));
  assert.throws(() => decryptMfaSecret(encrypted, 'another-user', key));
  assert.throws(() => decryptMfaSecret(encrypted, user._id, crypto.randomBytes(32)));
  const parts = encrypted.split('.'); parts[1] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decryptMfaSecret(parts.join('.'), user._id, key));
});

test('production key is required and malformed configuration never falls back', () => {
  assert.throws(() => mfaEncryptionKey('', 'session', 'production'), /required/);
  assert.throws(() => mfaEncryptionKey('bad', 'session', 'development'), /64/);
  assert.equal(mfaEncryptionKey('a'.repeat(64), 'session', 'production').length, 32);
  assert.deepEqual(mfaEncryptionKey('', 'session', 'development'), mfaEncryptionKey('', 'session', 'development'));
});

test('system admins and current association.manage assignments require MFA, residents do not', async () => {
  const f = fixture();
  assert.equal(await f.service.isRequired(user), true);
  assert.equal(f.roleCalls.length, 0);
  assert.equal(await f.service.isRequired({ _id: 'manager' }), true);
  assert.equal(await f.service.isRequired({ _id: 'resident' }), false);
  assert.deepEqual(f.roleCalls[0], { active: true, permissions: 'association.manage' });
  assert.equal(f.roleCalls[1].startsAt.$lte.getTime(), f.now());
  assert.equal(f.roleCalls[1].$or[2].endsAt.$gte.getTime(), f.now());
});

test('enrollment confirms possession, stores hashed recovery codes, and rejects concurrent re-enrollment', async () => {
  const f = fixture(), setup = f.service.newSetup(user);
  await assert.rejects(f.service.confirmSetup(user, setup, 'bad'), /認証コード/);
  assert.equal(f.rows.size, 0);
  const enrolled = await enroll(f);
  assert.equal(enrolled.codes.length, 10);
  const stored = f.rows.get(user._id);
  assert.ok(enrolled.codes.every(code => !JSON.stringify(stored).includes(code)));
  assert.ok(stored.recoveryCodeDigests.includes(recoveryDigest(user._id, enrolled.codes[0])));
  await assert.rejects(f.service.confirmSetup(user, enrolled.setup, enrolled.code), /すでに設定/);
  const state = await f.service.getState(user);
  assert.equal(state.credential.encryptedSecret, undefined);
  assert.equal(state.credential.recoveryCodeDigests, undefined);
  assert.ok(!JSON.stringify(f.events).includes(enrolled.details.secret));
});

test('TOTP is single-use even with concurrent verification and rejects old periods', async () => {
  const f = fixture(), enrollment = await enroll(f);
  await assert.rejects(f.service.prove(user, { code: enrollment.code }), /使用/);
  f.advance();
  const code = await generate({ secret: enrollment.details.secret, epoch: Math.floor(f.now() / 1000) });
  const results = await Promise.allSettled([f.service.prove(user, { code }), f.service.prove(user, { code })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  f.advance(120000);
  await assert.rejects(f.service.prove(user, { code }), /使用/);
});

test('recovery code is atomic and single-use; another account cannot use it', async () => {
  const f = fixture(), { codes } = await enroll(f);
  const results = await Promise.allSettled([f.service.prove(user, { recoveryCode: codes[0] }), f.service.prove(user, { recoveryCode: codes[0] })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await f.service.recoveryCount(user), 9);
  assert.notEqual(recoveryDigest(user._id, codes[0]), recoveryDigest('another-user', codes[0]));
  assert.ok(f.events.some(event => event.action === 'recovery_used'));
});

test('recovery regeneration invalidates all old codes and all other verified sessions', async () => {
  const f = fixture(), { codes, credential } = await enroll(f);
  const req = { user, session: { mfaVerified: { userId: user._id, revision: credential.revision, passwordFingerprint: passwordFingerprint(user), at: f.now() } } };
  assert.equal(mfaVerified(req, await f.service.getState(user), f.now()), true);
  const result = await f.service.regenerateRecovery(user, { recoveryCode: codes[0] });
  assert.notEqual(result.credential.revision, credential.revision);
  assert.equal(mfaVerified(req, await f.service.getState(user), f.now()), false);
  await assert.rejects(f.service.prove(user, { recoveryCode: codes[1] }), /使用/);
  assert.equal((await f.service.prove(user, { recoveryCode: result.codes[0] })).recovered, true);
});

test('authenticator replacement is confirmed before changing the active seed', async () => {
  const f = fixture(), old = await enroll(f);
  const setup = f.service.newSetup(user, old.credential.revision);
  assert.equal((await f.service.getState(user)).credential.revision, old.credential.revision);
  await assert.rejects(f.service.confirmSetup(user, setup, 'bad'));
  const details = await f.service.setupDetails(user, setup);
  const code = await generate({ secret: details.secret, epoch: Math.floor(f.now() / 1000) });
  const replacement = await f.service.confirmSetup(user, setup, code);
  assert.notEqual(replacement.credential.revision, old.credential.revision);
  assert.equal(decryptMfaSecret(f.rows.get(user._id).encryptedSecret, user._id, key), details.secret);
  await assert.rejects(f.service.prove(user, { recoveryCode: old.codes[0] }));
  await assert.rejects(f.service.confirmSetup(user, setup, code), /変更/);
});

test('verification binds user, password state, credential revision, and session expiry', () => {
  const now = Date.now(), state = { required: true, credential: { enabledAt: new Date(), revision: 'revision' } };
  const req = { user, session: { mfaPrimary: { userId: user._id, passwordFingerprint: passwordFingerprint(user), at: now }, mfaVerified: { userId: user._id, passwordFingerprint: passwordFingerprint(user), at: now, revision: 'revision' } } };
  assert.equal(recentPrimaryAuth(req, now), true);
  assert.equal(recentPrimaryAuth(req, now + MFA_PENDING_MS), false);
  assert.equal(mfaVerified(req, state, now), true);
  assert.equal(mfaVerified(req, state, now + MFA_SESSION_MS), false);
  assert.equal(mfaVerified({ ...req, user: { ...user, hash: 'reset-password-hash' } }, state, now), false);
  assert.equal(mfaVerified({ ...req, user: { ...user, _id: 'other' } }, state, now), false);
});

test('gate blocks UI, writes and API routes until setup/verification and permits logout', async () => {
  const state = { required: true, credential: null };
  const check = enforceAdminMfa({ async getState() { return state; } });
  const makeReq = (path, method = 'GET') => ({ user, isAuthenticated: () => true, path, method, originalUrl: path, session: { mfaPrimary: { userId: user._id, passwordFingerprint: passwordFingerprint(user), at: Date.now() } } });
  for (const path of ['/admin', '/associations/a/manage', '/api/associations/a/approve', '/api/auth/me', '/API/AUTH/ME']) {
    const req = makeReq(path, path.includes('approve') ? 'POST' : 'GET'), res = response(); res.locals = {};
    let called = false; await check(req, res, () => { called = true; });
    assert.equal(called, false);
    if (path.toLowerCase().startsWith('/api/')) assert.equal(res.statusCode, 403);
    else assert.equal(res.redirected, '/mfa/setup');
  }
  for (const path of ['/mfa/setup', '/api/auth/mfa/setup', '/logout']) {
    let called = false; const res = response(); res.locals = {};
    await check(makeReq(path), res, () => { called = true; }); assert.equal(called, true);
  }
});

test('existing administrator sessions must re-login; ordinary users pass; DB failures deny access', async () => {
  const req = { user, isAuthenticated: () => true, path: '/admin', originalUrl: '/admin', session: { destroy(done) { this.destroyed = true; done(); } } };
  const res = response(); res.locals = {};
  await enforceAdminMfa({ async getState() { return { required: true }; } })(req, res, () => assert.fail('must block'));
  assert.equal(req.session.destroyed, true); assert.equal(res.redirected, '/login');
  let next = false;
  await enforceAdminMfa({ async getState() { return { required: false }; } })(req, res, () => { next = true; });
  assert.equal(next, true);
  await enforceAdminMfa({ async getState() { throw new Error('DB unavailable'); } })(req, res, error => assert.match(error.message, /DB unavailable/));
});

test('MFA proof endpoints have a shared per-user limit across IPs and UI/API', async () => {
  const check = createAuthRateLimiter({ store: createMemoryRateStore(), secret: 'test', authenticated: true });
  for (let i = 0; i < 11; i++) {
    const path = i % 2 ? '/api/auth/mfa/verify' : '/mfa/setup';
    const req = { method: 'POST', path, originalUrl: path, user, ip: `192.0.2.${i + 1}` };
    assert.equal(authRatePolicy(req), 'mfa');
    const res = response(); let allowed = false;
    await check(req, res, () => { allowed = true; });
    assert.equal(allowed, i < 10);
    if (i === 10) assert.equal(res.statusCode, 429);
  }
});

test('MFA redirect rejects open redirects and CSRF handles multibyte tokens safely', () => {
  for (const value of ['//evil.example', '/\\evil.example', '/\r\nevil', 'https://evil.example']) assert.equal(safeMfaReturnTo(value), '/dashboard');
  assert.equal(safeMfaReturnTo('/associations/a/manage?year=2026'), '/associations/a/manage?year=2026');
  const res = response();
  verifyCsrfToken({ session: { csrfToken: 'aaaa' }, body: { _csrf: 'ああああ' }, get() {} }, res, () => assert.fail('must reject'));
  assert.equal(res.statusCode, 403);
});

// End-to-end HTTP/session tests use isolated repositories and a local server.
// No real account, Atlas connection, mail delivery or deployment is involved.
import http from 'node:http';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import { User } from '../src/models/user.js';
import { ResidentRegistration } from '../src/models/residentRegistration.js';
import { createApp } from '../src/app.js';

async function withMfaApp(task) {
  const f = fixture();
  const admin = { ...user, username: 'test-admin', authenticate(password, callback) {
    const result = { user: password === 'test-password' ? this : false };
    if (callback) callback(null, result.user, null);
    return Promise.resolve(result);
  } };
  const resident = { ...admin, _id: 'resident', username: 'resident', isAdmin: false };
  const manager = { ...admin, _id: 'manager', username: 'manager', isAdmin: false };
  const users = [admin, resident, manager];
  const original = { create: MongoStore.create, findOne: User.findOne, findById: User.findById, registration: ResidentRegistration.findOne };
  MongoStore.create = () => new session.MemoryStore();
  User.findOne = filter => Promise.resolve(users.find(user => user.username === filter.username || user.email === filter.email));
  // Model the plugin's hidden hash: a normal database read omits it, while
  // password authentication returns it. Session reads must select it explicitly.
  User.findById = id => {
    const found = users.find(user => user._id === String(id));
    const hidden = found ? { ...found, hash: undefined } : found;
    return {
      then(resolve, reject) { return Promise.resolve(hidden).then(resolve, reject); },
      select(fields) {
        assert.equal(fields, '+hash');
        return Promise.resolve(found);
      }
    };
  };
  ResidentRegistration.findOne = () => ({ async lean() { return null; } });
  const app = createApp({ mongoUri: 'mongodb://127.0.0.1:27017/unused', sessionSecret: 'mfa-http-test', mfaService: f.service, rateLimitStore: { async increment() { return 1; } } });
  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const client = () => {
      let cookie = '';
      return { get cookie() { return cookie; }, async request(path, { method = 'GET', body, cookieOverride } = {}) {
        const headers = {}; if (cookieOverride ?? cookie) headers.Cookie = cookieOverride ?? cookie;
        if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        const response = await fetch(origin + path, { method, body: body ? new URLSearchParams(body) : undefined, headers, redirect: 'manual' });
        if (cookieOverride === undefined && response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        const text = await response.text();
        return { status: response.status, location: response.headers.get('location'), headers: response.headers, text, json() { return JSON.parse(text); } };
      } };
    };
    await task({ f, admin, resident, manager, client });
  } finally {
    await new Promise(resolve => server.close(resolve));
    MongoStore.create = original.create; User.findOne = original.findOne; User.findById = original.findById; ResidentRegistration.findOne = original.registration;
  }
}

test('HTTP: admin web login enrolls with CSRF, local QR, one-time codes and rotated session', async () => {
  await withMfaApp(async ({ f, client }) => {
    const browser = client();
    const login = await browser.request('/login');
    assert.equal(login.status, 200);
    const csrf = login.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const primary = await browser.request('/login', { method: 'POST', body: { _csrf: csrf, identifier: 'test-admin', password: 'test-password' } });
    assert.equal(primary.status, 302); assert.equal(primary.location, '/mfa/setup');
    const denied = await browser.request('/api/auth/me');
    assert.equal(denied.status, 403); assert.equal(denied.json().error, 'mfa_required');
    assert.equal((await browser.request('/admin')).location, '/mfa/setup');
    const setup = (await browser.request('/api/auth/mfa/setup')).json();
    const html = await browser.request('/mfa/setup');
    assert.equal(html.status, 200); assert.ok(html.text.includes('data:image/png;base64,'));
    assert.ok(!html.text.includes('api.qrserver.com'));
    assert.equal(html.headers.get('cache-control'), 'no-store');
    const badCsrf = await browser.request('/api/auth/mfa/setup', { method: 'POST', body: { code: '000000' } });
    assert.equal(badCsrf.status, 403);
    assert.equal(f.rows.size, 0);
    const wrong = await browser.request('/api/auth/mfa/setup', { method: 'POST', body: { _csrf: setup.csrfToken, code: 'bad' } });
    assert.equal(wrong.status, 400);
    const oldCookie = browser.cookie;
    const code = await generate({ secret: setup.secret, epoch: Math.floor(f.now() / 1000) });
    const finished = await browser.request('/api/auth/mfa/setup', { method: 'POST', body: { _csrf: setup.csrfToken, code } });
    assert.equal(finished.status, 200); assert.equal(finished.json().codes.length, 10);
    assert.notEqual(browser.cookie, oldCookie);
    assert.equal((await browser.request('/api/auth/me', { cookieOverride: oldCookie })).status, 401);
    assert.equal((await browser.request('/api/auth/me')).status, 200);
    const settings = await browser.request('/mfa/settings');
    assert.equal(settings.status, 200); assert.ok(settings.text.includes('認証アプリを変更する'));
    const repeat = (await browser.request('/api/auth/mfa/setup')).json();
    assert.equal(repeat.codes, undefined);
    const continuation = await browser.request('/mfa/continue', { method: 'POST', body: { _csrf: finished.json().csrfToken } });
    assert.equal(continuation.location, '/admin');
  });
});

test('HTTP: API logins challenge both administrator types while ordinary residents are unchanged', async () => {
  await withMfaApp(async ({ client }) => {
    for (const identifier of ['test-admin', 'manager', 'resident']) {
      const browser = client();
      const result = await browser.request('/api/auth/login', { method: 'POST', body: { identifier, password: 'test-password' } });
      if (identifier === 'resident') { assert.equal(result.status, 200); assert.equal(result.json().user.username, 'resident'); continue; }
      assert.equal(result.status, 202); assert.equal(result.json().mfaRequired, true); assert.equal(result.json().user, undefined);
      assert.equal((await browser.request('/api/associations/507f1f77bcf86cd799439011/approve', { method: 'POST' })).status, 403);
      const state = (await browser.request('/api/auth/mfa')).json();
      assert.equal(state.enrolled, false); assert.ok(state.csrfToken);
      const verify = await browser.request('/mfa/verify');
      assert.equal(verify.location, '/mfa/setup');
    }
  });
});

test('HTTP: recovery codes, password confirmation, and revision changes protect existing sessions', async () => {
  await withMfaApp(async ({ f, admin, client }) => {
    const browser = client();
    await browser.request('/api/auth/login', { method: 'POST', body: { identifier: 'test-admin', password: 'test-password' } });
    const setup = (await browser.request('/api/auth/mfa/setup')).json();
    const code = await generate({ secret: setup.secret, epoch: Math.floor(f.now() / 1000) });
    const enrolled = (await browser.request('/api/auth/mfa/setup', { method: 'POST', body: { _csrf: setup.csrfToken, code } })).json();
    const other = client();
    const login = await other.request('/api/auth/login', { method: 'POST', body: { identifier: 'test-admin', password: 'test-password' } });
    assert.equal(login.json().setupRequired, false);
    const verifyHtml = await other.request('/mfa/verify');
    assert.equal(verifyHtml.status, 200); assert.ok(verifyHtml.text.includes('復旧コードで確認'));
    const state = (await other.request('/api/auth/mfa')).json();
    const recovered = await other.request('/api/auth/mfa/verify', { method: 'POST', body: { _csrf: state.csrfToken, recoveryCode: enrolled.codes[0] } });
    assert.equal(recovered.status, 200);
    assert.equal((await other.request('/api/auth/me')).status, 200);
    const failed = await browser.request('/api/auth/mfa/settings/recovery', { method: 'POST', body: { _csrf: enrolled.csrfToken, currentPassword: 'wrong-password', recoveryCode: enrolled.codes[1] } });
    assert.equal(failed.status, 400);
    assert.equal(await f.service.recoveryCount(admin), 9);
    const regenerated = await browser.request('/api/auth/mfa/settings/recovery', { method: 'POST', body: { _csrf: enrolled.csrfToken, currentPassword: 'test-password', recoveryCode: enrolled.codes[1] } });
    assert.equal(regenerated.status, 200); assert.equal(regenerated.json().codes.length, 10);
    assert.equal((await other.request('/api/auth/me')).status, 403);
    assert.equal((await browser.request('/api/auth/me')).status, 200);
    admin.hash = 'password-reset-hash';
    assert.equal((await browser.request('/api/auth/me')).status, 401);
    assert.ok(f.rows.get(admin._id).enabledAt);
  });
});

test('HTTP: browser enrollment renders recovery codes once and continues the original login flow', async () => {
  await withMfaApp(async ({ f, client }) => {
    const browser = client();
    const login = await browser.request('/login');
    const csrf = login.text.match(/name="_csrf" value="([^"]+)"/)[1];
    await browser.request('/login', { method: 'POST', body: { _csrf: csrf, identifier: 'test-admin', password: 'test-password' } });
    const setup = await browser.request('/mfa/setup');
    const secret = setup.text.match(/class="mfa-secret">([A-Z2-7]+)</)[1];
    const setupCsrf = setup.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const code = await generate({ secret, epoch: Math.floor(f.now() / 1000) });
    const confirmation = await browser.request('/mfa/setup', { method: 'POST', body: { _csrf: setupCsrf, code } });
    assert.equal(confirmation.status, 200);
    assert.ok(confirmation.text.includes('今回だけ表示'));
    assert.equal((confirmation.text.match(/[A-F0-9]{8}(?:-[A-F0-9]{8}){3}/g) || []).length, 10);
    assert.equal(confirmation.headers.get('cache-control'), 'no-store');
    const confirmCsrf = confirmation.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const continuation = await browser.request('/mfa/continue', { method: 'POST', body: { _csrf: confirmCsrf } });
    assert.equal(continuation.location, '/login/complete');
    const final = await browser.request('/login/complete');
    assert.equal(final.location, '/dashboard');
  });
});

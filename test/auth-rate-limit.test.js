import test from 'node:test';
import assert from 'node:assert/strict';
import { authRatePolicy, rateLimitIpKey, createAuthRateLimiter, createMemoryRateStore, createMongoRateStore } from '../src/middleware/authRateLimit.js';

const request = (extra = {}) => ({ method: 'POST', path: '/login', originalUrl: '/login', ip: '192.0.2.1', body: {}, ...extra });
const response = () => ({ statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; }, status(code) { this.statusCode = code; return this; }, render(_view, data) { this.data = data; }, json(data) { this.data = data; } });
const limiter = (extra = {}) => createAuthRateLimiter({ store: createMemoryRateStore(), secret: 'test-secret', ...extra });
const attempt = async (middleware, req) => { const res = response(); let next = false; await middleware(req, res, error => { next = error || true; }); return { res, next }; };

test('all login, password reset, verification and invitation routes are limited', () => {
  for (const path of ['/login', '/api/auth/login', '/forgot-password', '/reset-password', '/verification-email/resend', '/register', '/profile/password', '/associations/a/household/h/members/m/invite', '/household-invitations/i/accept']) {
    assert.ok(authRatePolicy(request({ path })), path);
    assert.ok(authRatePolicy(request({ path: path.toUpperCase() + '/' })), path);
  }
  for (const path of ['/reset-password', '/household-invitations', '/verify-email']) assert.ok(authRatePolicy(request({ method: 'GET', path })));
  assert.equal(authRatePolicy(request({ method: 'GET', path: '/login' })), null);
  assert.equal(authRatePolicy(request({ path: '/api/auth/logout' })), null);
});

test('login UI and API share account limits across IPs and casing', async () => {
  const check = limiter();
  for (let i = 0; i < 15; i++) {
    assert.equal((await attempt(check, request({ ip: `192.0.2.${i + 1}`, body: { identifier: ' Member@Example.com ' } }))).next, true);
  }
  const { res, next } = await attempt(check, request({ path: '/api/auth/login', originalUrl: '/api/auth/login', ip: '198.51.100.1', body: { identifier: ['member@example.COM'] } }));
  assert.equal(next, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.data.error, 'too_many_requests');
  assert.ok(Number(res.headers['Retry-After']) > 0);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('IP limits cannot be bypassed by changing accounts and expire with the window', async () => {
  let now = Date.now();
  const check = limiter({ now: () => now });
  for (let i = 0; i < 30; i++) assert.equal((await attempt(check, request({ body: { identifier: `user${i}` } }))).next, true);
  assert.equal((await attempt(check, request({ body: { identifier: 'another' } }))).res.statusCode, 429);
  now += 15 * 60 * 1000;
  assert.equal((await attempt(check, request())).next, true);
});

test('reset email recipient is capped at three per hour and invitation sender at ten', async () => {
  const check = limiter();
  const req = request({ path: '/forgot-password', body: { email: 'member@example.com' } });
  for (let i = 0; i < 3; i++) assert.equal((await attempt(check, req)).next, true);
  assert.equal((await attempt(check, req)).res.statusCode, 429);
  const sender = limiter({ authenticated: true });
  const invite = request({ path: '/associations/a/household/h/members/m/invite', user: { _id: 'sender-id' } });
  for (let i = 0; i < 10; i++) assert.equal((await attempt(sender, { ...invite, ip: `192.0.2.${i + 1}` })).next, true);
  assert.equal((await attempt(sender, invite)).res.statusCode, 429);
});

test('IPv6 address rotation within a subnet and IPv4 mapped notation cannot evade limits', () => {
  assert.equal(rateLimitIpKey('::ffff:192.0.2.1'), rateLimitIpKey('192.0.2.1'));
  assert.equal(rateLimitIpKey('2001:db8:1234:5678::1'), rateLimitIpKey('2001:db8:1234:5678:abcd::2'));
  assert.notEqual(rateLimitIpKey('2001:db8:1234:5678::1'), rateLimitIpKey('2001:db8:1234:5679::1'));
});

test('concurrent increments enforce caps; store failure blocks authentication', async () => {
  const check = limiter();
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => attempt(check, request({ body: { identifier: `user${i}` } }))));
  assert.equal(results.filter(result => result.next === true).length, 30);
  const failed = await attempt(limiter({ store: { async increment() { throw new Error('db down'); } } }), request());
  assert.equal(failed.next.status, 503);
  assert.equal(failed.res.statusCode, 200);
});

test('shared store keys contain no raw account, IP, password or token', async () => {
  const keys = [];
  const check = limiter({ store: { async increment(key) { keys.push(key); return 1; } } });
  await attempt(check, request({ body: { identifier: 'private@example.com', password: 'TOP_SECRET', token: 'SECRET_TOKEN' } }));
  assert.equal(keys.length, 2);
  keys.forEach(key => assert.match(key, /^[a-f0-9]{64}:\d+$/));
});

test('Mongo store uses atomic increment with TTL expiry and retries concurrent first insert', async () => {
  const calls = [];
  const connection = { readyState: 1, collection() { return { async findOneAndUpdate(filter, update, options) {
    calls.push({ filter, update, options });
    if (calls.length === 1) throw Object.assign(new Error('duplicate'), { code: 11000 });
    return { count: 2 };
  } }; } };
  const expiry = new Date();
  assert.equal(await createMongoRateStore(connection).increment('key', expiry), 2);
  assert.deepEqual(calls[0].update, { $inc: { count: 1 }, $setOnInsert: { expiresAt: expiry } });
  assert.equal(calls[0].options.upsert, true);
  assert.equal(calls[0].options.returnDocument, 'after');
  assert.equal(calls[0].options.includeResultMetadata, false);
  assert.equal(calls[1].options.upsert, undefined);
  connection.readyState = 0;
  await assert.rejects(createMongoRateStore(connection).increment('key', expiry));
});

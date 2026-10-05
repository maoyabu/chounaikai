import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import { createApp } from '../src/app.js';
import { securityHeaders, enforceHttps } from '../src/middleware/security.js';

const request = (server, path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, res => {
    let body = '';
    res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject); req.end();
});
const withServer = async (app, task) => {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try { await task(server); } finally { await new Promise(resolve => server.close(resolve)); }
};
const securityApp = (nodeEnv, trustProxy = false) => {
  const app = express(); app.set('trust proxy', trustProxy);
  app.use(securityHeaders(nodeEnv)); app.use(enforceHttps(nodeEnv, 'https://trusted.example'));
  app.use((req, res) => res.json({ ip: req.ip, secure: req.secure }));
  return app;
};

test('production redirects HTTP only to configured HTTPS host and does not replay insecure writes', async () => {
  await withServer(securityApp('production'), async server => {
    const redirect = await request(server, '/login?next=1', { headers: { host: 'attacker.example' } });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.location, 'https://trusted.example/login?next=1');
    assert.equal(redirect.headers['strict-transport-security'], undefined);
    const doubleSlash = await request(server, '//attacker.example/login');
    assert.equal(doubleSlash.headers.location, 'https://trusted.example//attacker.example/login');
    const post = await request(server, '/api/auth/login', { method: 'POST' });
    assert.equal(post.status, 400);
    assert.equal(post.headers.location, undefined);
    const spoof = await request(server, '/login', { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(spoof.status, 308);
  });
});

test('trusted HTTPS proxy gets HSTS, Helmet headers and compatible CSP', async () => {
  await withServer(securityApp('production', 'loopback'), async server => {
    const res = await request(server, '/login', { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.123' } });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ip, '192.0.2.123');
    assert.equal(res.headers['strict-transport-security'], 'max-age=31536000');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['x-powered-by'], undefined);
    const csp = res.headers['content-security-policy'];
    for (const directive of ["object-src 'none'", "form-action 'self'", "frame-ancestors 'self'", 'https://zipcloud.ibsnet.co.jp', 'https://www.youtube.com', 'upgrade-insecure-requests']) assert.ok(csp.includes(directive), directive);
  });
});

test('local development remains usable with HTTP and does not send HSTS or upgrade requests', async () => {
  await withServer(securityApp('development'), async server => {
    const res = await request(server, '/login');
    assert.equal(res.status, 200);
    assert.equal(res.headers['strict-transport-security'], undefined);
    assert.ok(!res.headers['content-security-policy'].includes('upgrade-insecure-requests'));
  });
});

test('actual app limits before sessions and renders UI/API errors without database access', async () => {
  const createStore = MongoStore.create;
  const seen = [];
  MongoStore.create = options => { seen.push(options); return new session.MemoryStore(); };
  try {
    const app = createApp({ mongoUri: 'mongodb://127.0.0.1:27017/finance', sessionSecret: 'test-secret', rateLimitStore: { async increment() { return 100; } } });
    await withServer(app, async server => {
      const ui = await request(server, '/login', { method: 'POST' });
      assert.equal(ui.status, 429);
      assert.ok(ui.body.includes('操作回数の上限'));
      assert.equal(ui.headers['set-cookie'], undefined);
      const api = await request(server, '/api/auth/login', { method: 'POST' });
      assert.equal(api.status, 429);
      assert.equal(JSON.parse(api.body).error, 'too_many_requests');
      const login = await request(server, '/login');
      assert.equal(login.status, 200);
      assert.ok(login.headers['set-cookie'][0].includes('HttpOnly'));
    });
    assert.equal(seen.length, 1);
  } finally { MongoStore.create = createStore; }
});

test('production sessions use verified TLS and the fixed-IP proxy with Secure cookies', async () => {
  const createStore = MongoStore.create;
  const previousHosts = process.env.MONGODB_ALLOWED_HOSTS;
  let storeOptions;
  MongoStore.create = options => { storeOptions = options; return new session.MemoryStore(); };
  process.env.MONGODB_ALLOWED_HOSTS = 'cluster.example.mongodb.net';
  try {
    const app = createApp({
      mongoUri: 'mongodb+srv://app:secret@cluster.example.mongodb.net/finance', sessionSecret: 'test-secret',
      nodeEnv: 'production', publicBaseUrl: 'https://trusted.example', trustProxy: 'loopback',
      mongoOptions: { proxyHost: 'fixed.example', proxyPort: 1080, proxyUsername: 'user', proxyPassword: 'secret' },
      rateLimitStore: { async increment() { return 1; } }
    });
    assert.equal(storeOptions.mongoOptions.tls, true);
    assert.equal(storeOptions.mongoOptions.tlsAllowInvalidCertificates, false);
    assert.equal(storeOptions.mongoOptions.tlsAllowInvalidHostnames, false);
    assert.equal(storeOptions.mongoOptions.proxyHost, 'fixed.example');
    await withServer(app, async server => {
      const login = await request(server, '/login', { headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(login.status, 200);
      const cookie = login.headers['set-cookie'][0];
      for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(cookie.includes(attribute));
      assert.equal(login.headers['strict-transport-security'], 'max-age=31536000');
    });
  } finally {
    MongoStore.create = createStore;
    if (previousHosts === undefined) delete process.env.MONGODB_ALLOWED_HOSTS;
    else process.env.MONGODB_ALLOWED_HOSTS = previousHosts;
  }
});

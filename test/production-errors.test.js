import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import { createApp } from '../src/app.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { User } from '../src/models/user.js';
import { productionErrorResponses, applicationErrorHandler, errorStatus } from '../src/middleware/errorResponses.js';

const privateDetail = 'PRIVATE_DETAIL mongodb://db-user:secret-password@internal.example/private_db /srv/app/private.js API_KEY=secret-key';
const assertPrivate = text => {
  for (const value of ['PRIVATE_DETAIL', 'db-user', 'secret-password', 'internal.example', 'private_db', '/srv/app/private.js', 'API_KEY', 'secret-key', 'Error: boom', 'SyntaxError:', 'ReferenceError:', ' at ']) assert.ok(!text.includes(value), value);
};
async function withServer(app, task) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    await task(async (route, options = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { ...options, redirect: 'manual' });
      return { status: response.status, headers: response.headers, text: await response.text() };
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
}
function errorApp(nodeEnv = 'production', configure = () => {}) {
  const app = express(); app.set('env', nodeEnv);
  app.use(productionErrorResponses(nodeEnv)); configure(app);
  app.use(applicationErrorHandler(nodeEnv)); return app;
}
async function captureErrors(task) {
  const original = console.error, errors = []; console.error = (...args) => errors.push(args);
  try { await task(errors); } finally { console.error = original; }
}

test('error status accepts HTTP errors and handles network/duplicate errors without invalid statuses', () => {
  assert.equal(errorStatus({ name: 'MongoServerSelectionError' }), 503);
  assert.equal(errorStatus({ code: 11000 }), 409);
  assert.equal(errorStatus({ statusCode: 413 }), 413);
  for (const status of [200, 399, 600, -1, 400.5, Infinity, 'broken']) assert.equal(errorStatus({ status }), 500);
});

test('production central errors never disclose exception details in HTML, API or AJAX responses', async () => {
  await captureErrors(async logs => {
    const app = errorApp('production', app => {
      app.get('/:mode/:status', (req, res, next) => { const error = new Error(privateDetail); error.status = Number(req.params.status); next(error); });
      app.get('/api/fail/:status', (req, res, next) => next(Object.assign(new Error(privateDetail), { status: Number(req.params.status) })));
    });
    await withServer(app, async request => {
      for (const status of [400, 401, 403, 404, 409, 413, 429, 500, 502, 503]) {
        for (const route of [`/ui/${status}`, `/api/fail/${status}`]) {
          const response = await request(route); assert.equal(response.status, status); assertPrivate(response.text);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          if (route.startsWith('/api')) assert.ok(JSON.parse(response.text).error);
        }
      }
      const ajax = await request('/ui/503', { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      assert.equal(JSON.parse(ajax.text).error, 'service_unavailable'); assertPrivate(ajax.text);
    });
    assert.ok(logs.some(args => args[0].message === privateDetail));
  });
});

test('production direct JSON and text errors remove details and only keep approved public navigation', async () => {
  const app = errorApp('production', app => {
    app.get('/api/direct', (req, res) => res.status(400).json({ error: privateDetail, details: { password: privateDetail }, stack: privateDetail, message: privateDetail, next: privateDetail }));
    app.get('/text', (req, res) => res.status(409).send(privateDetail));
    app.get('/api/challenge', (req, res) => res.status(403).json({ error: 'mfa_required', setupRequired: true, next: privateDetail, details: privateDetail }));
    app.get('/api/server', (req, res) => res.status(503).json({ error: 'web_push_not_configured', message: privateDetail }));
    app.get('/api/wrong-status', (req, res) => res.json({ error: privateDetail }));
  });
  await withServer(app, async request => {
    for (const route of ['/api/direct', '/text', '/api/challenge', '/api/server', '/api/wrong-status']) { const response = await request(route); assertPrivate(response.text); }
    assert.equal((await request('/api/wrong-status')).status, 500);
    const challenge = JSON.parse((await request('/api/challenge')).text);
    assert.equal(challenge.error, 'mfa_required'); assert.equal(challenge.next, '/mfa/setup'); assert.equal(challenge.details, undefined);
    assert.equal(JSON.parse((await request('/api/server')).text).error, 'service_unavailable');
  });
});

test('production direct error pages use a template-independent fallback and forms sanitize error feedback', async () => {
  let templateCalls = 0;
  const app = errorApp('production', app => {
    app.set('views', '/unused'); app.set('view engine', 'test');
    app.engine('test', (_path, values, callback) => {
      templateCalls++;
      callback(null, `<form><p>${values.formError || values.errorMessage || values.message || values._locals.errorMessage}</p><input value="${values.values?.name || ''}"></form>`);
    });
    // Express checks the filename before calling the registered engine.
    app.render = (_view, values, callback) => {
      templateCalls++; callback(null, `<form>${values.formError || values.errorMessage || values.message || values._locals.errorMessage}<input value="${values.values?.name || ''}"></form>`);
    };
    app.get('/error', (req, res) => res.status(503).render('error', { title: privateDetail, message: privateDetail, stack: privateDetail }));
    app.get('/form', (req, res) => { res.locals.errorMessage = privateDetail; res.status(400).render('profile', { formError: privateDetail, values: { name: '入力した名前' }, error: privateDetail }); });
    app.get('/flash', (req, res) => { res.locals.errorMessage = privateDetail; res.render('login'); });
  });
  await withServer(app, async request => {
    assertPrivate((await request('/error')).text); assert.equal(templateCalls, 0);
    const form = await request('/form'); assertPrivate(form.text); assert.ok(form.text.includes('入力した名前')); assert.ok(form.text.includes('<form>'));
    assertPrivate((await request('/flash')).text);
  });
});

test('a rendering failure never escapes to Express default stack-trace rendering', async () => {
  await captureErrors(async () => {
    for (const nodeEnv of ['production', 'development']) {
      const app = errorApp(nodeEnv, app => {
        app.render = (_view, _values, callback) => callback(new Error(privateDetail));
        app.get('/broken', (req, res) => res.render('profile', { formError: null }));
      });
      await withServer(app, async request => { const response = await request('/broken'); assert.equal(response.status, 500); assertPrivate(response.text); });
    }
  });
});

test('development retains intentional validation messages while server errors stay generic', async () => {
  const app = errorApp('development', app => {
    app.get('/api/invalid', (req, res, next) => next(Object.assign(new Error('入力の確認用メッセージ'), { status: 400 })));
  });
  await withServer(app, async request => { assert.equal(JSON.parse((await request('/api/invalid')).text).error, '入力の確認用メッセージ'); });
});

test('errors after streaming starts close the connection without appending exception details', async () => {
  await captureErrors(async () => {
    let destroyed = false;
    applicationErrorHandler('production')(new Error(privateDetail), { socket: { destroy() { destroyed = true; } } }, { headersSent: true, status() { assert.fail('must not write another response'); } });
    assert.equal(destroyed, true);
  });
});

test('actual production app sanitizes parser, limiter, duplicate, unavailable and unknown-path failures', async () => {
  const originalStore = MongoStore.create, hosts = process.env.MONGODB_ALLOWED_HOSTS;
  const originalFind = NeighborhoodAssociation.find, originalUser = User.findOne;
  MongoStore.create = () => new session.MemoryStore(); process.env.MONGODB_ALLOWED_HOSTS = 'cluster.example.mongodb.net';
  let failure = new Error(privateDetail);
  NeighborhoodAssociation.find = () => { throw failure; }; User.findOne = () => { throw failure; };
  try {
    const app = createApp({ mongoUri: 'mongodb+srv://app:secret@cluster.example.mongodb.net/test', sessionSecret: 'test-secret', nodeEnv: 'production', mfaKey: 'a'.repeat(64), publicBaseUrl: 'https://trusted.example', trustProxy: 'loopback', rateLimitStore: { async increment() { return 1; } } });
    assert.equal(app.get('env'), 'production');
    await captureErrors(async () => withServer(app, async request => {
      const headers = { 'X-Forwarded-Proto': 'https' };
      for (const [error, status] of [[new Error(privateDetail), 500], [Object.assign(new Error(privateDetail), { code: 11000 }), 409], [Object.assign(new Error(privateDetail), { name: 'MongoServerSelectionError' }), 503]]) {
        failure = error;
        const ui = await request('/associations', { headers }); assert.equal(ui.status, status); assertPrivate(ui.text);
        const api = await request('/api/auth/login', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'tester', password: 'test-password' }) }); assert.equal(api.status, status); assertPrivate(api.text);
      }
      for (const route of ['/login', '/api/auth/login']) {
        const response = await request(route, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: `{"password":"${privateDetail}"` });
        assert.equal(response.status, 400); assertPrivate(response.text);
      }
      const tooLarge = await request('/api/auth/login', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(1024 * 1024 + 100) }) });
      assert.equal(tooLarge.status, 413); assertPrivate(tooLarge.text);
      const missing = await request('/PRIVATE_DETAIL?key=secret-key', { headers }); assert.equal(missing.status, 404); assertPrivate(missing.text);
    }));
  } finally { MongoStore.create = originalStore; NeighborhoodAssociation.find = originalFind; User.findOne = originalUser; if (hosts === undefined) delete process.env.MONGODB_ALLOWED_HOSTS; else process.env.MONGODB_ALLOWED_HOSTS = hosts; }
});

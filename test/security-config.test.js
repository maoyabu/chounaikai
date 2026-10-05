import test from 'node:test';
import assert from 'node:assert/strict';
import { mongoProxyOptions, mongoSecurityOptions, parseTrustProxy, publicHttpsOrigin } from '../src/config/security.js';
import { loadConfig } from '../src/config/env.js';

const allowedHosts = 'cluster.example.mongodb.net';
const srvUri = 'mongodb+srv://app:secret@cluster.example.mongodb.net/finance';
const productionOptions = uri => mongoSecurityOptions(uri, 'production', { allowedHosts });

test('production requires authenticated TLS MongoDB on an explicitly allowed host', () => {
  assert.equal(productionOptions(srvUri).tls, true);
  assert.throws(() => productionOptions('mongodb+srv://cluster.example.mongodb.net/finance'), /authenticated/);
  assert.throws(() => productionOptions('mongodb://app:secret@cluster.example.mongodb.net/finance'), /TLS/);
  for (const option of ['tls=false', 'tlsInsecure=true', 'tlsAllowInvalidCertificates=true', 'tlsAllowInvalidHostnames=true']) {
    assert.throws(() => productionOptions(`${srvUri}?${option}`), /TLS/);
  }
  assert.throws(() => productionOptions('mongodb+srv://app:secret@other.mongodb.net/finance'), /explicitly listed/);
  assert.throws(() => mongoSecurityOptions(srvUri, 'production'), /explicitly listed/);
  assert.equal(productionOptions('mongodb://app:secret@cluster.example.mongodb.net/finance?tls=true').tls, true);
});

test('replica set checks every hostname and secrets never appear in validation errors', () => {
  const uri = 'mongodb://app:TOP_SECRET@host1.example,host2.example/finance?tls=true';
  assert.throws(() => mongoSecurityOptions(uri, 'production', { allowedHosts: 'host1.example' }), /explicitly listed/);
  assert.equal(mongoSecurityOptions(uri, 'production', { allowedHosts: 'host1.example,host2.example' }).tls, true);
  try { productionOptions('mongodb://app:TOP_SECRET@invalid:abc/finance'); }
  catch (error) { assert.ok(!error.message.includes('TOP_SECRET')); }
  assert.deepEqual(mongoSecurityOptions('mongodb://127.0.0.1:27017/finance', 'development'), {});
});

test('HTTPS destination and proxy trust cannot accept arbitrary origins or blanket trust', () => {
  assert.equal(publicHttpsOrigin('https://example.com/'), 'https://example.com');
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com?x=1', 'invalid']) {
    assert.throws(() => publicHttpsOrigin(url));
  }
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('1'), 1);
  assert.deepEqual(parseTrustProxy('loopback,10.0.0.0/8'), ['loopback', '10.0.0.0/8']);
  assert.throws(() => parseTrustProxy('true'));
});

test('production environment configuration fails closed before connecting', () => {
  const keys = ['NODE_ENV', 'MONGODB_URI', 'MONGODB_ALLOWED_HOSTS', 'PUBLIC_BASE_URL', 'CHOUNAIKAI_SESSION_SECRET', 'TRUST_PROXY', 'MONGODB_TLS_CA_FILE', 'MONGODB_SOCKS_PROXY_URL', 'FIXIE_SOCKS_HOST', 'MFA_ENCRYPTION_KEY'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { NODE_ENV: 'production', MONGODB_URI: srvUri, MONGODB_ALLOWED_HOSTS: allowedHosts, PUBLIC_BASE_URL: 'https://example.com', CHOUNAIKAI_SESSION_SECRET: 'test-session-secret', TRUST_PROXY: '1', MFA_ENCRYPTION_KEY: 'a'.repeat(64) });
    delete process.env.MONGODB_TLS_CA_FILE;
    delete process.env.MONGODB_SOCKS_PROXY_URL;
    delete process.env.FIXIE_SOCKS_HOST;
    const config = loadConfig();
    assert.equal(config.trustProxy, 1);
    assert.equal(config.mongoOptions.tls, true);
    process.env.PUBLIC_BASE_URL = 'http://example.com';
    assert.throws(loadConfig, /HTTPS/);
  } finally {
    keys.forEach(key => saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key]);
  }
});


test('fixed-IP proxy credentials are parsed safely and invalid proxies fail closed', () => {
  assert.deepEqual(mongoProxyOptions(''), {});
  assert.deepEqual(mongoProxyOptions('user:p%40ss@proxy.example:1080'), {
    proxyHost: 'proxy.example', proxyPort: 1080, proxyUsername: 'user', proxyPassword: 'p@ss'
  });
  assert.equal(mongoProxyOptions('socks5://user:pass@[::1]:1080').proxyHost, '::1');
  for (const value of ['http://user:SECRET@proxy.example', 'user:SECRET@proxy.example:0', 'socks5://proxy.example', 'user:SECRET@proxy.example:1080/path', 'user:SECRET@proxy.example?x=1']) {
    assert.throws(() => mongoProxyOptions(value), error => !error.message.includes('SECRET'));
  }
});

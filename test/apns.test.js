import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { ApnsSubscription } from '../src/models/apnsSubscription.js';
import { apnsPayload, providerToken, validateApnsRegistration, sendNativePush, hasLiveApnsSession, revokeApnsSession, apnsSessionKey } from '../src/services/apnsService.js';

function configure(t) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  for (const [key, value] of Object.entries({ APNS_KEY_ID: 'TESTKEY123', APNS_TEAM_ID: 'TESTTEAM12', APNS_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), PUBLIC_BASE_URL: 'https://example.test' })) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  return publicKey;
}
const notice = { _id: 'notice', association: 'association', recipient: 'user', type: 'danger_report', title: '危険情報', body: '確認してください' };
const home = { associations: [{ association: { id: 'association' }, roles: [{ kind: 'officer' }] }] };

test('APNs tokens validate variable lengths, environments and server-controlled topic', () => {
  for (const length of [32, 64, 128]) assert.equal(validateApnsRegistration({ token: 'A'.repeat(length), environment: 'production', topic: 'forged' }).token, 'a'.repeat(length));
  for (const body of [{}, { token: 'z'.repeat(64), environment: 'production' }, { token: 'a'.repeat(33), environment: 'development' }, { token: 'a'.repeat(64), environment: 'forged' }]) assert.throws(() => validateApnsRegistration(body), { status: 400 });
  assert.notEqual(validateApnsRegistration({ token: 'a'.repeat(64), environment: 'production', topic: 'forged' }).topic, 'forged');
});

test('APNs authentication uses ES256 P1363 signatures and caches tokens', t => {
  const key = configure(t), now = Date.now();
  const jwt = providerToken(now), [header, claims, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'ES256');
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, 'TESTTEAM12');
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
  assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  assert.equal(providerToken(now + 10000), jwt);
  assert.notEqual(providerToken(now + 51 * 60000), jwt);
});

test('payload remains under 4KB for emoji text and carries account/destination', t => {
  configure(t);
  const payload = apnsPayload({ ...notice, title: '🚨'.repeat(200), body: '😀'.repeat(3000) });
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 4096);
  assert.equal(payload.notificationId, 'notice');
  assert.equal(payload.recipientId, 'user');
  assert.equal(payload.server, 'https://example.test');
  assert.equal(payload.aps.sound, 'default');
});

test('delivery isolates device failures, disables invalid tokens and skips expired sessions', async t => {
  configure(t);
  const devices = ['failed', 'invalid', 'valid', 'expired'].map(_id => ({ _id, user: 'user', updatedAt: new Date() }));
  t.mock.method(ApnsSubscription, 'find', filter => {
    assert.equal(filter.user, 'user');
    assert.equal(filter.disabledAt, null);
    assert.ok(filter.expiresAt.$gt instanceof Date);
    return { select: async () => devices };
  });
  const disabled = [];
  t.mock.method(ApnsSubscription, 'updateOne', async filter => disabled.push(filter._id));
  const calls = [];
  const result = await sendNativePush({ notification: notice, recipient: { _id: 'user' } }, async device => {
    calls.push(device._id);
    if (device._id === 'failed') throw new Error('offline');
    return device._id === 'invalid' ? { status: 410, reason: 'Unregistered' } : { status: 200 };
  }, { loadHome: async () => home, hasLiveSession: async device => device._id !== 'expired' });
  assert.equal(result.status, 'sent');
  assert.equal(result.error, '1 APNs delivery failure(s)');
  assert.deepEqual(calls, ['failed', 'invalid', 'valid']);
  assert.deepEqual(disabled, ['invalid']);
});

test('chat, unrelated associations and unauthorized action requests are not sent', async t => {
  configure(t);
  const send = async () => assert.fail('must not send');
  for (const notification of [{ ...notice, type: 'group_message' }, { ...notice, association: 'other' }, { ...notice, type: 'join_application_received', priority: 'action' }]) {
    const result = await sendNativePush({ notification, recipient: { _id: 'user' } }, send, { loadHome: async () => ({ associations: [{ association: { id: 'association' }, roles: [] }] }) });
    assert.equal(result.status, 'skipped');
  }
});

test('logout revokes only its session and expired or different-account sessions fail closed', async t => {
  let stored = { session: JSON.stringify({ passport: { user: 'user' } }) };
  t.mock.method(mongoose.connection, 'collection', name => {
    assert.equal(name, 'chounaikai_sessions');
    return { findOne: async filter => { assert.equal(filter._id, 'session'); assert.ok(filter.expires.$gt instanceof Date); return stored; } };
  });
  const subscription = { sessionId: 'session', user: 'user' };
  assert.equal(await hasLiveApnsSession(subscription), true);
  stored = { session: JSON.stringify({ passport: { user: 'someone-else' } }) };
  assert.equal(await hasLiveApnsSession(subscription), false);
  stored = null;
  assert.equal(await hasLiveApnsSession(subscription), false);
  t.mock.method(ApnsSubscription, 'deleteMany', async filter => { assert.deepEqual(filter, { sessionKey: apnsSessionKey('session') }); });
  await revokeApnsSession('session');
});

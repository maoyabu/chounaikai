import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AndroidFcmSubscription } from '../src/models/androidFcmSubscription.js';
import {
  androidFcmMessage, androidFcmPackage, androidFcmSessionKey, fcmAccessToken, hasLiveAndroidFcmSession, resetFcmAccessTokenCache,
  revokeAndroidFcmSession, sendAndroidFcmRequest, sendAndroidNativePush, serviceAccountAssertion, validateAndroidFcmRegistration
} from '../src/services/androidFcmService.js';

function configure(t) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const values = {
    FCM_PROJECT_ID: 'test-project', FCM_CLIENT_EMAIL: 'sender@test-project.iam.gserviceaccount.com',
    FCM_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), PUBLIC_BASE_URL: 'https://example.test/app'
  };
  for (const [key, value] of Object.entries(values)) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  resetFcmAccessTokenCache();
  t.after(resetFcmAccessTokenCache);
  return publicKey;
}
const token = 'f'.repeat(30) + ':' + 'A'.repeat(100) + '-_';
const notice = { _id: 'notice', association: 'association', recipient: 'user', type: 'danger_report', title: '危険情報', body: '確認してください' };
const home = { associations: [{ association: { id: 'association' }, roles: [{ kind: 'officer' }] }] };

test('FCM tokens are validated and the package name is chosen by the server', () => {
  assert.deepEqual(validateAndroidFcmRegistration({ token, packageName: 'forged.package' }), { token, packageName: androidFcmPackage() });
  assert.notEqual(validateAndroidFcmRegistration({ token, packageName: 'forged.package' }).packageName, 'forged.package');
  for (const body of [undefined, {}, { token: '' }, { token: 'short' }, { token: `${token} extra` }, { token: `${token}/../x` }, { token: 'a'.repeat(5000) }]) {
    assert.throws(() => validateAndroidFcmRegistration(body), error => error.status === 400);
  }
});

test('service account assertion is an RS256 JWT for the Firebase messaging scope', t => {
  const key = configure(t), now = Date.now();
  const [header, claims, signature] = serviceAccountAssertion(now).split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
  const payload = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(payload.iss, process.env.FCM_CLIENT_EMAIL);
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(payload.exp - payload.iat, 3600);
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), key, Buffer.from(signature, 'base64url')));
});

test('access tokens are cached until shortly before they expire', async t => {
  configure(t);
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(new URLSearchParams(options.body).get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    return { ok: true, json: async () => ({ access_token: `token-${calls}`, expires_in: 3600 }) };
  };
  const now = Date.now();
  assert.equal(await fcmAccessToken({ now, fetchImpl }), 'token-1');
  assert.equal(await fcmAccessToken({ now: now + 50 * 60000, fetchImpl }), 'token-1');
  assert.equal(await fcmAccessToken({ now: now + 56 * 60000, fetchImpl }), 'token-2');
  resetFcmAccessTokenCache();
  await assert.rejects(fcmAccessToken({ fetchImpl: async () => ({ ok: false }) }), /fcm_auth_failed/);
});

test('message carries the same destination keys as iOS, stays small and targets one device', t => {
  configure(t);
  const { message } = androidFcmMessage({ ...notice, title: '🚨'.repeat(200), body: '😀'.repeat(3000) }, token);
  assert.ok(Buffer.byteLength(JSON.stringify({ message })) < 4096);
  assert.equal(message.token, token);
  assert.deepEqual(message.data, { notificationId: 'notice', recipientId: 'user', server: 'https://example.test' });
  assert.ok(Object.values(message.data).every(value => typeof value === 'string'));
  assert.equal([...message.notification.title].length, 80);
  assert.equal(message.android.priority, 'HIGH');
  assert.equal(message.android.notification.channel_id, 'notifications');
  assert.equal(message.android.collapse_key, 'notice');
});

test('FCM request authenticates with the access token and reports error reasons', async t => {
  configure(t);
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'abc', expires_in: 3600 }) };
    return requests.filter(request => !request.url.includes('oauth2')).length === 1
      ? { ok: true, status: 200 }
      : { ok: false, status: 404, json: async () => ({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }) };
  };
  const message = androidFcmMessage(notice, token);
  assert.deepEqual(await sendAndroidFcmRequest({ token }, message, { fetchImpl }), { status: 200 });
  assert.deepEqual(await sendAndroidFcmRequest({ token }, message, { fetchImpl }), { status: 404, reason: 'UNREGISTERED' });
  const send = requests.find(request => request.url.includes('fcm.googleapis.com'));
  assert.equal(send.url, 'https://fcm.googleapis.com/v1/projects/test-project/messages:send');
  assert.equal(send.options.headers.authorization, 'Bearer abc');
  assert.equal(JSON.parse(send.options.body).message.token, token);
});

test('delivery isolates device failures, disables dead tokens and skips expired sessions', async t => {
  configure(t);
  const devices = ['failed', 'gone', 'mismatch', 'bad-payload', 'valid', 'expired'].map(_id => ({ _id, token: `${_id}-token`, user: 'user', updatedAt: new Date() }));
  t.mock.method(AndroidFcmSubscription, 'find', filter => {
    assert.equal(filter.user, 'user');
    assert.equal(filter.packageName, androidFcmPackage());
    assert.equal(filter.disabledAt, null);
    assert.ok(filter.expiresAt.$gt instanceof Date);
    return { select: async () => devices };
  });
  const disabled = [];
  t.mock.method(AndroidFcmSubscription, 'updateOne', async filter => disabled.push(filter._id));
  const calls = [];
  const result = await sendAndroidNativePush({ notification: notice, recipient: { _id: 'user' } }, async (device, body) => {
    calls.push(device._id);
    assert.equal(body.message.token, device.token);
    if (device._id === 'failed') throw new Error('offline');
    if (device._id === 'gone') return { status: 404, reason: 'UNREGISTERED' };
    if (device._id === 'mismatch') return { status: 403, reason: 'SENDER_ID_MISMATCH' };
    if (device._id === 'bad-payload') return { status: 400, reason: 'INVALID_ARGUMENT' };
    return { status: 200 };
  }, { loadHome: async () => home, hasLiveSession: async device => device._id !== 'expired' });
  assert.equal(result.status, 'sent');
  assert.equal(result.error, '2 Android FCM delivery failure(s)');
  assert.deepEqual(calls, ['failed', 'gone', 'mismatch', 'bad-payload', 'valid']);
  assert.deepEqual(disabled, ['gone', 'mismatch']);
});

test('nothing is sent when FCM is not configured', async t => {
  configure(t);
  delete process.env.FCM_PRIVATE_KEY;
  const result = await sendAndroidNativePush({ notification: notice, recipient: { _id: 'user' } }, async () => assert.fail('must not send'), { loadHome: async () => assert.fail('must not load') });
  assert.equal(result.status, 'skipped');
});

test('chat, unrelated associations and unauthorized action requests are not sent', async t => {
  configure(t);
  const send = async () => assert.fail('must not send');
  for (const notification of [{ ...notice, type: 'group_message' }, { ...notice, association: 'other' }, { ...notice, type: 'join_application_received', priority: 'action' }]) {
    const result = await sendAndroidNativePush({ notification, recipient: { _id: 'user' } }, send, { loadHome: async () => ({ associations: [{ association: { id: 'association' }, roles: [] }] }) });
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
  assert.equal(await hasLiveAndroidFcmSession(subscription), true);
  stored = { session: JSON.stringify({ passport: { user: 'someone-else' } }) };
  assert.equal(await hasLiveAndroidFcmSession(subscription), false);
  stored = null;
  assert.equal(await hasLiveAndroidFcmSession(subscription), false);
  t.mock.method(AndroidFcmSubscription, 'deleteMany', async filter => { assert.deepEqual(filter, { sessionKey: androidFcmSessionKey('session') }); });
  await revokeAndroidFcmSession('session');
});

import crypto from 'node:crypto';
import http2 from 'node:http2';
import mongoose from 'mongoose';
import { ApnsSubscription } from '../models/apnsSubscription.js';
import { loadMobileHome } from './mobileHomeService.js';
import { notificationPriority } from './notificationInboxService.js';

export const apnsTopic = () => process.env.APNS_TOPIC || 'com.MasayukiOyabu.machinodengonban';
export const apnsConfigured = () => Boolean(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_PRIVATE_KEY && process.env.PUBLIC_BASE_URL);
export const apnsSessionKey = id => crypto.createHash('sha256').update(id).digest('hex');
export const revokeApnsSession = sessionId => ApnsSubscription.deleteMany({ sessionKey: apnsSessionKey(sessionId) });

export function validateApnsRegistration(body) {
  const token = String(body.token || '').toLowerCase();
  if (!/^[a-f0-9]{32,512}$/.test(token) || token.length % 2 || !['development', 'production'].includes(body.environment)) {
    throw Object.assign(new Error('invalid_device_registration'), { status: 400 });
  }
  return { token, environment: body.environment, topic: apnsTopic() };
}

let cachedToken;
let cachedAt = 0;
export function providerToken(now = Date.now()) {
  if (cachedToken && now - cachedAt < 50 * 60 * 1000) return cachedToken;
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'ES256', kid: process.env.APNS_KEY_ID })}.${encode({ iss: process.env.APNS_TEAM_ID, iat: Math.floor(now / 1000) })}`;
  const key = crypto.createPrivateKey(process.env.APNS_PRIVATE_KEY.replace(/\\n/g, '\n'));
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  cachedToken = `${unsigned}.${signature.toString('base64url')}`;
  cachedAt = now;
  return cachedToken;
}

const chatTypes = new Set(['officer_network', 'officer_network_reminder', 'district_message', 'district_message_reminder', 'group_message', 'group_message_reminder']);
export const isMobilePushType = notification => !chatTypes.has(notification.type);
export function apnsPayload(notification) {
  // Keep the payload below APNs' 4KB limit even with multi-byte titles.
  return {
    aps: { alert: { title: [...notification.title].slice(0, 80).join(''), body: [...notification.body].slice(0, 300).join('') }, sound: 'default' },
    notificationId: String(notification._id), recipientId: String(notification.recipient),
    server: new URL(process.env.PUBLIC_BASE_URL).origin
  };
}

export function sendApnsRequest(subscription, payload) {
  return new Promise((resolve, reject) => {
    const host = subscription.environment === 'development' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    const authorization = providerToken();
    const connection = http2.connect(host);
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      connection.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('apns_timeout')), 10000);
    connection.on('error', () => finish(new Error('apns_connection_failed')));
    const request = connection.request({
      ':method': 'POST', ':path': `/3/device/${subscription.token}`,
      authorization: `bearer ${authorization}`, 'apns-topic': subscription.topic,
      'apns-push-type': 'alert', 'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
      'apns-collapse-id': payload.notificationId
    });
    let status, body = '';
    request.on('response', headers => { status = headers[':status']; });
    request.setEncoding('utf8');
    request.on('data', chunk => { if (body.length < 4096) body += chunk; });
    request.on('error', () => finish(new Error('apns_request_failed')));
    request.on('end', () => {
      let reason;
      try { reason = JSON.parse(body).reason; } catch { /* Success has no JSON body. */ }
      finish(null, { status, reason });
    });
    request.end(JSON.stringify(payload));
  });
}

export async function hasLiveApnsSession(subscription) {
  // Also covers Web logout/session expiry and an in-flight registration racing logout.
  const stored = await mongoose.connection.collection('chounaikai_sessions').findOne({ _id: subscription.sessionId, expires: { $gt: new Date() } });
  if (!stored) return false;
  try {
    const session = typeof stored.session === 'string' ? JSON.parse(stored.session) : stored.session;
    return String(session?.passport?.user) === String(subscription.user);
  } catch { return false; }
}

export async function sendNativePush({ notification, recipient }, send = sendApnsRequest, dependencies = {}) {
  if (!apnsConfigured() || !process.env.PUBLIC_BASE_URL || !isMobilePushType(notification)) return { status: 'skipped' };
  const home = await (dependencies.loadHome || loadMobileHome)({ userId: recipient._id });
  const association = home.associations.find(item => String(item.association.id) === String(notification.association?._id || notification.association));
  if (!association || (notificationPriority(notification) === 'action' && !association.roles.some(role => ['management', 'officer', 'district_leader'].includes(role.kind)))) return { status: 'skipped' };
  const subscriptions = await ApnsSubscription.find({ user: recipient._id, topic: apnsTopic(), disabledAt: null, expiresAt: { $gt: new Date() } }).select('+sessionId');
  let sent = 0, failed = 0;
  for (const subscription of subscriptions) {
    try {
      if (!await (dependencies.hasLiveSession || hasLiveApnsSession)(subscription)) continue;
      const result = await send(subscription, apnsPayload(notification));
      if (result.status === 200) sent++;
      else if (result.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'ExpiredToken', 'Unregistered'].includes(result.reason)) {
        await ApnsSubscription.updateOne({ _id: subscription._id, updatedAt: subscription.updatedAt }, { $set: { disabledAt: new Date() } });
      } else failed++;
    } catch { failed++; }
  }
  return { status: sent ? 'sent' : failed ? 'failed' : 'skipped', ...(sent ? { sentAt: new Date() } : {}), ...(failed ? { error: `${failed} APNs delivery failure(s)` } : {}) };
}

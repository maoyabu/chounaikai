import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AndroidFcmSubscription } from '../models/androidFcmSubscription.js';
import { loadMobileHome } from './mobileHomeService.js';
import { notificationPriority } from './notificationInboxService.js';
import { isMobilePushType, hasLiveApnsSession } from './apnsService.js';

// Android push delivery through Firebase Cloud Messaging (HTTP v1).
// Kept separate from apnsService.js so the iOS (APNs) delivery is unchanged.

export const androidFcmPackage = () => process.env.FCM_ANDROID_PACKAGE || 'com.masayukioyabu.machinodengonban';
export const androidFcmConfigured = () => Boolean(process.env.FCM_PROJECT_ID && process.env.FCM_CLIENT_EMAIL && process.env.FCM_PRIVATE_KEY && process.env.PUBLIC_BASE_URL);
export const androidFcmSessionKey = id => crypto.createHash('sha256').update(id).digest('hex');
export const revokeAndroidFcmSession = sessionId => AndroidFcmSubscription.deleteMany({ sessionKey: androidFcmSessionKey(sessionId) });

export const ANDROID_NOTIFICATION_CHANNEL = 'notifications';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function validateAndroidFcmRegistration(body) {
  const token = String(body?.token || '').trim();
  // FCM registration tokens are URL-safe strings; reject anything else before storing.
  if (!/^[A-Za-z0-9_:-]{40,4096}$/.test(token)) {
    throw Object.assign(new Error('invalid_device_registration'), { status: 400 });
  }
  // The package name is decided by the server, never by the client.
  return { token, packageName: androidFcmPackage() };
}

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

// Signed JWT used to obtain an OAuth2 access token for the Firebase service account.
export function serviceAccountAssertion(now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: process.env.FCM_CLIENT_EMAIL, scope: FCM_SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
  const key = crypto.createPrivateKey(process.env.FCM_PRIVATE_KEY.replace(/\\n/g, '\n'));
  return `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
}

let cachedAccessToken;
let cachedUntil = 0;
export async function fcmAccessToken({ now = Date.now(), fetchImpl = fetch } = {}) {
  if (cachedAccessToken && now < cachedUntil) return cachedAccessToken;
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(now) }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('fcm_auth_failed');
  const { access_token: token, expires_in: seconds } = await response.json();
  if (!token) throw new Error('fcm_auth_failed');
  cachedAccessToken = token;
  // Refresh five minutes early.
  cachedUntil = now + Math.max(0, Number(seconds || 3600) - 300) * 1000;
  return token;
}
export const resetFcmAccessTokenCache = () => { cachedAccessToken = undefined; cachedUntil = 0; };

// Same destination keys as the iOS payload so both apps resolve a tap the same way.
export function androidFcmMessage(notification, token) {
  return {
    message: {
      token,
      notification: { title: [...notification.title].slice(0, 80).join(''), body: [...notification.body].slice(0, 300).join('') },
      data: {
        notificationId: String(notification._id),
        recipientId: String(notification.recipient),
        server: new URL(process.env.PUBLIC_BASE_URL).origin
      },
      android: {
        priority: 'HIGH',
        ttl: '3600s',
        collapse_key: String(notification._id),
        notification: { channel_id: ANDROID_NOTIFICATION_CHANNEL }
      }
    }
  };
}

export async function sendAndroidFcmRequest(subscription, message, { fetchImpl = fetch } = {}) {
  const accessToken = await fcmAccessToken({ fetchImpl });
  const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(process.env.FCM_PROJECT_ID)}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10000)
  });
  if (response.ok) return { status: response.status };
  let reason;
  try {
    const error = (await response.json()).error;
    reason = error?.details?.find(detail => detail?.errorCode)?.errorCode || error?.status;
  } catch { /* Error bodies are best-effort. */ }
  return { status: response.status, reason };
}

export const hasLiveAndroidFcmSession = subscription => hasLiveApnsSession(subscription);

// Tokens FCM reports as gone or issued for a different sender. Payload problems
// (INVALID_ARGUMENT) are not treated as a bad device.
const deadTokenReasons = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH']);

export async function sendAndroidNativePush({ notification, recipient }, send = sendAndroidFcmRequest, dependencies = {}) {
  if (!androidFcmConfigured() || !isMobilePushType(notification)) return { status: 'skipped' };
  const home = await (dependencies.loadHome || loadMobileHome)({ userId: recipient._id });
  const association = home.associations.find(item => String(item.association.id) === String(notification.association?._id || notification.association));
  if (!association || (notificationPriority(notification) === 'action' && !association.roles.some(role => ['management', 'officer', 'district_leader'].includes(role.kind)))) return { status: 'skipped' };
  const subscriptions = await AndroidFcmSubscription.find({ user: recipient._id, packageName: androidFcmPackage(), disabledAt: null, expiresAt: { $gt: new Date() } }).select('+sessionId');
  let sent = 0, failed = 0;
  for (const subscription of subscriptions) {
    try {
      if (!await (dependencies.hasLiveSession || hasLiveAndroidFcmSession)(subscription)) continue;
      const result = await send(subscription, androidFcmMessage(notification, subscription.token));
      if (result.status === 200) sent++;
      else if (result.status === 404 || deadTokenReasons.has(result.reason)) {
        await AndroidFcmSubscription.updateOne({ _id: subscription._id, updatedAt: subscription.updatedAt }, { $set: { disabledAt: new Date() } });
      } else failed++;
    } catch { failed++; }
  }
  return { status: sent ? 'sent' : failed ? 'failed' : 'skipped', ...(sent ? { sentAt: new Date() } : {}), ...(failed ? { error: `${failed} Android FCM delivery failure(s)` } : {}) };
}

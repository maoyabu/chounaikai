import test from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { Notification } from '../src/models/notification.js';
import { PushSubscription } from '../src/models/pushSubscription.js';
import { User } from '../src/models/user.js';
import { NotificationSettings } from '../src/models/notificationSettings.js';
import { createNotifications } from '../src/services/notificationService.js';

test('saved announcement notifications dispatch push and persist delivery results', async t => {
  const names = ['WEB_PUSH_PUBLIC_KEY', 'WEB_PUSH_PRIVATE_KEY', 'WEB_PUSH_SUBJECT', 'SMTP_HOST'];
  const previous = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => previous[i] === undefined ? delete process.env[name] : process.env[name] = previous[i]));
  Object.assign(process.env, { WEB_PUSH_PUBLIC_KEY: 'test', WEB_PUSH_PRIVATE_KEY: 'test', WEB_PUSH_SUBJECT: 'mailto:test@example.com', SMTP_HOST: '' });
  const record = { _id: 'notice', recipient: 'resident', type: 'officer_announcement', title: '連絡', body: '確認してください' };
  let saved = false, payload, result;
  let settings = null;
  t.mock.method(Notification, 'countDocuments', async filter => {
    assert.deepEqual(filter, { recipient: 'resident', readAt: null });
    return 3;
  });
  t.mock.method(Notification, 'findOneAndUpdate', async () => record);
  t.mock.method(NotificationSettings, 'findOne', () => ({ lean: async () => settings }));
  t.mock.method(Notification, 'insertMany', async records => { saved = true; return records; });
  t.mock.method(User, 'findById', () => ({ select: () => ({ lean: async () => ({ _id: 'resident' }) }) }));
  t.mock.method(PushSubscription, 'find', async filter => {
    assert.equal(filter.user, 'resident');
    return [{ endpoint: 'https://push.example.test', keys: {}, save: async () => {} }];
  });
  t.mock.method(webpush, 'setVapidDetails', () => {});
  t.mock.method(webpush, 'sendNotification', async (_, body) => { assert.ok(saved); payload = JSON.parse(body); });
  t.mock.method(Notification, 'updateOne', async (_, update) => { result = update.$set; });
  await createNotifications([record]);
  assert.equal(payload.url, '/dashboard?notifications=open');
  assert.equal(payload.tag, 'notice');
  assert.equal(payload.unreadCount, 3);
  assert.equal(result['delivery.push'].status, 'sent');
  t.mock.method(webpush, 'sendNotification', async () => { throw new Error('transport unavailable'); });
  await createNotifications([record]);
  assert.equal(result['delivery.push'].status, 'failed');
  settings = { channels: { officer_announcement: { push: false, email: false } } };
  const calls = webpush.sendNotification.mock.callCount();
  await createNotifications([record]);
  assert.equal(result['delivery.push'].status, 'skipped');
  assert.equal(webpush.sendNotification.mock.callCount(), calls);
});

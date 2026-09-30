import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { notificationsRouter } from '../src/routes/notifications.js';
import { Notification } from '../src/models/notification.js';
import { requireLogin } from '../src/middleware/auth.js';

test('badge count API requires login and counts only the current recipient', async t => {
  assert.ok(notificationsRouter.stack.some(layer => layer.handle === requireLogin));
  const route = notificationsRouter.stack.find(layer => layer.route?.path === '/unread-count').route;
  t.mock.method(Notification, 'countDocuments', async filter => {
    assert.deepEqual(filter, { recipient: 'current-user', readAt: null });
    return 4;
  });
  await route.stack[0].handle({ user: { _id: 'current-user' } }, {
    set: (name, value) => assert.equal(value, 'no-store'),
    json: result => assert.deepEqual(result, { unreadCount: 4 })
  }, error => { throw error; });
});

test('push updates count, clears zero, and still displays notifications if badging fails', async () => {
  const listeners = {}, counts = [];
  let shown = 0, cleared = 0;
  const navigator = { setAppBadge: async count => { counts.push(count); }, clearAppBadge: async () => { cleared++; } };
  const context = { self: { navigator, addEventListener: (name, callback) => { listeners[name] = callback; }, registration: { showNotification: async () => { shown++; } } } };
  vm.runInNewContext(fs.readFileSync('src/public/push-service-worker.js', 'utf8'), context);
  const push = async unreadCount => {
    let pending;
    listeners.push({ data: { json: () => ({ unreadCount }) }, waitUntil: promise => { pending = promise; } });
    await pending;
  };
  await push(5);
  assert.deepEqual(counts, [5]);
  await push(0);
  assert.equal(cleared, 1);
  navigator.setAppBadge = async () => { throw new Error('unsupported'); };
  await push(2);
  assert.equal(shown, 3);
  delete navigator.setAppBadge;
  await push(1);
  assert.equal(shown, 4);
});

test('page refresh follows authoritative counts and clears badge after logout', async () => {
  const counts = [], listeners = {};
  let count = 6, status = 200, clears = 0;
  const context = {
    navigator: { setAppBadge: async count => counts.push(count), clearAppBadge: async () => { clears++; } },
    window: { addEventListener: (name, callback) => { listeners[name] = callback; } },
    document: { visibilityState: 'visible', addEventListener: () => {} },
    fetch: async () => ({ ok: status === 200, status, json: async () => ({ unreadCount: count }) }),
    setInterval: () => {}
  };
  vm.runInNewContext(fs.readFileSync('src/public/notification-badge.js', 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(counts, [6]);
  count = 2;
  await listeners.focus();
  assert.deepEqual(counts, [6, 2]);
  count = 0;
  await listeners.focus();
  assert.equal(clears, 1);
  status = 401;
  await listeners.focus();
  assert.equal(clears, 2);
});

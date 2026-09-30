import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationCategory, NotificationSettings, notificationCategories } from '../src/models/notificationSettings.js';
import { managementRouter } from '../src/routes/management.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';

test('reminders share their channel settings and approval events map to settings', () => {
  assert.equal(notificationCategory('group_message_reminder'), 'group_message');
  assert.equal(notificationCategory('officer_network_reminder'), 'officer_network');
  assert.equal(notificationCategory('join_application_approved'), 'join');
  assert.equal(notificationCategory('household_link_requested'), 'household');
  assert.equal(notificationCategory('district_leader_assigned'), 'assignment');
});

test('settings save is login/permission/CSRF protected and scopes writes to the association', async t => {
  assert.ok(managementRouter.stack.some(layer => layer.handle === requireLogin));
  const route = managementRouter.stack.find(layer => layer.route?.path === '/:associationId/manage/notifications' && layer.route.methods.post).route;
  assert.equal(route.stack.length, 3); // permission, CSRF, handler
  assert.equal(route.stack[1].handle, verifyCsrfToken);
  let filter, update;
  t.mock.method(NotificationSettings, 'findOneAndUpdate', async (f, u) => { filter = f; update = u; });
  await route.stack.at(-1).handle({ params: { associationId: 'association-A' }, session: {}, body: { officer_announcement_push: 'on', question_email: 'on', unknown_push: 'on', association: 'association-B' } }, { redirect: () => {} }, error => { throw error; });
  assert.equal(filter.association, 'association-A');
  assert.equal(update.$set.channels.officer_announcement.push, true);
  assert.equal(update.$set.channels.question.email, true);
  assert.equal(update.$set.channels.question.push, false);
  assert.equal(Object.keys(update.$set.channels).length, notificationCategories.length);
  assert.equal(update.$set.channels.unknown, undefined);
});

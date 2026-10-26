import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationAction } from '../src/services/notificationDestination.js';
import { notificationDestination } from '../src/services/notificationService.js';

const notice = { association: { _id: 'a' }, relatedId: 'g' };
const destination = (type, extra = {}, context = {}) => notificationAction({ ...notice, type, ...extra }, context).actionUrl;

test('group requests lead to management and results lead to the group page, including legacy records', () => {
  for (const title of ['グループへの参加申請が届きました', 'グループへの退会申請が届きました']) {
    assert.equal(destination('group_request', { title }), '/associations/a/groups/g/manage');
  }
  assert.equal(destination('group_request', { title: 'グループ参加が承認されました' }), '/associations/a/groups/g');
  assert.equal(destination('group_request', { title: 'グループ作成申請が届きました', relatedId: null }), '/associations/a/manage/groups');
  assert.equal(destination('group_request', { title: 'グループ作成申請が承認されませんでした', relatedId: null }), '/associations/a');
});

test('participation approval destinations respect the recipient role', () => {
  assert.equal(destination('join_application_received', {}, { currentManagerAssociations: [{ _id: 'a' }], currentLeaderAssociations: [{ _id: 'a' }] }), '/associations/a/manage/applications');
  assert.equal(destination('join_application_received', {}, { currentLeaderAssociations: [{ _id: 'a' }] }), '/associations/a/leader?tab=applications#application-g');
  assert.equal(destination('household_link_requested'), '/profile?tab=household');
  assert.equal(destination('withdrawal_head_requested'), '/profile/withdrawals');
});

test('messages and other actionable notices lead to the corresponding screen', () => {
  const cases = {
    officer_announcement: '/associations/a/announcements/g',
    officer_network_reminder: '/associations/a/officer-network/inbox/g',
    district_message: '/associations/a/district-messages/inbox/g',
    question_answered: '/associations/a/questions?open=own-g',
    equipment_loan: '/associations/a/equipment/g/loans#equipment-loan-requests',
    department_plan: '/associations/a/department-plans'
  };
  for (const [type, path] of Object.entries(cases)) assert.equal(destination(type), path);
  assert.equal(destination('group_message_reminder', {}, { messageGroup: 'team' }), '/associations/a/groups/team/messages/inbox/g');
  assert.equal(destination('system_contact', {}, { isAdmin: true }), '/admin/system-contacts/g');
});

test('email and push use the same destinations and authenticated recipient links for contextual notices', () => {
  assert.equal(notificationDestination({ ...notice, type: 'group_request', title: 'グループへの参加申請が届きました' }), '/associations/a/groups/g/manage');
  for (const type of ['group_message', 'join_application_received', 'system_contact']) {
    assert.equal(notificationDestination({ ...notice, _id: 'n', type }), '/notifications/n/open');
  }
  assert.equal(notificationDestination({ ...notice, type: 'officer_announcement' }), '/associations/a/announcements/g');
});

test('email/push entry rejects other recipients and redirects an owned request', async t => {
  const { webRouter } = await import('../src/routes/web.js');
  const { Notification } = await import('../src/models/notification.js');
  const layer = webRouter.stack.find(item => item.route?.path === '/notifications/:notificationId/open');
  const handler = layer.route.stack.at(-1).handle;
  let filter;
  let record = null;
  t.mock.method(Notification, 'findOne', criteria => {
    filter = criteria;
    return { lean: async () => record };
  });
  const req = { params: { notificationId: '507f1f77bcf86cd799439011' }, user: { _id: 'recipient' } };
  const res = { locals: {}, sendStatus(status) { this.status = status; }, redirect(path) { this.path = path; } };
  const next = error => { throw error; };
  await handler(req, res, next);
  assert.equal(res.status, 404);
  assert.equal(filter.recipient, 'recipient');
  record = { ...notice, type: 'group_request', title: 'グループへの参加申請が届きました' };
  await handler(req, res, next);
  assert.equal(res.path, '/associations/a/groups/g/manage');
});

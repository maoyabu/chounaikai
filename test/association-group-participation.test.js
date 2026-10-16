import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { AssociationGroup, AssociationGroupMembership, AssociationGroupJoinRequest } from '../src/models/associationGroup.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationEvent } from '../src/models/associationEvent.js';
import { associationGroupsRouter } from '../src/routes/associationGroups.js';
import { calendarWindow } from '../src/services/associationEventService.js';

const association = '507f1f77bcf86cd799439011', group = '507f1f77bcf86cd799439012', user = '507f1f77bcf86cd799439013';
const query = value => ({ select() { return this; }, populate() { return this; }, sort() { return this; }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const handler = (path, method = 'post') => associationGroupsRouter.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const req = () => ({ params: { associationId: association, groupId: group }, user: { _id: user }, session: {}, query: {} });
const render = async (members = [], joinRequest = null, currentUser = { _id: user }) => ejs.renderFile('src/views/association-group-public.ejs', {
  title: 'PR', currentUser, assetVersion: 'test', currentPath: '/', showNotificationPrompt: false, csrfToken: 'token',
  association: { name: '町内会' }, group: { _id: group, association, name: 'グループ', status: 'active' },
  members, joinRequest, isResident: Boolean(currentUser), events: [], ...calendarWindow(), calendarWindow: calendarWindow()
});

test('PR buttons show joining, pending, active and withdrawal pending states', async () => {
  assert.match(await render(), />グループに参加する<\/button>/);
  const pending = await render([], { status: 'pending' });
  assert.match(pending, /disabled>申請中<\/button>/);
  assert.doesNotMatch(pending, /退会申請|>グループに参加する</);
  const member = { user: { _id: user, displayname: '住人' } };
  const active = await render([member], { status: 'pending' });
  assert.match(active, /disabled>グループに参加中<\/button>/);
  assert.match(active, /button-small" >退会申請<\/button>/);
  assert.doesNotMatch(active, />申請中</);
  member.withdrawalRequestedAt = new Date();
  assert.match(await render([member]), /disabled>退会申請中<\/button>/);
  assert.doesNotMatch(await render([], null, null), /group-participation-actions/);
});

test('PR fetches the current user pending request with group and association scope', async t => {
  t.mock.method(AssociationGroup, 'findOne', () => query({ _id: group, association, publicVisibility: 'open' }));
  t.mock.method(AssociationGroup, 'exists', async () => true);
  t.mock.method(NeighborhoodAssociation, 'findById', () => query({ name: '町内会' }));
  t.mock.method(AssociationMembership, 'findOne', async () => ({}));
  t.mock.method(AssociationGroupMembership, 'find', () => query([]));
  t.mock.method(AssociationGroupMembership, 'findOne', async () => null);
  t.mock.method(AssociationEvent, 'find', () => query([]));
  t.mock.method(AssociationGroupJoinRequest, 'findOne', filter => {
    assert.deepEqual(filter, { association, group, applicant: user, status: 'pending' });
    return query({ status: 'pending' });
  });
  let data;
  await handler('/:associationId/groups/:groupId', 'get')(req(), { render: (_, values) => { data = values; } }, error => { throw error; });
  assert.equal(data.joinRequest.status, 'pending');
});

test('withdrawal rejects non-members and repeated requests without sending notices', async t => {
  t.mock.method(AssociationGroup, 'findOne', () => query({ _id: group, association }));
  t.mock.method(AssociationGroupMembership, 'findOneAndUpdate', async (filter, update) => {
    assert.deepEqual(filter, { association, group, user, status: 'active', withdrawalRequestedAt: null });
    assert.ok(update.$set.withdrawalRequestedAt instanceof Date);
    return null;
  });
  let error;
  await handler('/:associationId/groups/:groupId/withdrawal')(req(), {}, value => { error = value; });
  assert.equal(error.status, 409);
});

test('withdrawal approval refuses to remove the last manager', async t => {
  t.mock.method(AssociationGroup, 'exists', async () => true);
  t.mock.method(AssociationGroupMembership, 'findOne', async () => ({ role: 'manager', user }));
  t.mock.method(AssociationGroupMembership, 'countDocuments', async () => 1);
  t.mock.method(AssociationGroupMembership, 'findOneAndUpdate', async () => { throw new Error('must not remove the last manager'); });
  const request = req(); request.params.userId = user; request.params.decision = 'approve';
  let error;
  await handler('/:associationId/groups/:groupId/manage/withdrawals/:userId/:decision')(request, {}, value => { error = value; });
  assert.match(error.message, /最後の責任者/);
});

test('withdrawal decisions require manager access', async t => {
  t.mock.method(AssociationGroup, 'exists', async () => true);
  t.mock.method(AssociationGroupMembership, 'findOne', async () => null);
  const request = req(); request.params.userId = user; request.params.decision = 'approve';
  let error;
  await handler('/:associationId/groups/:groupId/manage/withdrawals/:userId/:decision')(request, {}, value => { error = value; });
  assert.equal(error.status, 403);
});

for (const decision of ['approve', 'reject']) test(`withdrawal ${decision} updates membership and notifies applicant`, async t => {
  const { Notification } = await import('../src/models/notification.js');
  t.mock.method(AssociationGroup, 'exists', async () => true);
  t.mock.method(AssociationGroupMembership, 'findOne', async filter => filter.role ? { role: 'manager' } : { role: 'member', user });
  t.mock.method(AssociationGroupMembership, 'findOneAndUpdate', async (filter, update) => {
    assert.equal(filter.user, user);
    assert.deepEqual(filter.withdrawalRequestedAt, { $ne: null });
    assert.deepEqual(update.$unset, { withdrawalRequestedAt: 1 });
    if (decision === 'approve') assert.deepEqual(update.$set, { status: 'rejected', role: 'member' });
    else assert.equal(update.$set, undefined);
    return {};
  });
  t.mock.method(Notification, 'insertMany', async notices => { assert.equal(notices[0].recipient, user); });
  const request = req(); request.params.userId = user; request.params.decision = decision;
  let redirected;
  await handler('/:associationId/groups/:groupId/manage/withdrawals/:userId/:decision')(request, { redirect: path => { redirected = path; } }, error => { throw error; });
  assert.equal(redirected, `/associations/${association}/groups/${group}/manage`);
  assert.equal(Notification.insertMany.mock.callCount(), 1);
});

test('join application reuses decided requests and rejects duplicate pending requests', async t => {
  t.mock.method(AssociationGroup, 'findOne', async () => ({ _id: group, association }));
  t.mock.method(AssociationMembership, 'exists', async () => true);
  t.mock.method(AssociationGroupMembership, 'exists', async () => null);
  t.mock.method(AssociationGroupMembership, 'find', () => ({ distinct: async () => [] }));
  t.mock.method(AssociationGroupJoinRequest, 'findOneAndUpdate', async (filter, update, options) => {
    assert.deepEqual(filter, { association, group, applicant: user, status: { $ne: 'pending' } });
    assert.deepEqual(update.$set, { status: 'pending' });
    assert.equal(options.upsert, true);
    return {};
  });
  let redirected;
  await handler('/:associationId/groups/:groupId')(req(), { redirect: path => { redirected = path; } }, error => { throw error; });
  assert.equal(redirected, `/associations/${association}/groups/${group}`);
  AssociationGroupJoinRequest.findOneAndUpdate.mock.mockImplementation(async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); });
  let error;
  await handler('/:associationId/groups/:groupId')(req(), {}, value => { error = value; });
  assert.equal(error.status, 409);
});

test('approved withdrawal returns the PR button to join and allows a new application', async t => {
  const { Notification } = await import('../src/models/notification.js');
  const member = { user: { _id: user, displayname: '住人' }, role: 'member', status: 'active', withdrawalRequestedAt: new Date() };
  t.mock.method(AssociationGroup, 'exists', async () => true);
  t.mock.method(AssociationGroup, 'findOne', () => query({ _id: group, association, name: 'グループ', status: 'active', publicVisibility: 'open' }));
  t.mock.method(AssociationGroupMembership, 'findOne', async filter => filter.role ? { role: 'manager' } : member.status === 'active' ? member : null);
  t.mock.method(AssociationGroupMembership, 'findOneAndUpdate', async (_filter, update) => {
    Object.assign(member, update.$set);
    delete member.withdrawalRequestedAt;
    return member;
  });
  t.mock.method(Notification, 'insertMany', async () => []);
  const approval = req(); approval.params.userId = user; approval.params.decision = 'approve';
  await handler('/:associationId/groups/:groupId/manage/withdrawals/:userId/:decision')(approval, { redirect() {} }, error => { throw error; });
  assert.equal(member.status, 'rejected');

  t.mock.method(NeighborhoodAssociation, 'findById', () => query({ name: '町内会' }));
  t.mock.method(AssociationMembership, 'findOne', async () => ({}));
  t.mock.method(AssociationGroupMembership, 'find', filter => {
    assert.equal(filter.status, 'active');
    return { ...query(member.status === 'active' ? [member] : []), distinct: async () => [] };
  });
  t.mock.method(AssociationEvent, 'find', () => query([]));
  t.mock.method(AssociationGroupJoinRequest, 'findOne', () => query(null));
  let data;
  await handler('/:associationId/groups/:groupId', 'get')(req(), { render: (_, values) => { data = values; } }, error => { throw error; });
  const html = await ejs.renderFile('src/views/association-group-public.ejs', {
    ...data, currentUser: { _id: user }, assetVersion: 'test', currentPath: '/', showNotificationPrompt: false, csrfToken: 'token'
  });
  assert.match(html, />グループに参加する<\/button>/);
  assert.doesNotMatch(html, /グループに参加中|退会申請/);

  t.mock.method(AssociationMembership, 'exists', async () => true);
  t.mock.method(AssociationGroupMembership, 'exists', async () => member.status === 'active' ? member : null);
  t.mock.method(AssociationGroupJoinRequest, 'findOneAndUpdate', async () => ({ status: 'pending' }));
  let redirected;
  await handler('/:associationId/groups/:groupId')(req(), { redirect: path => { redirected = path; } }, error => { throw error; });
  assert.equal(redirected, `/associations/${association}/groups/${group}`);
  assert.equal(AssociationGroupJoinRequest.findOneAndUpdate.mock.callCount(), 1);
});


test('group PR offers communications only to active participants of an active group', async () => {
  const member = { user: { _id: user, displayname: '住人' } };
  const html = await render([member]);
  assert.match(html, /id="group-pr-messages-title">グループ内の連絡/);
  for (const suffix of ['/inbox', '/new', '']) {
    assert.ok(html.includes(`href="/associations/${association}/groups/${group}/messages${suffix}"`));
  }
  for (const hidden of [await render(), await render([], { status: 'pending' }), await render([], null, null)]) {
    assert.doesNotMatch(hidden, /id="group-pr-messages-title"/);
  }
  // Withdrawal applicants stay participants until approved.
  member.withdrawalRequestedAt = new Date();
  assert.match(await render([member]), /id="group-pr-messages-title"/);
});

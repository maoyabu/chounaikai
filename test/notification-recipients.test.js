import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyEvent } from '../src/services/notificationRecipients.js';
import { AssociationGroupMembership } from '../src/models/associationGroup.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { Notification } from '../src/models/notification.js';

test('hidden events do not notify; group events notify only active association/group members', async t => {
  let records;
  t.mock.method(AssociationGroupMembership, 'find', filter => {
    assert.deepEqual(filter, { association: 'town', group: 'group', status: 'active' });
    return { distinct: async () => ['resident'] };
  });
  t.mock.method(AssociationMembership, 'find', filter => {
    assert.deepEqual(filter, { association: 'town', status: 'active', user: { $in: ['resident'] } });
    return { distinct: async () => ['resident'] };
  });
  t.mock.method(Notification, 'insertMany', async values => { records = values; });
  await notifyEvent({ visible: false }, '登録');
  assert.equal(Notification.insertMany.mock.callCount(), 0);
  await notifyEvent({ visible: true, association: 'town', group: 'group', _id: 'event' }, '変更');
  assert.equal(records.length, 1);
  assert.equal(records[0].recipient, 'resident');
  assert.equal(records[0].type, 'group_event');
});

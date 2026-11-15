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
  await notifyEvent({ visible: true, association: 'town', group: 'group', _id: 'event', title: '秋まつり', startDate: '2026-11-15', startTime: '10:00', endDate: '2026-11-15', endTime: '12:00', body: '公園に集合してください。' }, '変更');
  assert.equal(records.length, 1);
  assert.equal(records[0].recipient, 'resident');
  assert.equal(records[0].type, 'group_event');
  assert.match(records[0].body, /行事名：秋まつり/);
  assert.match(records[0].body, /開始：2026-11-15 10:00/);
  assert.match(records[0].body, /終了：2026-11-15 12:00/);
  assert.match(records[0].body, /公園に集合してください。/);
});

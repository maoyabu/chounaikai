import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { OfficerAnnouncement } from '../src/models/officerAnnouncement.js';
import { excludeMutedAnnouncementNotifications } from '../src/services/notificationVisibilityService.js';

test('muted announcements and reminders disappear regardless of read, pinned or hidden state; restoration preserves state', async t => {
  const mutedId = new mongoose.Types.ObjectId(), visibleId = new mongoose.Types.ObjectId();
  let muted = true;
  t.mock.method(OfficerAnnouncement, 'find', filter => {
    assert.deepEqual(filter._id.$in, [String(mutedId), String(visibleId)]);
    assert.deepEqual(filter.mutedAt, { $ne: null });
    return { select: () => ({ lean: async () => muted ? [{ _id: mutedId }] : [] }) };
  });
  const items = [
    { type: 'officer_announcement', relatedId: mutedId, readAt: null, pinned: true },
    { type: 'officer_announcement_reminder', relatedId: mutedId, readAt: new Date(), hiddenAt: new Date() },
    { type: 'officer_announcement', relatedId: visibleId, readAt: null },
    { type: 'danger', relatedId: mutedId, readAt: null }
  ];
  assert.deepEqual(await excludeMutedAnnouncementNotifications(items), items.slice(2));
  muted = false;
  assert.deepEqual(await excludeMutedAnnouncementNotifications(items), items);
  assert.equal(items[0].readAt, null);
});

test('unrelated notifications require no announcement query', async t => {
  const query = t.mock.method(OfficerAnnouncement, 'find', () => { throw new Error('unexpected query'); });
  const items = [{ type: 'danger', relatedId: new mongoose.Types.ObjectId() }];
  assert.deepEqual(await excludeMutedAnnouncementNotifications(items), items);
  assert.equal(query.mock.callCount(), 0);
});

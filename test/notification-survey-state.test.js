import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../src/models/officerAnnouncement.js';
import { attachSurveyResponseState } from '../src/services/notificationInboxService.js';

test('survey badges depend on recipient response, not read status', async t => {
  const query = rows => ({ select: () => ({ lean: async () => rows }) });
  t.mock.method(OfficerAnnouncement, 'find', () => query([
    { _id: 'single', responseMode: 'single' },
    { _id: 'multiple', responseMode: 'multiple' },
    { _id: 'none', responseMode: 'none' },
    { _id: 'muted', responseMode: 'single', mutedAt: new Date() }
  ]));
  let answered = false;
  t.mock.method(OfficerAnnouncementReceipt, 'find', filter => {
    assert.equal(filter.recipient, 'current-user');
    return query([
      { announcement: 'single', respondedAt: answered ? new Date() : null },
      { announcement: 'multiple', respondedAt: new Date() },
      { announcement: 'none' }, { announcement: 'muted' }
    ]);
  });
  const items = [
    { type: 'officer_announcement', relatedId: 'single', readAt: new Date() },
    { type: 'officer_announcement_reminder', relatedId: 'single', readAt: null },
    { type: 'officer_announcement', relatedId: 'multiple' },
    { type: 'officer_announcement', relatedId: 'none' },
    { type: 'officer_announcement', relatedId: 'muted' },
    { type: 'danger_report', relatedId: 'single' }
  ];
  await attachSurveyResponseState(items, 'current-user');
  assert.deepEqual(items.map(item => item.requiresSurveyResponse), [true, true, false, false, false, false]);
  answered = true;
  await attachSurveyResponseState(items, 'current-user');
  assert.ok(items.every(item => !item.requiresSurveyResponse));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { communicationCategory, mobileCommunication } from '../src/services/mobileCommunicationService.js';

test('mobile communications split emergency urgency five from announcements', () => {
  assert.equal(communicationCategory({ urgency: 5 }), 'emergency');
  assert.equal(communicationCategory({ urgency: 4 }), 'announcement');
});

test('mobile communication exposes resident receipt state and safe sender data', () => {
  const result = mobileCommunication({
    announcement: {
      _id: 'message-1', association: 'association-1', urgency: 5, audience: 'all',
      title: '避難情報', body: '安全を確保してください。', responseMode: 'single', options: ['無事です', '支援が必要です'],
      sender: { displayname: '役員 一郎' }, createdAt: new Date('2026-06-18T01:30:00Z'), attachments: []
    },
    receipt: { readAt: null, selectedOptions: [0], respondedAt: new Date('2026-06-18T01:35:00Z') }
  });

  assert.equal(result.category, 'emergency');
  assert.equal(result.audience, '全住人対象');
  assert.equal(result.sender, '役員 一郎');
  assert.deepEqual(result.selectedOptions, [0]);
});

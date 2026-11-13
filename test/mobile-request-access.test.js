import test from 'node:test';
import assert from 'node:assert/strict';
import { canViewMobileRequest } from '../src/services/mobileRequestAccess.js';

const profiles = [{ association: { id: 'town' }, roles: [{ kind: 'group_manager', groupId: 'group' }] }];
const notice = { association: 'town', relatedId: 'group', type: 'group_request', title: 'グループへの参加申請が届きました' };

test('group-only manager sees join and withdrawal requests even after reading', () => {
  for (const title of ['グループへの参加申請が届きました', 'グループへの退会申請が届きました']) {
    for (const readAt of [null, new Date()]) {
      assert.equal(canViewMobileRequest({ ...notice, title, readAt }, profiles), true);
      assert.equal(canViewMobileRequest({ ...notice, title, association: { _id: 'town' } }, profiles), true);
    }
  }
});

test('group manager cannot see other groups, towns, creation requests or resident approvals', () => {
  for (const change of [
    { relatedId: 'other-group' }, { association: 'other-town' }, { relatedId: null },
    { title: 'グループ作成申請が届きました' }, { type: 'join_application_received' }
  ]) assert.equal(canViewMobileRequest({ ...notice, ...change }, profiles), false);
  assert.equal(canViewMobileRequest(notice, [{ association: { id: 'town' }, roles: [] }]), false);
});

test('existing officer, leader and management access remains available', () => {
  for (const kind of ['management', 'officer', 'district_leader']) {
    assert.equal(canViewMobileRequest({ ...notice, type: 'join_application_received' }, [{ association: { id: 'town' }, roles: [{ kind }] }]), true);
  }
});

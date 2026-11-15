import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileGroup, mobileGroupsRouter } from '../src/routes/mobileGroups.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';

test('mobile group routes require login and join requests require CSRF', () => {
  assert.equal(mobileGroupsRouter.stack[0].handle, requireLogin);
  const join = mobileGroupsRouter.stack.find(layer => layer.route?.path === '/:groupId/join-requests');
  assert.ok(join);
  assert.equal(join.route.methods.post, true);
  assert.equal(join.route.stack[0].handle, verifyCsrfToken);
});

test('mobile group summary exposes display fields without storage identifiers', () => {
  const value = mobileGroup({
    _id: 'group-id',
    name: '防災クラブ',
    purpose: '地域の防災活動',
    publicDescription: '毎月活動しています',
    publicPhotos: [null, { url: '/photo', publicId: 'private-storage-id' }]
  }, { memberCount: 4, isMember: true, applicationStatus: null });

  assert.deepEqual(value, {
    id: 'group-id',
    name: '防災クラブ',
    description: '毎月活動しています',
    photoURL: '/photo',
    memberCount: 4,
    isMember: true,
    applicationStatus: null
  });
  assert.equal(value.publicId, undefined);
});

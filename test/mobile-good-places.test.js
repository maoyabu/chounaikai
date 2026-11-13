import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileGoodPlacesRouter, mobileGoodPlace } from '../src/routes/mobileGoodPlaces.js';
import { GoodPlace } from '../src/models/goodPlace.js';
import { GoodPlaceLike, GoodPlaceComment } from '../src/models/goodPlaceReaction.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';
const associationId = '507f1f77bcf86cd799439011';
const reportId = '507f1f77bcf86cd799439012';
const userId = '507f1f77bcf86cd799439013';
const handler = (path, method = 'get') => mobileGoodPlacesRouter.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const query = rows => ({ populate() { return this; }, select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => rows });
const next = error => { throw error; };

test('mobile reads require login, active membership and enabled feature; mutations require CSRF', async t => {
  assert.equal(mobileGoodPlacesRouter.stack[0].handle, requireLogin);
  for (const path of ['/:reportId/like', '/:reportId/comments']) {
    assert.equal(mobileGoodPlacesRouter.stack.find(layer => layer.route?.path === path).route.stack[0].handle, verifyCsrfToken);
  }
  let member = false, enabled = true;
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ optionalFeatures: { goodPlaces: enabled } }));
  t.mock.method(AssociationMembership, 'exists', async () => member);
  const access = mobileGoodPlacesRouter.stack[1].handle;
  const req = { params: { associationId }, user: { _id: userId } }, res = { set() {} };
  await assert.rejects(access(req, res, next), { status: 403 });
  member = true; enabled = false;
  await assert.rejects(access(req, res, next), { status: 404 });
  enabled = true;
  let passed = false;
  await access(req, res, () => { passed = true; });
  assert.equal(passed, true);
});

test('newest list paginates at 50, provides counts and never exposes storage or author IDs', async t => {
  const rows = Array.from({ length: 51 }, (_, i) => ({ _id: String(i), association: associationId, title: '写真', body: '本文', author: { _id: userId, displayname: '投稿者' }, createdAt: new Date(), photoAttachment: { fileId: 'secret' } }));
  t.mock.method(GoodPlace, 'find', filter => {
    assert.equal(filter.association, associationId);
    return { ...query(rows), sort(value) { assert.deepEqual(value, { createdAt: -1, _id: -1 }); return this; }, skip(value) { assert.equal(value, 50); return this; }, limit(value) { assert.equal(value, 51); return this; } };
  });
  t.mock.method(GoodPlaceLike, 'aggregate', async () => [{ _id: '0', count: 7 }]);
  t.mock.method(GoodPlaceComment, 'aggregate', async pipeline => {
    assert.equal(pipeline[0].$match.hiddenAt, null);
    assert.equal(String(pipeline[0].$match.association), associationId);
    assert.equal(pipeline[0].$match.report.$in.length, 50);
    return [{ _id: '0', count: 12 }];
  });
  t.mock.method(GoodPlaceComment, 'find', () => query([]));
  let result;
  await handler('/')({ params: { associationId }, query: { page: '2' } }, { json: value => { result = value; } }, next);
  assert.equal(result.reports.length, 50); assert.equal(result.hasNext, true); assert.equal(result.page, 2);
  assert.equal(result.reports[0].likeCount, 7); assert.equal(result.reports[0].author, '投稿者');
  assert.equal(result.reports[0].photoAttachment, undefined);
  assert.equal(result.reports[0].commentCount, 12);
  assert.equal(result.reports[1].commentCount, 0);
});

test('like order follows database ranking including date tie-break and page limits', async t => {
  t.mock.method(GoodPlace, 'aggregate', async pipeline => {
    assert.deepEqual(pipeline.find(stage => stage.$sort).$sort, { likeCount: -1, createdAt: -1, _id: -1 });
    assert.equal(pipeline.find(stage => stage.$limit).$limit, 51);
    return [{ _id: reportId }, { _id: userId }];
  });
  t.mock.method(GoodPlace, 'find', () => query([{ _id: userId, association: associationId }, { _id: reportId, association: associationId }]));
  t.mock.method(GoodPlaceLike, 'aggregate', async () => []);
  t.mock.method(GoodPlaceComment, 'aggregate', async () => []);
  t.mock.method(GoodPlaceComment, 'find', () => query([]));
  let result;
  await handler('/')({ params: { associationId }, query: { sort: 'likes' } }, { json: value => { result = value; } }, next);
  assert.deepEqual(result.reports.map(item => item.id), [reportId, userId]);
});

test('detail returns comment permissions, liked state, visible comments and CSRF', async t => {
  t.mock.method(GoodPlace, 'findOne', filter => {
    assert.deepEqual(filter, { _id: reportId, association: associationId });
    return query({ _id: reportId, association: associationId, commentsEnabled: false, latitude: 0, longitude: 0 });
  });
  t.mock.method(GoodPlaceLike, 'countDocuments', async () => 3);
  t.mock.method(GoodPlaceLike, 'exists', async filter => { assert.equal(filter.user, userId); return true; });
  t.mock.method(GoodPlaceComment, 'countDocuments', async () => 1);
  t.mock.method(GoodPlaceComment, 'exists', async () => true);
  t.mock.method(GoodPlaceComment, 'find', filter => {
    assert.equal(filter.hiddenAt, null);
    return query([{ _id: userId, user: { displayname: '住人' }, body: 'きれい', createdAt: new Date() }]);
  });
  let result;
  await handler('/:reportId')({ params: { associationId, reportId }, query: {}, user: { _id: userId }, session: { csrfToken: 'token' } }, { json: value => { result = value; } }, next);
  assert.equal(result.report.commentsEnabled, false); assert.equal(result.liked, true); assert.equal(result.commented, true);
  assert.equal(result.report.commentCount, 1); assert.equal(result.report.likeCount, 3); assert.equal(result.report.latitude, 0);
  assert.equal(result.comments[0].author, '住人'); assert.equal(result.csrfToken, 'token');
});

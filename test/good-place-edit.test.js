import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { GoodPlace } from '../src/models/goodPlace.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { updateGoodPlace } from '../src/services/goodPlaceEditService.js';
import { goodPlacesRouter } from '../src/routes/goodPlaces.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';
const associationId = '507f1f77bcf86cd799439011', reportId = '507f1f77bcf86cd799439012', userId = '507f1f77bcf86cd799439013';
const input = { associationId, reportId, userId, body: { title: ' 新しいタイトル ', body: ' 修正した内容 ' } };
function setup(t, report = { updatedAt: new Date() }) {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => ({ lean: async () => ({ _id: associationId }) }));
  t.mock.method(AssociationMembership, 'exists', async () => ({}));
  t.mock.method(GoodPlace, 'findOne', filter => {
    assert.deepEqual(filter, { _id: reportId, association: associationId, author: userId });
    return { lean: async () => report };
  });
}
test('author can edit text without uploading a photo, with ownership and concurrency checked on write', async t => {
  const report = { updatedAt: new Date() }; setup(t, report);
  t.mock.method(GoodPlace, 'findOneAndUpdate', (filter, update, options) => {
    assert.deepEqual(filter, { _id: reportId, association: associationId, author: userId, updatedAt: report.updatedAt });
    assert.deepEqual(update, { $set: { title: '新しいタイトル', body: '修正した内容' } });
    assert.equal(options.runValidators, true);
    return { lean: async () => report };
  });
  assert.deepEqual(await updateGoodPlace(input), { photoCleanupPending: false });
});
test('another author cannot edit the post', async t => {
  setup(t, null);
  await assert.rejects(updateGoodPlace(input), { status: 404 });
});
test('inactive membership cannot edit a post', async t => {
  setup(t);
  t.mock.method(AssociationMembership, 'exists', async () => null);
  await assert.rejects(updateGoodPlace(input), { status: 403 });
});
test('invalid text and image are rejected before upload', async t => {
  setup(t);
  await assert.rejects(updateGoodPlace({ ...input, body: { title: '', body: '本文' } }), { status: 400 });
  await assert.rejects(updateGoodPlace({ ...input, file: { size: 4, buffer: Buffer.from('fake') } }), { status: 400 });
});
test('concurrent changes are reported instead of overwriting them', async t => {
  setup(t);
  t.mock.method(GoodPlace, 'findOneAndUpdate', () => ({ lean: async () => null }));
  await assert.rejects(updateGoodPlace(input), { status: 409 });
});
test('edit endpoint requires login and CSRF', () => {
  const route = goodPlacesRouter.stack.find(layer => layer.route?.path === '/associations/:associationId/good-places/:reportId/edit').route;
  assert.equal(route.stack[0].handle, requireLogin);
  assert.equal(route.stack[3].handle, verifyCsrfToken);
});
test('detail renders prefilled edit form only for the author', async () => {
  const locals = { title: '詳細', assetVersion: 'test', currentUser: null, currentPath: '/', csrfToken: 'csrf', showNotificationPrompt: false, notice: null,
    association: { _id: associationId, name: '町内会' }, report: { _id: reportId, title: '桜', body: '春の景色', createdAt: new Date(), locationSource: 'address', address: '公園' } };
  const owner = await ejs.renderFile('src/views/good-place-detail.ejs', { ...locals, canEdit: true });
  assert.match(owner, /修正を保存する/); assert.match(owner, /value="桜"/); assert.match(owner, /multipart\/form-data/);
  const visitor = await ejs.renderFile('src/views/good-place-detail.ejs', { ...locals, canEdit: false });
  assert.doesNotMatch(visitor, /修正を保存する/);
});

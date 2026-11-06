import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import mongoose from 'mongoose';
import { faqsRouter, faqInput, publishedFaqFilter } from '../src/routes/faqs.js';
import { Faq } from '../src/models/faq.js';
import { RoleAssignment } from '../src/models/role.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
const associationId = new mongoose.Types.ObjectId().toString();
const id = new mongoose.Types.ObjectId().toString();
const query = value => ({ sort() { return this; }, populate() { return this; }, lean: async () => value });
const request = (path, { method = 'get', admin = true, body = {}, csrf = true, queryParams = {}, locals = {} } = {}) => {
  const layer = faqsRouter.stack.find(layer => layer.route?.methods[method] && layer.match(path));
  const req = { params: layer.params, originalUrl: path, user: { _id: id, isAdmin: admin }, isAuthenticated: () => true, body, query: queryParams, session: { csrfToken: 'token' }, get: () => csrf ? 'token' : '' };
  return new Promise(resolve => {
    const res = { locals, statusCode: 200, status(code) { this.statusCode = code; return this; }, render(view, data) { resolve({ status: this.statusCode, view, data }); }, json(data) { resolve({ status: this.statusCode, data }); }, redirect(url) { resolve({ status: 302, url }); } };
    let index = 0;
    const next = error => {
      if (error) return resolve({ status: error.status || 500 });
      Promise.resolve(layer.route.stack[index++].handle(req, res, next)).catch(next);
    };
    next();
  });
};
test('FAQ input validates required fields and safe URLs', () => {
  const valid = { category: ' 手続き ', question: '質問', answer: '回答', published: 'on', relatedUrl: 'https://example.com/' };
  assert.equal(faqInput(valid).category, '手続き');
  assert.equal(faqInput(valid).published, true);
  assert.equal(faqInput({ ...valid, published: undefined }).published, false);
  for (const patch of [{ category: '' }, { question: [] }, { answer: 'x'.repeat(10001) }, { relatedUrl: 'javascript:alert(1)' }, { relatedUrl: 'https://user:pass@example.com' }, { published: [] }]) assert.throws(() => faqInput({ ...valid, ...patch }), { status: 400 });
});
test('published FAQ query includes only common and own published entries', () => {
  assert.deepEqual(publishedFaqFilter(associationId), { published: true, association: { $in: [null, associationId] } });
});
test('residents cannot access either manager screen', async t => {
  t.mock.method(RoleAssignment, 'findOne', () => query(null));
  assert.equal((await request(`/associations/${associationId}/manage/faqs`, { admin: false })).status, 403);
  assert.equal((await request('/admin/faqs', { admin: false })).status, 403);
});
test('editing and deletion cannot reach another owner and writes require CSRF', async t => {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: associationId }));
  let filter;
  t.mock.method(Faq, 'findOne', criteria => { filter = criteria; return query(null); });
  assert.equal((await request(`/associations/${associationId}/manage/faqs/${id}/edit`)).status, 404);
  assert.deepEqual(filter, { _id: id, association: associationId });
  assert.equal((await request(`/admin/faqs/${id}/delete`, { method: 'post' })).status, 404);
  assert.equal(filter.association, null);
  assert.equal((await request('/admin/faqs', { method: 'post', csrf: false })).status, 403);
});
test('filtered reorder preserves other categories and rejects foreign or duplicate IDs', async t => {
  const other = new mongoose.Types.ObjectId().toString(), third = new mongoose.Types.ObjectId().toString();
  t.mock.method(Faq, 'find', () => query([{ _id: id, category: 'A' }, { _id: other, category: 'B' }, { _id: third, category: 'A' }]));
  let writes;
  t.mock.method(Faq, 'bulkWrite', async ops => { writes = ops; });
  assert.equal((await request('/admin/faqs/reorder', { method: 'post', body: { ids: [third, id], category: 'A' } })).status, 200);
  assert.deepEqual(writes.map(op => op.updateOne.filter._id), [third, other, id]);
  assert.ok(writes.every(op => op.updateOne.filter.association === null));
  assert.equal((await request('/admin/faqs/reorder', { method: 'post', body: { ids: [id, id] } })).status, 400);
  assert.equal((await request('/admin/faqs/reorder', { method: 'post', body: { ids: [other], category: 'A' } })).status, 409);
});
test('Q&A templates render and escape user content', async () => {
  const locals = { title: 'Q&A', association: { _id: associationId, name: '町内会' }, currentUser: null, showNotificationPrompt: false, assetVersion: 'test', csrfToken: 'token', notice: null, system: false, baseUrl: `/associations/${associationId}/manage/faqs`, categories: ['一般'], category: '', supportUrl: '/support', faqUrl: '/support/faqs', supportContactUrl: '/associations/6aabd0c3e5e589b3df2f6f30/questions', error: null, item: { _id: id, category: '一般', question: '<script>alert(1)</script>', answer: '回答', published: true }, };
  locals.items = [locals.item];
  for (const view of ['faq-form', 'faq-manage', 'faq-public', 'support']) {
    const html = await ejs.renderFile(`src/views/${view}.ejs`, locals);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
  }
});

test('support shows at most ten published common and own Q&As in managed order', async t => {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: associationId, name: '町内会' }));
  let criteria, sort, limit;
  t.mock.method(Faq, 'find', filter => {
    criteria = filter;
    return { sort(value) { sort = value; return this; }, limit(value) { limit = value; return this; }, lean: async () => [{ question: '質問', answer: '回答' }] };
  });
  const result = await request(`/associations/${associationId}/support`, { locals: { dangerMemberships: [{ association: { _id: associationId } }] } });
  assert.equal(result.view, 'support');
  assert.deepEqual(criteria, publishedFaqFilter(associationId));
  assert.deepEqual(sort, { association: 1, position: 1, _id: 1 });
  assert.equal(limit, 10);
  assert.equal(result.data.supportContactUrl, `/associations/${associationId}/questions`);
  assert.equal(result.data.faqUrl, `/associations/${associationId}/faq`);
});
test('Q&A category filter restricts published results but preserves all available categories', async t => {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: associationId }));
  let criteria, categoryCriteria;
  t.mock.method(Faq, 'find', filter => { criteria = filter; return query([]); });
  t.mock.method(Faq, 'distinct', async (field, filter) => { assert.equal(field, 'category'); categoryCriteria = filter; return ['手続き', '一般']; });
  const result = await request(`/associations/${associationId}/faq`, { queryParams: { category: '手続き' } });
  assert.equal(result.view, 'faq-public');
  assert.deepEqual(criteria, { ...publishedFaqFilter(associationId), category: '手続き' });
  assert.deepEqual(categoryCriteria, publishedFaqFilter(associationId));
  assert.equal(result.data.category, '手続き');
  assert.equal(result.data.categories.length, 2);
  await request(`/associations/${associationId}/faq`, { queryParams: { category: { $ne: '' } } });
  assert.deepEqual(criteria, publishedFaqFilter(associationId));
});
test('support entry uses association context and provides common FAQs without membership', async t => {
  assert.equal((await request('/support', { locals: { dangerMemberships: [{ association: { _id: associationId } }] } })).url, `/associations/${associationId}/support`);
  let criteria;
  t.mock.method(Faq, 'find', filter => {
    criteria = filter;
    return { sort() { return this; }, limit() { return this; }, lean: async () => [] };
  });
  const result = await request('/support');
  assert.equal(result.view, 'support');
  assert.deepEqual(criteria, { published: true, association: null });
  assert.equal(result.data.faqUrl, '/support/faqs');
  assert.equal(result.data.supportContactUrl, null);
});

test('support contact uses only active memberships even when viewing another association', async t => {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: associationId }));
  t.mock.method(Faq, 'find', () => ({ sort() { return this; }, limit() { return this; }, lean: async () => [] }));
  const own = new mongoose.Types.ObjectId().toString();
  const result = await request(`/associations/${associationId}/support`, { locals: { dangerMemberships: [{ association: { _id: own } }] } });
  assert.equal(result.data.supportContactUrl, `/associations/${own}/questions`);
  const noMembership = await request(`/associations/${associationId}/support`);
  assert.equal(noMembership.data.supportContactUrl, null);
});

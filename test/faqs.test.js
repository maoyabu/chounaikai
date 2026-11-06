import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import mongoose from 'mongoose';
import { faqsRouter, faqInput, publishedFaqFilter } from '../src/routes/faqs.js';
import { persistFaqImages, uploadFaqImage } from '../src/services/faqImageService.js';
import { v2 as cloudinary } from 'cloudinary';
import { Faq } from '../src/models/faq.js';
import { RoleAssignment } from '../src/models/role.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
const associationId = new mongoose.Types.ObjectId().toString();
const id = new mongoose.Types.ObjectId().toString();
const query = value => ({ sort() { return this; }, populate() { return this; }, lean: async () => value });
const request = (path, { method = 'get', admin = true, body = {}, csrf = true, queryParams = {}, locals = {}, authenticated = true } = {}) => {
  const layer = faqsRouter.stack.find(layer => layer.route?.methods[method] && layer.match(path));
  const req = { headers: {}, params: layer.params, originalUrl: path, user: { _id: id, isAdmin: admin }, isAuthenticated: () => authenticated, body, query: queryParams, session: { csrfToken: 'token' }, get: () => csrf ? 'token' : '' };
  return new Promise(resolve => {
    const res = { set() { return this; }, locals, statusCode: 200, status(code) { this.statusCode = code; return this; }, render(view, data) { resolve({ status: this.statusCode, view, data }); }, json(data) { resolve({ status: this.statusCode, data }); }, redirect(url) { resolve({ status: 302, url }); } };
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

test('open display setting can only be set by the system management form', () => {
  const input = { category: '一般', question: '質問', answer: '回答', openToPublic: 'on' };
  assert.equal(faqInput(input, true).openToPublic, true);
  assert.equal(faqInput({ ...input, openToPublic: undefined }, true).openToPublic, false);
  assert.equal(faqInput(input, false).openToPublic, undefined);
  assert.throws(() => faqInput({ ...input, openToPublic: [] }, true), { status: 400 });
  assert.equal(new Faq().openToPublic, false);
});
test('directory always restricts both results and category names to open published system Q&As', async t => {
  let filter, categories;
  t.mock.method(Faq, 'find', value => { filter = value; return query([]); });
  t.mock.method(Faq, 'distinct', async (_field, value) => { categories = value; return []; });
  for (const authenticated of [false, true]) {
    const result = await request('/faq', { authenticated });
    assert.deepEqual(filter, { published: true, association: null, openToPublic: true });
    assert.deepEqual(categories, filter);
    assert.equal(result.data.directory, true);
    assert.equal(result.data.faqUrl, '/faq');
  }
});
test('anonymous association FAQ and support never disclose login-only Q&As', async t => {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: associationId }));
  let filter;
  t.mock.method(Faq, 'find', value => { filter = value; return { sort() { return this; }, limit() { return this; }, lean: async () => [] }; });
  t.mock.method(Faq, 'distinct', async () => []);
  for (const page of ['faq', 'support']) {
    await request(`/associations/${associationId}/${page}`, { authenticated: false });
    assert.deepEqual(filter, { published: true, association: null, openToPublic: true });
  }
});

test('FAQ image slots replace and remove only after persistence, rolling back uploads on failure', async () => {
  const old = { url: '/old', publicId: 'old' }, added = { url: '/new', publicId: 'new' };
  const deleted = [];
  let saved;
  await persistFaqImages({ previous: [old, old], files: { photo0: [{}] }, body: { removePhoto1: 'on' }, association: associationId,
    upload: async (_file, association) => { assert.equal(association, associationId); return added; },
    remove: async image => { assert.ok(saved); deleted.push(image); }, persist: async images => { saved = images; } });
  assert.deepEqual(saved, [added, null]);
  assert.deepEqual(deleted, [old, old]);
  deleted.length = 0;
  await assert.rejects(persistFaqImages({ previous: [old], files: { photo0: [{}] }, body: {},
    upload: async () => added, remove: async image => deleted.push(image), persist: async () => { throw new Error('DB failure'); } }));
  assert.deepEqual(deleted, [added]);
});
test('system FAQ images are uploaded to Cloudinary', async t => {
  const names = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const previous = names.map(name => process.env[name]);
  names.forEach(name => { process.env[name] = 'test'; });
  t.after(() => names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }));
  t.mock.method(cloudinary, 'config', () => {});
  t.mock.method(cloudinary.uploader, 'upload_stream', (options, callback) => {
    assert.equal(options.resource_type, 'image');
    return { end(buffer) { assert.equal(buffer.toString(), 'image'); callback(null, { secure_url: 'https://example.com/image', public_id: 'faqs/test' }); } };
  });
  assert.deepEqual(await uploadFaqImage({ buffer: Buffer.from('image') }, null), { url: 'https://example.com/image', publicId: 'faqs/test' });
});
test('FAQ Drive images require a stored reference and protect unpublished images', async t => {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: associationId }));
  const path = `/faq-images/${associationId}/drive-file/${'a'.repeat(64)}`;
  t.mock.method(Faq, 'findOne', () => query(null));
  assert.equal((await request(path)).status, 404);
  t.mock.method(Faq, 'findOne', () => query({ published: true }));
  assert.equal((await request(path, { authenticated: false })).status, 403);
  t.mock.method(Faq, 'findOne', () => query({ published: false }));
  t.mock.method(RoleAssignment, 'findOne', () => query(null));
  assert.equal((await request(path, { admin: false })).status, 403);
});

test('HTML answers keep basic formatting and strip executable markup on write and read', async () => {
  const { faqAnswerHtml } = await import('../src/services/faqAnswerService.js');
  const answer = '<h2>見出し</h2><p><strong>強調</strong><a href="javascript:alert(1)" onclick="alert(1)">リンク</a></p><script>alert(1)</script><img src=x onerror=alert(1)><ul><li>項目</li></ul>';
  const result = faqInput({ category: '一般', question: '質問', answer, answerFormat: 'html' });
  assert.equal(result.answerFormat, 'html');
  assert.equal(result.answer, '<h2>見出し</h2><p><strong>強調</strong><a>リンク</a></p><ul><li>項目</li></ul>');
  assert.equal(faqAnswerHtml({ answer, answerFormat: 'html' }), result.answer);
  assert.equal(faqAnswerHtml({ answer: '<b>文字</b>\n次の行' }), '&lt;b&gt;文字&lt;/b&gt;<br>次の行');
  for (const blank of ['<p><br></p>', '<script>alert(1)</script>', '<p>&nbsp;</p>']) {
    assert.throws(() => faqInput({ category: '一般', question: '質問', answer: blank, answerFormat: 'html' }), { status: 400 });
  }
  const html = await ejs.renderFile('src/views/partials/faq-accordion.ejs', { items: [{ question: '質問', answerHtml: result.answer }] });
  assert.ok(html.includes('<h2>見出し</h2>'));
  assert.ok(!html.includes('javascript:'));
});

test('public FAQ renders sanitized HTML for stored formatted answers', async t => {
  t.mock.method(Faq, 'find', () => query([{ question: '質問', answer: '<p><b>回答</b></p><script>bad()</script>', answerFormat: 'html' }]));
  t.mock.method(Faq, 'distinct', async () => []);
  const result = await request('/faq');
  assert.equal(result.data.items[0].answerHtml, '<p><b>回答</b></p>');
});

test('FAQ colors, horizontal rules, headings and paragraph alignment survive safe HTML rendering', async () => {
  const { sanitizeFaqAnswer } = await import('../src/services/faqAnswerService.js');
  const html = '<h1>見出し1</h1><h6>見出し6</h6><hr><p style="text-align:center;color:#ff0000;position:fixed" onclick="bad()"><span style="color:rgb(0, 128, 255);background-image:url(javascript:bad())">色付き</span></p><font color="#00ff00">緑</font>';
  const safe = sanitizeFaqAnswer(html);
  assert.ok(safe.includes('<h1>見出し1</h1>'));
  assert.ok(safe.includes('<h6>見出し6</h6>'));
  assert.match(safe, /<hr\s*\/?\s*>/);
  assert.ok(safe.includes('text-align:center'));
  assert.ok(safe.includes('color:#ff0000'));
  assert.ok(safe.includes('color:rgb(0, 128, 255)'));
  assert.ok(safe.includes('<span style="color:#00ff00">緑</span>'));
  assert.ok(!/position|onclick|background-image|javascript/.test(safe));
  assert.equal(sanitizeFaqAnswer(safe), safe);
});

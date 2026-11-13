import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileQuestionsRouter as router, mobileOwnQuestion } from '../src/routes/mobileQuestions.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleDefinition, RoleAssignment } from '../src/models/role.js';
import { QuestionThread } from '../src/models/questionThread.js';
import { Notification } from '../src/models/notification.js';
import { addQuestionMessage } from '../src/services/questionBoxService.js';
const aid = 'aaaaaaaaaaaaaaaaaaaaaaaa', uid = 'bbbbbbbbbbbbbbbbbbbbbbbb', tid = 'cccccccccccccccccccccccc';
const q = value => ({ select() { return this; }, populate() { return this; }, sort() { return this; }, lean: async () => value, distinct: async () => value });
const route = (path, method = 'get') => router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const req = () => ({ params: { associationId: aid, threadId: tid }, user: { _id: uid }, body: {} });
const res = () => ({ locals: { csrfToken: 'token', questionAssociation: { name: '町内会' } }, set() {}, json(value) { this.value = value; } });
const next = error => { if (error) throw error; };
function access(t) {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => q({ _id: aid, name: '町内会' }));
  t.mock.method(AssociationMembership, 'findOne', () => q({ status: 'active' }));
  t.mock.method(RoleDefinition, 'find', () => q([]));
  t.mock.method(RoleAssignment, 'find', () => q([]));
  t.mock.method(AnnualOfficer, 'exists', async () => false);
  t.mock.method(AnnualOfficer, 'find', () => q([]));
  t.mock.method(AssociationMembership, 'find', () => q([]));
  t.mock.method(Notification, 'updateMany', async () => ({}));
}
test('all routes require login/membership and all writes require CSRF', async t => {
  assert.equal(router.stack[0].handle, requireLogin);
  for (const layer of router.stack.filter(layer => layer.route?.methods.post)) assert.ok(layer.route.stack.some(m => m.handle === verifyCsrfToken));
  access(t);
  await router.stack[2].handle(req(), res(), next);
  AssociationMembership.findOne.mock.mockImplementation(() => q(null));
  await assert.rejects(router.stack[2].handle(req(), res(), next), { status: 403 });
});
test('list is scoped to current author and association and sorted by last update', async t => {
  t.mock.method(QuestionThread, 'find', filter => { assert.deepEqual(filter, { association: aid, author: uid }); return { sort(order) { assert.deepEqual(order, { updatedAt: -1 }); return q([{ _id: tid, title: '質問', status: 'answered', lastOfficerAt: new Date() }]); } }; });
  const response = res(); await route('/')(req(), response, next);
  assert.equal(response.value.threads[0].hasNewAnswer, true);
  assert.equal(response.value.csrfToken, 'token');
  assert.equal(response.value.threads[0].messages, undefined);
});
test('reply badges match unread timestamps and disappear for closed conversations', () => {
  const thread = { _id: tid, status: 'answered', lastOfficerAt: '2026-11-14T00:00:00Z' };
  assert.equal(mobileOwnQuestion(thread).hasNewAnswer, true);
  assert.equal(mobileOwnQuestion({ ...thread, residentReadAt: thread.lastOfficerAt }).hasNewAnswer, false);
  for (const status of ['completed', 'no_reply']) assert.equal(mobileOwnQuestion({ ...thread, status }).hasNewAnswer, false);
});
test('detail hides muted messages and exposes authenticated attachment links only', async t => {
  t.mock.method(QuestionThread, 'findOne', filter => { assert.deepEqual(filter, { _id: tid, association: aid, author: uid }); return q({ _id: tid, association: aid, messages: [
    { _id: 'one', kind: 'officer', body: '回答', sender: { displayname: '役員', email: 'private' }, attachments: [{ originalName: '資料.pdf', fileId: 'file', mimeType: 'application/pdf' }] },
    { _id: 'two', body: 'hidden', mutedAt: new Date() }
  ] }); });
  const response = res(); await route('/:threadId')(req(), response, next);
  assert.equal(response.value.thread.messages.length, 1);
  assert.match(response.value.thread.messages[0].attachments[0].url, /question-attachments\/file$/);
  assert.doesNotMatch(JSON.stringify(response.value), /private|hidden|fileId/);
  QuestionThread.findOne.mock.mockImplementation(() => q(null));
  await assert.rejects(route('/:threadId')(req(), res(), next), { status: 404 });
});
test('new posts use shared validation and save the current author', async t => {
  access(t);
  const create = t.mock.method(QuestionThread, 'create', async value => { assert.equal(value.author, uid); assert.equal(value.association, aid); assert.equal(value.messages[0].kind, 'resident'); return { _id: tid }; });
  const request = req(); request.body = { title: '相談', body: '内容' };
  const response = res(); await route('/', 'post')(request, response, next); assert.equal(response.value.id, tid);
  request.body.body = ''; await assert.rejects(route('/', 'post')(request, res(), next), { status: 400 });
  assert.equal(create.mock.callCount(), 1);
});
test('resident reply reopens the thread and prevents replying to another author or unanswered thread', async t => {
  access(t);
  let status = 'answered';
  t.mock.method(QuestionThread, 'findOne', () => q({ _id: tid, author: uid, status, title: '質問' }));
  const write = t.mock.method(QuestionThread, 'findOneAndUpdate', async (filter, value) => { assert.equal(filter.status, 'answered'); assert.equal(value.$push.messages.kind, 'resident'); assert.equal(value.$set.status, 'unanswered'); return { _id: tid }; });
  const request = req(); request.body.body = '再質問';
  await route('/:threadId/messages', 'post')(request, res(), next);
  status = 'unanswered'; await assert.rejects(route('/:threadId/messages', 'post')(request, res(), next), { status: 409 });
  assert.equal(write.mock.callCount(), 1);
  QuestionThread.findOne.mock.mockImplementation(() => q(null));
  await assert.rejects(route('/:threadId/messages', 'post')(request, res(), next), { status: 404 });
});
test('resident mode cannot become an officer reply if another reply wins a race', async t => {
  access(t); AnnualOfficer.exists.mock.mockImplementation(async () => true);
  t.mock.method(QuestionThread, 'findOne', () => q({ author: uid, status: 'unanswered' }));
  await assert.rejects(addQuestionMessage({ associationId: aid, threadId: tid, userId: uid, body: '再質問', expectedKind: 'resident' }), { status: 409 });
});
test('read acknowledgement targets the exact answer timestamp and rejects newer answers', async t => {
  access(t);
  t.mock.method(QuestionThread, 'findOne', () => q({ _id: tid, author: uid }));
  t.mock.method(QuestionThread, 'updateOne', async filter => { assert.equal(filter.author, uid); assert.equal(filter.association, aid); assert.equal(filter.lastOfficerAt.toISOString(), '2026-11-14T00:00:00.000Z'); return { matchedCount: 1 }; });
  const request = req(); request.body.answerAt = '2026-11-14T00:00:00.000Z';
  await route('/:threadId/read', 'post')(request, res(), next);
  QuestionThread.updateOne.mock.mockImplementation(async () => ({ matchedCount: 0 }));
  await assert.rejects(route('/:threadId/read', 'post')(request, res(), next), { status: 409 });
});
test('no-reply close is author-only and retains the last answer as read', async t => {
  access(t);
  const at = new Date();
  t.mock.method(QuestionThread, 'findOne', () => q({ author: uid, status: 'answered', lastOfficerAt: at }));
  t.mock.method(QuestionThread, 'findOneAndUpdate', async (filter, update) => { assert.equal(filter.author, uid); assert.equal(update.$set.status, 'no_reply'); assert.equal(update.$set.residentReadAt, at); return { _id: tid }; });
  const request = req(); request.body.resolution = 'no_reply';
  await route('/:threadId/close', 'post')(request, res(), next);
  QuestionThread.findOne.mock.mockImplementation(() => q({ author: 'other', status: 'answered' }));
  await assert.rejects(route('/:threadId/close', 'post')(request, res(), next), { status: 403 });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import mongoose from 'mongoose';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleDefinition, RoleAssignment } from '../src/models/role.js';
import { QuestionThread } from '../src/models/questionThread.js';
import { Notification } from '../src/models/notification.js';
import { addQuestionMessage, closeQuestion, loadQuestionBoxAccess } from '../src/services/questionBoxService.js';

const id = () => new mongoose.Types.ObjectId();
const query = value => ({ select() { return this; }, lean: async () => value });
const association = id(), author = id(), officer = id(), threadId = id();
const stubAccess = (t, { isOfficer = false, managerRoles = [] } = {}) => {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: association, name: '中央町内会' }));
  t.mock.method(AssociationMembership, 'findOne', () => query({ association, user: author, status: 'active' }));
  t.mock.method(RoleDefinition, 'find', () => query(managerRoles));
  t.mock.method(AnnualOfficer, 'exists', async () => isOfficer ? { _id: id() } : null);
  t.mock.method(RoleAssignment, 'exists', async () => null);
};

test('only current officers or managers can answer', async t => {
  stubAccess(t);
  const access = await loadQuestionBoxAccess({ associationId: association, userId: author });
  assert.equal(access.canAnswer, false);
  t.mock.method(QuestionThread, 'findOne', () => query({ author, status: 'unanswered', title: '相談' }));
  await assert.rejects(addQuestionMessage({ associationId: association, threadId, userId: author, body: '回答' }), { status: 403 });
});

test('an officer answer updates the thread and notifies its author', async t => {
  stubAccess(t, { isOfficer: true });
  t.mock.method(QuestionThread, 'findOne', () => query({ author, status: 'unanswered', title: '相談' }));
  let change, notice;
  t.mock.method(QuestionThread, 'findOneAndUpdate', async (_filter, update) => { change = update; return { _id: threadId, status: 'answered' }; });
  t.mock.method(Notification, 'create', async value => { notice = value; });
  const result = await addQuestionMessage({ associationId: association, threadId, userId: officer, body: '確認しました' });
  assert.equal(result.status, 'answered');
  assert.equal(change.$push.messages.kind, 'officer');
  assert.equal(change.$set.status, 'answered');
  assert.equal(notice.type, 'question_answered');
  assert.equal(String(notice.recipient), String(author));
});

test('only the author can end a conversation and an ended conversation rejects replies', async t => {
  stubAccess(t, { isOfficer: true });
  t.mock.method(QuestionThread, 'findOne', () => query({ author, status: 'answered', title: '相談', lastOfficerAt: new Date() }));
  let filter, changes;
  t.mock.method(QuestionThread, 'findOneAndUpdate', async (criteria, update) => { filter = criteria; changes = update; return { _id: threadId, status: 'completed' }; });
  await assert.rejects(closeQuestion({ associationId: association, threadId, userId: officer, resolution: 'completed' }), { status: 403 });
  await assert.rejects(closeQuestion({ associationId: association, threadId, userId: author, resolution: 'invalid' }), { status: 400 });
  const closed = await closeQuestion({ associationId: association, threadId, userId: author, resolution: 'completed' });
  assert.equal(closed.status, 'completed');
  assert.equal(filter.status, 'answered');
  assert.equal(changes.$set.status, 'completed');
  assert.ok(changes.$set.residentReadAt instanceof Date);
  t.mock.method(QuestionThread, 'findOne', () => query({ author, status: 'completed', title: '相談' }));
  await assert.rejects(addQuestionMessage({ associationId: association, threadId, userId: officer, body: '追加回答' }), { status: 409 });
});

test('reply not required can close an unanswered conversation', async t => {
  stubAccess(t);
  t.mock.method(QuestionThread, 'findOne', () => query({ author, status: 'unanswered', title: '相談' }));
  let changes;
  t.mock.method(QuestionThread, 'findOneAndUpdate', async (_criteria, update) => { changes = update; return { _id: threadId, status: 'no_reply' }; });
  await closeQuestion({ associationId: association, threadId, userId: author, resolution: 'no_reply' });
  assert.equal(changes.$set.status, 'no_reply');
});

test('resident and officer inboxes render separately with modal conversations', async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const thread = { _id: threadId, title: '相談', author: { displayname: '住人' }, districtGroup: { name: '一班' }, createdAt: new Date(),
    updatedAt: new Date(), status: 'unanswered', residentMessageCount: 2, lastOfficer: { displayname: '役員' },
    messages: [{ kind: 'resident', sender: { displayname: '住人' }, body: '再質問です', createdAt: new Date() }] };
  const values = {
    title: '質問・ご意見箱', currentUser: { displayname: '住人' }, currentRoleTags: [], currentPath: '', notice: null,
    csrfToken: 'token', association: { _id: association, name: '中央町内会' }, canAnswer: true,
    ownThreads: [thread], officerThreads: [thread], openThread: ''
  };
  const residentHtml = await ejs.renderFile(path.join(directory, '../src/views/question-box.ejs'), values);
  const officerHtml = await ejs.renderFile(path.join(directory, '../src/views/question-box-officer.ejs'), values);
  assert.match(residentHtml, /自分の投稿/);
  assert.doesNotMatch(residentHtml, /住人からの質問・ご意見/);
  assert.doesNotMatch(residentHtml, /question-dialog-officer-/);
  assert.match(officerHtml, /住人からの質問・ご意見/);
  assert.doesNotMatch(officerHtml, /役員用/);
  assert.match(officerHtml, /再質問あり/);
  assert.match(officerHtml, /question-dialog-officer-/);
  assert.match(officerHtml, /回答を送信/);
  assert.doesNotMatch(officerHtml, /質問・ご意見を送る/);
});

test('officer menu opens its hub and shows the unanswered count', async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const html = await ejs.renderFile(path.join(directory, '../src/views/partials/header.ejs'), {
    currentUser: { displayname: '役員', email: 'officer@example.test' }, currentRoleTags: [], currentPath: '', csrfToken: 'token',
    currentOfficerQuestionBoxes: [{ _id: association, name: '中央町内会', unansweredCount: 3 }]
  });
  assert.match(html, /役員メニュー/);
  assert.match(html, /class="menu-action-count" aria-label="未回答 3件"/);
  assert.match(html, new RegExp(`/associations/${association}/officer`));
  const hub = await ejs.renderFile(path.join(directory, '../src/views/officer-menu.ejs'), {
    title: '役員メニュー', currentUser: { displayname: '役員', email: 'officer@example.test' }, currentRoleTags: [], currentPath: '', csrfToken: 'token',
    association: { _id: association, name: '中央町内会' }, unansweredCount: 3
  });
  assert.match(hub, /中央町内会　役員メニュー/);
  assert.match(hub, new RegExp(`/associations/${association}/questions/officer`));
  assert.match(hub, /住人からの質問・ご意見/);
  assert.match(hub, /町内会役員から住人への連絡/);
  assert.match(hub, new RegExp(`/associations/${association}/announcements/officer`));
  const clearHtml = await ejs.renderFile(path.join(directory, '../src/views/partials/header.ejs'), {
    currentUser: { displayname: '役員', email: 'officer@example.test' }, currentRoleTags: [], currentPath: '', csrfToken: 'token',
    currentOfficerQuestionBoxes: [{ _id: association, name: '中央町内会', unansweredCount: 0 }]
  });
  assert.doesNotMatch(clearHtml, /menu-action-count|未回答 0件/);
});

test('answered resident thread has a working detail link and renders its answer', async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const answered = { _id: threadId, title: '街灯について', author: { displayname: '住人' }, districtGroup: { name: '一班' }, createdAt: new Date(), status: 'answered', lastOfficerAt: new Date(),
    messages: [{ kind: 'resident', sender: { displayname: '住人' }, body: '街灯が消えています', createdAt: new Date() },
      { kind: 'officer', sender: { displayname: '役員' }, body: '交換を手配しました', createdAt: new Date() }] };
  const values = { title: '質問・ご意見箱', currentUser: { displayname: '住人' }, currentRoleTags: [], currentPath: '', notice: null,
    csrfToken: 'token', association: { _id: association, name: '中央町内会' }, ownThreads: [answered], openThread: '', thread: answered };
  const inbox = await ejs.renderFile(path.join(directory, '../src/views/question-box.ejs'), values);
  const detail = await ejs.renderFile(path.join(directory, '../src/views/question-detail.ejs'), values);
  const officerInbox = await ejs.renderFile(path.join(directory, '../src/views/question-box-officer.ejs'), { ...values, officerThreads: [answered] });
  assert.match(inbox, new RegExp(`/associations/${association}/questions/${threadId}`));
  assert.match(inbox, /内容・回答を見る/);
  assert.match(detail, /交換を手配しました/);
  assert.match(detail, /返信・再質問を送信/);
  assert.match(inbox, /from-resident question-message-own/);
  assert.match(inbox, /from-officer question-message-other/);
  assert.match(officerInbox, /from-officer question-message-own/);
  assert.match(officerInbox, /from-resident question-message-other/);
});

test('ended threads show their resolution without reply controls', async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const thread = { _id: threadId, title: '相談', author: { displayname: '住人' }, createdAt: new Date(), status: 'no_reply', residentMessageCount: 1,
    messages: [{ kind: 'resident', sender: { displayname: '住人' }, body: '相談です', createdAt: new Date() }] };
  const values = { title: '質問・ご意見箱', currentUser: { displayname: '住人' }, currentRoleTags: [], currentPath: '', notice: null,
    csrfToken: 'token', association: { _id: association, name: '中央町内会' }, ownThreads: [thread], officerThreads: [thread], openThread: '', thread };
  const resident = await ejs.renderFile(path.join(directory, '../src/views/question-box.ejs'), values);
  const officerView = await ejs.renderFile(path.join(directory, '../src/views/question-box-officer.ejs'), values);
  assert.match(resident, /返信不要/);
  assert.match(officerView, /返信不要/);
  assert.doesNotMatch(officerView, /回答を送信/);
  const completed = await ejs.renderFile(path.join(directory, '../src/views/question-detail.ejs'), { ...values, thread: { ...thread, status: 'completed' } });
  assert.match(completed, /完了/);
  assert.doesNotMatch(completed, /返信・再質問を送信/);
});

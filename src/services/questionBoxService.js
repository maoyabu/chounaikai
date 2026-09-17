import mongoose from 'mongoose';
import { AssociationMembership } from '../models/associationMembership.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { RoleAssignment, RoleDefinition } from '../models/role.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { QuestionThread } from '../models/questionThread.js';
import { Notification } from '../models/notification.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const fiscalYear = (now = new Date()) => now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
const text = (value, max, label) => {
  const result = String(value || '').trim();
  if (!result || result.length > max) throw fail(`${label}は1〜${max}文字で入力してください。`);
  return result;
};

export const loadQuestionBoxAccess = async ({ associationId, userId, now = new Date() }) => {
  if (!mongoose.isValidObjectId(associationId)) throw fail('町内会を確認してください。', 404);
  const [association, membership] = await Promise.all([
    NeighborhoodAssociation.findOne({ _id: associationId, status: 'active', deletedAt: { $exists: false } }).lean(),
    AssociationMembership.findOne({ association: associationId, user: userId, status: 'active' }).lean()
  ]);
  if (!association || !membership) throw fail('参加中の町内会だけで質問・ご意見箱を利用できます。', 403);
  const managerRoles = await RoleDefinition.find({ association: associationId, active: true, permissions: 'association.manage' }).select('_id').lean();
  const [officer, manager] = await Promise.all([
    AnnualOfficer.exists({ association: associationId, user: userId, fiscalYear: fiscalYear(now), cancelledAt: null }),
    managerRoles.length ? RoleAssignment.exists({ association: associationId, user: userId, role: { $in: managerRoles.map((role) => role._id) }, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] }) : null
  ]);
  return { association, membership, canAnswer: Boolean(officer || manager) };
};

export const createQuestion = async ({ associationId, userId, title, body }) => {
  const { membership } = await loadQuestionBoxAccess({ associationId, userId });
  const now = new Date();
  return QuestionThread.create({ association: associationId, author: userId, districtGroup: membership.districtGroup,
    title: text(title, 120, 'タイトル'), messages: [{ sender: userId, kind: 'resident', body: text(body, 3000, '内容'), createdAt: now }],
    status: 'unanswered', residentMessageCount: 1, lastResidentAt: now });
};

export const addQuestionMessage = async ({ associationId, threadId, userId, body }) => {
  if (!mongoose.isValidObjectId(threadId)) throw fail('投稿を確認してください。', 404);
  const { canAnswer } = await loadQuestionBoxAccess({ associationId, userId });
  const thread = await QuestionThread.findOne({ _id: threadId, association: associationId }).select('author status title').lean();
  if (!thread) throw fail('投稿を確認できません。', 404);
  if (['no_reply', 'completed'].includes(thread.status)) throw fail('このやり取りは終了しています。', 409);
  const isAuthor = String(thread.author) === String(userId);
  const kind = thread.status === 'unanswered' ? 'officer' : 'resident';
  if (kind === 'officer' && !canAnswer) throw fail('回答できるのは当年度の役員または町内会管理者です。', 403);
  if (kind === 'resident' && !isAuthor) throw fail('再質問できるのは投稿者本人です。', 403);
  const now = new Date();
  const message = { sender: userId, kind, body: text(body, 3000, kind === 'officer' ? '回答' : '返信・再質問'), createdAt: now };
  const change = kind === 'officer'
    ? { $push: { messages: message }, $set: { status: 'answered', lastOfficerAt: now, lastOfficer: userId } }
    : { $push: { messages: message }, $set: { status: 'unanswered', lastResidentAt: now }, $inc: { residentMessageCount: 1 } };
  const updated = await QuestionThread.findOneAndUpdate({ _id: threadId, association: associationId, status: thread.status }, change, { new: true });
  if (!updated) throw fail('先に別の返信が届きました。画面を読み直してください。', 409);
  if (kind === 'officer') {
    try {
      await Notification.create({ association: associationId, recipient: thread.author, type: 'question_answered', title: '質問・ご意見箱に回答が届きました', body: `「${thread.title}」に役員から回答が届きました。`, relatedType: 'QuestionThread', relatedId: threadId });
    } catch (error) { console.error('Question answer notification failed', error.message); }
  } else {
    await Notification.updateMany({ recipient: userId, relatedType: 'QuestionThread', relatedId: threadId, type: 'question_answered', readAt: null }, { $set: { readAt: now } });
  }
  return updated;
};

export const closeQuestion = async ({ associationId, threadId, userId, resolution }) => {
  if (!mongoose.isValidObjectId(threadId)) throw fail('投稿を確認してください。', 404);
  if (!['no_reply', 'completed'].includes(resolution)) throw fail('終了方法を選択してください。');
  await loadQuestionBoxAccess({ associationId, userId });
  const thread = await QuestionThread.findOne({ _id: threadId, association: associationId }).select('author status lastOfficerAt').lean();
  if (!thread) throw fail('投稿を確認できません。', 404);
  if (String(thread.author) !== String(userId)) throw fail('終了できるのは投稿者本人です。', 403);
  if (!['unanswered', 'answered'].includes(thread.status)) throw fail('このやり取りは既に終了しています。', 409);
  const changes = { status: resolution, closedAt: new Date() };
  if (thread.lastOfficerAt) changes.residentReadAt = thread.lastOfficerAt;
  const updated = await QuestionThread.findOneAndUpdate({ _id: threadId, association: associationId, author: userId, status: thread.status }, { $set: changes }, { new: true });
  if (!updated) throw fail('先に別の返信が届きました。画面を読み直してください。', 409);
  return updated;
};

export const markQuestionRead = async ({ associationId, threadId, userId, answerAt }) => {
  if (!mongoose.isValidObjectId(threadId)) throw fail('投稿を確認してください。', 404);
  const date = new Date(answerAt);
  if (Number.isNaN(date.getTime())) throw fail('回答日時を確認してください。');
  await loadQuestionBoxAccess({ associationId, userId });
  const result = await QuestionThread.updateOne({ _id: threadId, association: associationId, author: userId, lastOfficerAt: date }, { $set: { residentReadAt: date } });
  if (result.matchedCount) await Notification.updateMany({ recipient: userId, relatedType: 'QuestionThread', relatedId: threadId, type: 'question_answered', readAt: null }, { $set: { readAt: new Date() } });
  return result;
};

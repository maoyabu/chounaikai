import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { acceptAnnouncementAttachments } from '../services/announcementAttachmentService.js';
import { QuestionThread } from '../models/questionThread.js';
import { loadQuestionBoxAccess, createQuestion, addQuestionMessage, closeQuestion, markQuestionRead } from '../services/questionBoxService.js';

const fail = (message, status) => Object.assign(new Error(message), { status });
const handle = callback => async (req, res, next) => { try { await callback(req, res); } catch (error) { next(error); } };
const populate = query => query.populate('districtGroup', 'name').populate('messages.sender', 'displayname username').lean();
export const mobileOwnQuestion = (thread, detail = false) => ({
  id: String(thread._id), title: thread.title, status: thread.status,
  createdAt: thread.createdAt, updatedAt: thread.updatedAt, districtName: thread.districtGroup?.name || '班未設定',
  lastOfficerAt: thread.lastOfficerAt || null,
  hasNewAnswer: ['unanswered', 'answered'].includes(thread.status) && Boolean(thread.lastOfficerAt && (!thread.residentReadAt || new Date(thread.lastOfficerAt) > new Date(thread.residentReadAt))),
  ...(detail ? { messages: (thread.messages || []).filter(message => !message.mutedAt).map(message => ({
    id: String(message._id), kind: message.kind, body: message.body, createdAt: message.createdAt,
    senderName: message.sender?.displayname || message.sender?.username || (message.kind === 'officer' ? '役員' : '住人'),
    attachments: (message.attachments || []).map(file => ({ name: file.originalName, mimeType: file.mimeType || 'application/octet-stream',
      url: `/associations/${thread.association}/question-attachments/${encodeURIComponent(file.fileId)}` }))
  })) } : {})
});
export const ownQuestion = async req => {
  if (!mongoose.isValidObjectId(req.params.threadId)) throw fail('投稿を確認できません。', 404);
  const thread = await populate(QuestionThread.findOne({ _id: req.params.threadId, association: req.params.associationId, author: req.user._id }));
  if (!thread) throw fail('投稿を確認できません。', 404);
  return thread;
};
export const mobileQuestionsRouter = express.Router({ mergeParams: true });
mobileQuestionsRouter.use(requireLogin, provideCsrfToken, async (req, res, next) => {
  try {
    const { association } = await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id });
    res.locals.questionAssociation = association;
    res.set('Cache-Control', 'private, no-store');
    next();
  } catch (error) { next(error); }
});
mobileQuestionsRouter.get('/', handle(async (req, res) => {
  const threads = await populate(QuestionThread.find({ association: req.params.associationId, author: req.user._id }).sort({ updatedAt: -1 }));
  res.json({ associationName: res.locals.questionAssociation.name, threads: threads.map(thread => mobileOwnQuestion(thread)), csrfToken: res.locals.csrfToken });
}));
mobileQuestionsRouter.get('/:threadId', handle(async (req, res) => {
  res.json({ thread: mobileOwnQuestion(await ownQuestion(req), true), csrfToken: res.locals.csrfToken });
}));
mobileQuestionsRouter.post('/', acceptAnnouncementAttachments, verifyCsrfToken, handle(async (req, res) => {
  const thread = await createQuestion({ associationId: req.params.associationId, userId: req.user._id, title: req.body.title, body: req.body.body, files: req.files || [] });
  res.json({ id: String(thread._id) });
}));
mobileQuestionsRouter.post('/:threadId/messages', acceptAnnouncementAttachments, verifyCsrfToken, handle(async (req, res) => {
  const thread = await ownQuestion(req);
  if (thread.status !== 'answered') throw fail('役員からの回答後に返信できます。画面を読み直してください。', 409);
  await addQuestionMessage({ associationId: req.params.associationId, threadId: req.params.threadId, userId: req.user._id, body: req.body.body, files: req.files || [], expectedKind: 'resident' });
  res.json({ success: true });
}));
mobileQuestionsRouter.post('/:threadId/close', verifyCsrfToken, handle(async (req, res) => {
  await closeQuestion({ associationId: req.params.associationId, threadId: req.params.threadId, userId: req.user._id, resolution: req.body.resolution });
  res.json({ success: true });
}));
mobileQuestionsRouter.post('/:threadId/read', verifyCsrfToken, handle(async (req, res) => {
  await ownQuestion(req);
  const result = await markQuestionRead({ associationId: req.params.associationId, threadId: req.params.threadId, userId: req.user._id, answerAt: req.body.answerAt });
  if (!result.matchedCount) throw fail('新しい回答が届いています。画面を読み直してください。', 409);
  res.json({ success: true });
}));

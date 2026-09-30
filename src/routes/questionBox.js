import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { QuestionThread } from '../models/questionThread.js';
import { addQuestionMessage, closeQuestion, createQuestion, loadQuestionBoxAccess, markQuestionRead } from '../services/questionBoxService.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { AnnualDepartmentPlan } from '../models/annualDepartmentPlan.js';

export const questionBoxRouter = express.Router();
questionBoxRouter.use(requireLogin);

const redirectToBox = (res, associationId, open, officer = false) => res.redirect(`/associations/${associationId}/questions${officer ? '/officer' : ''}${open ? `?open=${open}` : ''}`);
const populateThreads = query => query.populate('author', 'displayname username').populate('districtGroup', 'name')
  .populate('lastOfficer', 'displayname username').populate('messages.sender', 'displayname username').sort({ updatedAt: -1 }).lean();
const currentFiscalYear = (now = new Date()) => now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();

questionBoxRouter.get('/:associationId/department-plans', async (req, res, next) => {
  try {
    const { association, canAnswer } = await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id });
    if (!canAnswer) return res.status(403).render('error', { title: 'エラー', message: '役員メニューを開く権限がありません。' });
    const fiscalYear = Number(req.query.year) || currentFiscalYear();
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2200) throw Object.assign(new Error('年度を確認してください。'), { status: 400 });
    const [plans, myOfficer] = await Promise.all([
      AnnualDepartmentPlan.find({ association: association._id, fiscalYear }).populate('department', 'name sortOrder').sort({ createdAt: 1 }).lean(),
      AnnualOfficer.findOne({ association: association._id, fiscalYear, user: req.user._id, cancelledAt: null }).select('department').lean()
    ]);
    return res.render('officer-department-plans', { title: `${association.name} 部会の年度目標`, association, fiscalYear, plans, canEditReports: Boolean(myOfficer) });
  } catch (error) { return next(error); }
});

questionBoxRouter.post('/:associationId/department-plans/:planId/report', verifyCsrfToken, async (req, res, next) => {
  try {
    const { association, canAnswer } = await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id });
    if (!canAnswer) throw Object.assign(new Error('実施報告を入力できる権限がありません。'), { status: 403 });
    const fiscalYear = Number(req.body.fiscalYear), report = String(req.body.report || '').trim();
    const plan = await AnnualDepartmentPlan.findOne({ _id: req.params.planId, association: association._id, fiscalYear });
    const officer = await AnnualOfficer.findOne({ association: association._id, fiscalYear, user: req.user._id, cancelledAt: null }).select('department').lean();
    if (!plan || !officer || String(plan.department) !== String(officer.department)) throw Object.assign(new Error('担当部会の事業計画を確認できません。'), { status: 403 });
    plan.report = report; plan.reportUpdatedBy = req.user._id; await plan.save();
    req.session.notice = '年度の実施報告を保存しました。'; return res.redirect(`/associations/${association._id}/department-plans?year=${fiscalYear}`);
  } catch (error) { return next(error); }
});

questionBoxRouter.get('/:associationId/questions', async (req, res, next) => {
  try {
    const { association } = await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id });
    const ownThreads = await populateThreads(QuestionThread.find({ association: association._id, author: req.user._id }));
    return res.render('question-box', { title: `${association.name} 質問・ご意見箱`, association, ownThreads, openThread: String(req.query.open || '') });
  } catch (error) { return next(error); }
});

questionBoxRouter.get('/:associationId/officer', async (req, res, next) => {
  try {
    const { association, canAnswer } = await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id });
    if (!canAnswer) return res.status(403).render('error', { title: 'エラー', message: '役員メニューを開く権限がありません。' });
    const unansweredCount = await QuestionThread.countDocuments({ association: association._id, status: 'unanswered' });
    return res.render('officer-menu', { title: `${association.name} 役員メニュー`, association, unansweredCount });
  } catch (error) { return next(error); }
});

questionBoxRouter.get('/:associationId/questions/officer', async (req, res, next) => {
  try {
    const { association, canAnswer } = await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id });
    if (!canAnswer) return res.status(403).render('error', { title: 'エラー', message: '役員用の質問・ご意見箱を開く権限がありません。' });
    const officerThreads = await populateThreads(QuestionThread.find({ association: association._id }));
    return res.render('question-box-officer', { title: `${association.name} 役員用 質問・ご意見箱`, association, officerThreads, openThread: String(req.query.open || '') });
  } catch (error) { return next(error); }
});

questionBoxRouter.get('/:associationId/questions/:threadId', async (req, res, next) => {
  try {
    const { association } = await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id });
    if (!mongoose.isValidObjectId(req.params.threadId)) return res.status(404).render('error', { title: 'エラー', message: '投稿を確認できません。' });
    const thread = await QuestionThread.findOne({ _id: req.params.threadId, association: association._id, author: req.user._id })
      .populate('author', 'displayname username').populate('districtGroup', 'name')
      .populate('messages.sender', 'displayname username').lean();
    if (!thread) return res.status(404).render('error', { title: 'エラー', message: '投稿を確認できません。' });
    return res.render('question-detail', { title: `${thread.title} ・ 質問・ご意見箱`, association, thread });
  } catch (error) { return next(error); }
});

questionBoxRouter.post('/:associationId/questions', verifyCsrfToken, async (req, res, next) => {
  try {
    const thread = await createQuestion({ associationId: req.params.associationId, userId: req.user._id, title: req.body.title, body: req.body.body });
    req.session.notice = '質問・ご意見を送信しました。';
    return redirectToBox(res, req.params.associationId, `own-${thread._id}`);
  } catch (error) { return next(error); }
});

questionBoxRouter.post('/:associationId/questions/:threadId/messages', verifyCsrfToken, async (req, res, next) => {
  try {
    const thread = await addQuestionMessage({ associationId: req.params.associationId, threadId: req.params.threadId, userId: req.user._id, body: req.body.body });
    req.session.notice = thread.status === 'answered' ? '回答を送信しました。' : '返信・再質問を送信しました。';
    return redirectToBox(res, req.params.associationId, `${thread.status === 'answered' ? 'officer' : 'own'}-${thread._id}`, thread.status === 'answered');
  } catch (error) { return next(error); }
});

questionBoxRouter.post('/:associationId/questions/:threadId/close', verifyCsrfToken, async (req, res, next) => {
  try {
    const thread = await closeQuestion({ associationId: req.params.associationId, threadId: req.params.threadId, userId: req.user._id, resolution: req.body.resolution });
    req.session.notice = thread.status === 'no_reply' ? '返信不要として終了しました。' : 'やり取りを完了しました。';
    return redirectToBox(res, req.params.associationId, `own-${thread._id}`);
  } catch (error) { return next(error); }
});

questionBoxRouter.post('/:associationId/questions/:threadId/read', verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(404).json({ error: 'association_not_found' });
    const result = await markQuestionRead({ associationId: req.params.associationId, threadId: req.params.threadId, userId: req.user._id, answerAt: req.body.answerAt });
    return res.status(result.matchedCount ? 204 : 409).end();
  } catch (error) { return next(error); }
});

questionBoxRouter.post('/:associationId/questions/:threadId/read-detail', verifyCsrfToken, async (req, res, next) => {
  try {
    await markQuestionRead({ associationId: req.params.associationId, threadId: req.params.threadId, userId: req.user._id, answerAt: req.body.answerAt });
    return res.redirect(`/associations/${req.params.associationId}/questions/${req.params.threadId}`);
  } catch (error) { return next(error); }
});

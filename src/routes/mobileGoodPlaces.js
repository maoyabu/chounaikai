import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { dangerAccess } from '../services/dangerReportService.js';
import { associationFeatureEnabled } from '../services/associationFeatureService.js';
import { GoodPlace } from '../models/goodPlace.js';
import { GoodPlaceComment } from '../models/goodPlaceReaction.js';
import { goodPlaceIdsByLikes, loadGoodPlaceHistoryReactions, loadGoodPlaceReactions, setGoodPlaceLike, addGoodPlaceComment } from '../services/goodPlaceReactionService.js';

export const mobileGoodPlacesRouter = express.Router({ mergeParams: true });
const fail = (message, status) => Object.assign(new Error(message), { status });
const pageNumber = value => Math.max(1, Math.min(100000, parseInt(value, 10) || 1));
export const mobileGoodPlace = report => ({
  id: String(report._id), title: report.title, body: report.body,
  author: report.author?.displayname || '退会したユーザー', createdAt: report.createdAt,
  photoPath: `/associations/${report.association}/good-places/${report._id}/photo`,
  latitude: report.latitude ?? null, longitude: report.longitude ?? null, address: report.address || '',
  commentsEnabled: report.commentsEnabled !== false, likeCount: report.historyReactions?.likeCount || 0,
  commentCount: report.commentCount || 0
});

mobileGoodPlacesRouter.use(requireLogin, async (req, res, next) => {
  try {
    const association = await dangerAccess(req.params.associationId, req.user._id);
    if (!associationFeatureEnabled(association, 'goodPlaces')) throw fail('この町内会では現在この機能を利用していません。', 404);
    res.set('Cache-Control', 'private, no-store');
    next();
  } catch (error) { next(error); }
}, provideCsrfToken);

mobileGoodPlacesRouter.get('/', async (req, res, next) => {
  try {
    const association = req.params.associationId, page = pageNumber(req.query.page);
    let reports;
    if (req.query.sort === 'likes') {
      const ids = await goodPlaceIdsByLikes(association, page);
      const rows = await GoodPlace.find({ association, _id: { $in: ids } }).populate('author', 'displayname').lean();
      const byId = new Map(rows.map(row => [String(row._id), row]));
      reports = ids.map(id => byId.get(String(id))).filter(Boolean);
    } else {
      reports = await GoodPlace.find({ association }).populate('author', 'displayname').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 50).limit(51).lean();
    }
    const rows = await loadGoodPlaceHistoryReactions(association, reports.slice(0, 50));
    const commentCounts = rows.length ? await GoodPlaceComment.aggregate([
      { $match: { association: new mongoose.Types.ObjectId(association), report: { $in: rows.map(row => row._id) }, hiddenAt: null } },
      { $group: { _id: '$report', count: { $sum: 1 } } }
    ]) : [];
    const counts = new Map(commentCounts.map(item => [String(item._id), item.count]));
    for (const row of rows) row.commentCount = counts.get(String(row._id)) || 0;
    res.json({ reports: rows.map(mobileGoodPlace), page, hasNext: reports.length > 50 });
  } catch (error) { next(error); }
});

mobileGoodPlacesRouter.use('/:reportId', (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.reportId)) return next(fail('投稿が見つかりません。', 404));
  next();
});
mobileGoodPlacesRouter.get('/:reportId', async (req, res, next) => {
  try {
    const report = await GoodPlace.findOne({ _id: req.params.reportId, association: req.params.associationId }).populate('author', 'displayname').lean();
    if (!report) throw fail('投稿が見つかりません。', 404);
    // Hidden comments stay hidden in the mobile reader, including for the owner.
    const reactions = await loadGoodPlaceReactions({ associationId: req.params.associationId, reportId: req.params.reportId, userId: req.user._id, owner: false, page: pageNumber(req.query.page) });
    res.json({ report: { ...mobileGoodPlace(report), likeCount: reactions.likeCount, commentCount: reactions.commentCount }, liked: reactions.liked,
      commented: reactions.commented, comments: reactions.comments.map(comment => ({ id: String(comment._id), author: comment.user?.displayname || '退会したユーザー', body: comment.body, createdAt: comment.createdAt })),
      page: reactions.page, hasNext: reactions.hasNext, csrfToken: req.session.csrfToken });
  } catch (error) { next(error); }
});
const input = req => ({ associationId: req.params.associationId, reportId: req.params.reportId, userId: req.user._id });
mobileGoodPlacesRouter.post('/:reportId/like', verifyCsrfToken, async (req, res, next) => {
  try {
    if (!['0', '1'].includes(req.body.liked)) throw fail('いいねの操作を確認してください。', 400);
    await setGoodPlaceLike(input(req), req.body.liked === '1');
    res.sendStatus(204);
  } catch (error) { next(error); }
});
mobileGoodPlacesRouter.post('/:reportId/comments', verifyCsrfToken, async (req, res, next) => {
  try { await addGoodPlaceComment(input(req), req.body.body); res.sendStatus(204); }
  catch (error) { next(error); }
});

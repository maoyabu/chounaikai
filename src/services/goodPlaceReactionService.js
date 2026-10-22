import mongoose from 'mongoose';
import { GoodPlace } from '../models/goodPlace.js';
import { GoodPlaceLike, GoodPlaceComment } from '../models/goodPlaceReaction.js';
import { dangerAccess } from './dangerReportService.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const validId = value => { if (!mongoose.isValidObjectId(value)) throw fail('投稿が見つかりません。', 404); };
export async function reactionAccess({ associationId, reportId, userId }) {
  validId(reportId);
  await dangerAccess(associationId, userId);
  const report = await GoodPlace.findOne({ _id: reportId, association: associationId }).select('author commentsEnabled').lean();
  if (!report) throw fail('投稿が見つかりません。', 404);
  return report;
}
export function parseCommentsEnabled(value) {
  if (value === undefined || value === 'on' || value === 'true' || value === '1') return true;
  if (value === 'off' || value === 'false' || value === '0') return false;
  throw fail('コメントの受付設定を確認してください。');
}
export async function setGoodPlaceLike(input, liked) {
  await reactionAccess(input);
  const filter = { association: input.associationId, report: input.reportId, user: input.userId };
  if (!liked) return GoodPlaceLike.deleteOne(filter);
  try { return await GoodPlaceLike.updateOne(filter, { $setOnInsert: filter }, { upsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; }
}
export async function addGoodPlaceComment(input, body) {
  const report = await reactionAccess(input);
  if (report.commentsEnabled === false) throw fail('この投稿はコメントを受け付けていません。', 403);
  const text = String(body || '').trim();
  if (!text || text.length > 1000) throw fail('コメントは1〜1000文字で入力してください。');
  return GoodPlaceComment.create({ association: input.associationId, report: input.reportId, user: input.userId, body: text });
}
export async function moderateGoodPlaceComment(input, commentId, hidden) {
  validId(commentId);
  const report = await reactionAccess(input);
  if (String(report.author) !== String(input.userId)) throw fail('コメントの表示を変更できるのは投稿者本人です。', 403);
  const result = await GoodPlaceComment.updateOne({ _id: commentId, association: input.associationId, report: input.reportId }, hidden
    ? { $set: { hiddenAt: new Date(), hiddenBy: input.userId } }
    : { $set: { hiddenAt: null }, $unset: { hiddenBy: 1 } });
  if (!result.matchedCount) throw fail('コメントが見つかりません。', 404);
}
export async function loadGoodPlaceReactions({ associationId, reportId, userId, owner, page = 1 }) {
  const filter = { association: associationId, report: reportId };
  const [likeCount, liked, comments] = await Promise.all([
    GoodPlaceLike.countDocuments(filter),
    GoodPlaceLike.exists({ ...filter, user: userId }),
    GoodPlaceComment.find({ ...filter, ...(!owner ? { hiddenAt: null } : {}) }).populate('user', 'displayname').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 50).limit(51).lean()
  ]);
  return { likeCount, liked: Boolean(liked), comments: comments.slice(0, 50), hasNext: comments.length > 50, page, owner };
}

export async function loadGoodPlaceHistoryReactions(associationId, reports) {
  if (!reports.length) return reports;
  const association = new mongoose.Types.ObjectId(String(associationId));
  const counts = await GoodPlaceLike.aggregate([
    { $match: { association, report: { $in: reports.map(report => report._id) } } },
    { $group: { _id: '$report', count: { $sum: 1 } } }
  ]);
  const countById = new Map(counts.map(item => [String(item._id), item.count]));
  return Promise.all(reports.map(async report => ({
    ...report,
    historyReactions: {
      likeCount: countById.get(String(report._id)) || 0,
      comments: await GoodPlaceComment.find({ association: associationId, report: report._id, hiddenAt: null })
        .select('body user createdAt').populate('user', 'displayname').sort({ createdAt: -1, _id: -1 }).limit(2).lean()
    }
  })));
}

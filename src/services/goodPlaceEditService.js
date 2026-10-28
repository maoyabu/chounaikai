import mongoose from 'mongoose';
import { GoodPlace } from '../models/goodPlace.js';
import { dangerAccess, validateDangerReport } from './dangerReportService.js';
import { attachmentContext, saveMessageAttachments, removeMessageAttachments, PICTURE_FOLDER_NAME } from './messageAttachmentService.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export async function loadEditableGoodPlace({ associationId, reportId, userId }) {
  await dangerAccess(associationId, userId);
  if (!mongoose.isValidObjectId(reportId)) throw fail('投稿が見つかりません。', 404);
  const report = await GoodPlace.findOne({ _id: reportId, association: associationId, author: userId }).lean();
  if (!report) throw fail('修正できる投稿が見つかりません。', 404);
  return report;
}
export async function updateGoodPlace({ associationId, reportId, userId, body, file }) {
  const report = await loadEditableGoodPlace({ associationId, reportId, userId });
  const title = String(body.title || '').trim(), content = String(body.body || '').trim();
  if (!title || title.length > 120 || !content || content.length > 3000) throw fail('タイトルは120文字以内、内容は3000文字以内で入力してください。');
  const fields = { title, body: content };
  let context, attachments;
  if (file) {
    if (!file.size || file.size > 10 * 1024 * 1024) throw fail('写真は10MB以下で1枚選択してください。');
    // Check the actual image signature; retain the original location when replacing a photo.
    const validated = validateDangerReport({ title, body: content, locationSource: 'address', address: '写真の検証' }, file);
    fields.photoType = validated.photoType;
    context = await attachmentContext(associationId);
    attachments = await saveMessageAttachments([{ ...file, mimetype: fields.photoType, originalname: `good_place_${Date.now()}.${fields.photoType === 'image/png' ? 'png' : fields.photoType === 'image/webp' ? 'webp' : 'jpg'}` }], { ...context, folderName: PICTURE_FOLDER_NAME });
    fields.photoAttachment = attachments[0];
  }
  let previous;
  try {
    previous = await GoodPlace.findOneAndUpdate({ _id: reportId, association: associationId, author: userId, updatedAt: report.updatedAt }, { $set: fields }, { runValidators: true }).lean();
    if (!previous) throw fail('投稿が変更されました。画面を再読み込みして修正してください。', 409);
  } catch (error) {
    if (attachments) await removeMessageAttachments(attachments, context.client);
    throw error;
  }
  let photoCleanupPending = false;
  if (attachments && previous.photoAttachment?.fileId) {
    try {
      const results = await removeMessageAttachments([previous.photoAttachment], context.client);
      photoCleanupPending = results.some(result => result.status === 'rejected');
    } catch { photoCleanupPending = true; }
  }
  return { photoCleanupPending };
}

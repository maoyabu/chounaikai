import mongoose from 'mongoose';
import { DangerReport } from '../models/dangerReport.js';
import { loadQuestionBoxAccess } from './questionBoxService.js';
import { attachmentContext, removeMessageAttachments } from './messageAttachmentService.js';

const defaults = { model: DangerReport, loadAccess: loadQuestionBoxAccess, attachmentContext, removeMessageAttachments };
export async function deleteDangerReport({ associationId, reportId, userId }, dependencies = defaults) {
  // Recheck the actor's current role on every write, including direct POSTs.
  const { canAnswer } = await dependencies.loadAccess({ associationId, userId });
  if (!canAnswer) throw Object.assign(new Error('緊急・危険情報を削除できるのは役員または町内会管理者です。'), { status: 403 });
  if (!mongoose.isValidObjectId(reportId)) throw Object.assign(new Error('投稿が見つかりません。'), { status: 404 });
  const report = await dependencies.model.findOneAndDelete({ _id: reportId, association: associationId }).lean();
  if (!report) throw Object.assign(new Error('投稿が見つかりません。'), { status: 404 });
  let photoCleanupPending = false;
  if (report.photoAttachment?.fileId) {
    try {
      const context = await dependencies.attachmentContext(associationId);
      const results = await dependencies.removeMessageAttachments([report.photoAttachment], context.client);
      photoCleanupPending = results.some(result => result.status === 'rejected');
    } catch { photoCleanupPending = true; }
  }
  return { photoCleanupPending };
}

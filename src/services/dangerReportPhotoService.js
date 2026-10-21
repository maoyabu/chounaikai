import { DangerReport } from '../models/dangerReport.js';
import { attachmentContext, saveMessageAttachments, removeMessageAttachments } from './messageAttachmentService.js';

const defaults = { attachmentContext, saveMessageAttachments, removeMessageAttachments, model: DangerReport };
const photoFile = (buffer, mimeType) => ({
  buffer, size: buffer.length, mimetype: mimeType,
  originalname: `danger_${Date.now()}.${mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg'}`
});

export async function createDangerReportWithPhoto({ data, association, author }, dependencies = defaults) {
  const { photo, ...fields } = data;
  const context = await dependencies.attachmentContext(association);
  const attachments = await dependencies.saveMessageAttachments([photoFile(photo, data.photoType)], context);
  try {
    return await dependencies.model.create({ ...fields, association, author, photoAttachment: attachments[0] });
  } catch (error) {
    await dependencies.removeMessageAttachments(attachments, context.client);
    throw error;
  }
}

// Move old database photos on first access, without changing the public image URL.
export async function ensureDangerReportDrivePhoto(report, dependencies = defaults) {
  if (report.photoAttachment?.fileId) return report.photoAttachment;
  if (!report.photo) throw Object.assign(new Error('写真が見つかりません。'), { status: 404 });
  const context = await dependencies.attachmentContext(report.association);
  const attachments = await dependencies.saveMessageAttachments([photoFile(Buffer.from(report.photo), report.photoType)], context);
  let result;
  try {
    result = await dependencies.model.updateOne({ _id: report._id, association: report.association, 'photoAttachment.fileId': { $exists: false } }, {
      $set: { photoAttachment: attachments[0] }, $unset: { photo: 1 }
    });
  } catch (error) {
    await dependencies.removeMessageAttachments(attachments, context.client);
    throw error;
  }
  if (result.modifiedCount) return attachments[0];
  // Another request may have migrated the same photo while this upload ran.
  await dependencies.removeMessageAttachments(attachments, context.client);
  const current = await dependencies.model.findOne({ _id: report._id, association: report.association }).select('photoAttachment').lean();
  if (!current?.photoAttachment?.fileId) throw Object.assign(new Error('写真が見つかりません。'), { status: 404 });
  return current.photoAttachment;
}

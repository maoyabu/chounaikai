import { attachmentContext, saveMessageAttachments } from './messageAttachmentService.js';
import { assertDriveItem, driveId } from './driveService.js';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import { OfficerAnnouncement } from '../models/officerAnnouncement.js';

const allowedTypes = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain'
]);

export const repairMojibakeFilename = value => {
  const name = String(value || '');
  // UTF-8をLatin-1として解釈した典型的な文字化けを表示時にも救済する。
  if (!/[ÃÂãåæçèéêëìíîïðñòóôõö÷øùúûüýþ]/.test(name)) return name;
  try {
    const repaired = Buffer.from(name, 'latin1').toString('utf8');
    return repaired.includes('�') ? name : repaired;
  } catch (_error) { return name; }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, callback) => allowedTypes.has(file.mimetype)
    ? callback(null, true)
    : callback(Object.assign(new Error('添付できるファイルはPDF、画像、Word、Excel、PowerPoint、テキストです。'), { status: 400 }))
}).array('attachments', 3);

export const acceptAnnouncementAttachments = (req, res, next) => upload(req, res, error => {
  if (error instanceof multer.MulterError) return next(Object.assign(new Error(error.code === 'LIMIT_FILE_SIZE' ? '添付ファイルは1個15MB以下にしてください。' : '添付ファイルは3個まで登録できます。'), { status: 400 }));
  return error ? next(error) : next();
});

const configureCloudinary = () => {
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey = String(process.env.CLOUDINARY_KEY || process.env.CLOUDINARY_API_KEY || '').trim();
  const apiSecret = String(process.env.CLOUDINARY_SECRET || process.env.CLOUDINARY_API_SECRET || '').trim();
  if (!cloudName || !apiKey || !apiSecret) throw Object.assign(new Error('ファイルアップロードの設定が完了していません。'), { status: 503 });
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
};

export const uploadAnnouncementAttachment = async (file, associationId) => {
  const ctx = await attachmentContext(associationId);
  const [saved] = await saveMessageAttachments([file], ctx);
  return { ...saved, storage: 'drive', publicId: `drive:${saved.fileId}`, resourceType: file.mimetype.startsWith('image/') ? 'image' : 'raw',
    originalName: repairMojibakeFilename(file.originalname),
    url: `/associations/${associationId}/message-attachments/${saved.fileId}` };
};

export const deleteAnnouncementAttachment = async (publicId, resourceType = 'raw', associationId) => {
  if (!publicId) return;
  if (publicId.startsWith('drive:')) {
    const ctx = await attachmentContext(associationId), id = driveId(publicId.slice(6));
    await assertDriveItem(ctx.client, ctx.root, id, { allowRoot: false });
    await (await ctx.client.request(`drive/v3/files/${id}?supportsAllDrives=true`, { method: 'DELETE' })).body?.cancel();
    return;
  }
  configureCloudinary();
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
};

// Cloudinary側の削除とDB側の参照削除を同じ定期処理で行う。
export const deleteExpiredAnnouncementAttachments = async (now = new Date()) => {
  const announcements = await OfficerAnnouncement.find({ 'attachments.expiresAt': { $lte: now } }).select('_id association attachments').lean();
  let deleted = 0;
  for (const announcement of announcements) {
    const expired = announcement.attachments.filter(file => file.expiresAt && new Date(file.expiresAt) <= now);
    if (!expired.length) continue;
    const results = await Promise.allSettled(expired.map(file => deleteAnnouncementAttachment(file.publicId, file.resourceType, announcement.association)));
    const deletedIds = expired.filter((_file, index) => results[index].status === 'fulfilled').map(file => file.publicId);
    if (deletedIds.length) {
      await OfficerAnnouncement.updateOne({ _id: announcement._id }, { $pull: { attachments: { publicId: { $in: deletedIds } } } });
      deleted += deletedIds.length;
    }
  }
  return deleted;
};

import crypto from 'node:crypto';
import { AssociationMembership } from '../models/associationMembership.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { User } from '../models/user.js';
import { attachmentContext, saveMessageAttachments, removeMessageAttachments } from './messageAttachmentService.js';
import multer from 'multer';

const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (imageTypes.has(file.mimetype)) return callback(null, true);
    const error = new Error('画像はJPEG、PNG、WebP、GIF、HEIC形式で選択してください。');
    error.status = 400;
    return callback(error);
  }
}).single('avatar');

export const acceptProfileImage = (req, res, next) => upload(req, res, (error) => {
  if (!error) return next();
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    error.message = '画像のファイルサイズは15MB以下にしてください。';
    error.status = 400;
  }
  return next(error);
});

export const PROFILE_PHOTO_FOLDER = 'プロフィール写真';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const defaults = { AssociationMembership, NeighborhoodAssociation, User, attachmentContext, saveMessageAttachments, removeMessageAttachments };

export const profileImageUrl = (userId, token, baseUrl = process.env.PUBLIC_BASE_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3003')) => {
  let base;
  try { base = new URL(baseUrl); } catch { throw fail('プロフィール写真の保存には公開URLの設定が必要です。', 503); }
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) throw fail('公開URLにはHTTPSを設定してください。', 503);
  return `${base.origin}/profile-images/${userId}/${token}`;
};

// Upload and save the reference as one operation; leave the previous photo intact
// if the database write fails. The URL stays compatible with shared users.avatar.
export const persistProfileImage = async ({ file, userId, associationId, update }, dependencies = defaults) => {
  if (!file?.buffer) {
    await dependencies.User.updateOne({ _id: userId }, { $set: update });
    return update;
  }
  if (!imageTypes.has(file.mimetype) || !file.buffer.length || file.buffer.length > 15 * 1024 * 1024) throw fail('画像は対応形式で15MB以下にしてください。');
  const memberships = await dependencies.AssociationMembership.find({ user: userId, status: 'active' }).select('association').lean();
  const associations = await dependencies.NeighborhoodAssociation.find({ _id: { $in: memberships.map(item => item.association) }, status: 'active', deletedAt: { $exists: false } }).select('_id').lean();
  const association = associationId ? associations.find(item => String(item._id) === String(associationId)) : associations[0];
  if (!association) throw fail('写真の保存先に、参加中の町内会を選択してください。');
  const avatar = profileImageUrl(userId, crypto.randomBytes(32).toString('hex'));
  const previous = await dependencies.User.findById(userId).select('+avatarDriveImage').lean();
  if (!previous) throw fail('ユーザーを確認できません。', 404);
  const context = await dependencies.attachmentContext(association._id);
  const [image] = await dependencies.saveMessageAttachments([{ ...file, size: file.buffer.length }], { ...context, folderName: PROFILE_PHOTO_FOLDER });
  const savedUpdate = { ...update, avatar, avatarDriveImage: { ...image, association: association._id } };
  try {
    const result = await dependencies.User.updateOne({ _id: userId, avatar: previous.avatar ?? null }, { $set: savedUpdate });
    if (result.matchedCount !== 1) throw fail('プロフィールが変更されています。画面を再読み込みしてお試しください。', 409);
  } catch (error) {
    await dependencies.removeMessageAttachments([image], context.client);
    throw error;
  }
  // Existing Cloudinary URLs are retained until the user replaces the photo.
  // Only files tracked as this application's previous Drive photo are removed.
  if (previous.avatarDriveImage?.fileId) {
    try {
      const oldContext = String(previous.avatarDriveImage.association) === String(association._id) ? context : await dependencies.attachmentContext(previous.avatarDriveImage.association);
      await dependencies.removeMessageAttachments([previous.avatarDriveImage], oldContext.client);
    } catch { /* A disconnected old Drive must not undo the saved profile. */ }
  }
  return savedUpdate;
};

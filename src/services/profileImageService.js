import { v2 as cloudinary } from 'cloudinary';
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

const configureCloudinary = () => {
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey = String(process.env.CLOUDINARY_KEY || process.env.CLOUDINARY_API_KEY || '').trim();
  const apiSecret = String(process.env.CLOUDINARY_SECRET || process.env.CLOUDINARY_API_SECRET || '').trim();
  if (!cloudName || !apiKey || !apiSecret) {
    const error = new Error('画像アップロードの設定が完了していません。');
    error.status = 503;
    throw error;
  }
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
};

export const uploadProfileImage = async (file, userId) => {
  if (!file?.buffer) return null;
  configureCloudinary();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      folder: 'profile_avatars', public_id: `user_${userId}_${Date.now()}`, resource_type: 'image', overwrite: false,
      transformation: [{ width: 800, height: 800, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }]
    }, (error, result) => error ? reject(error) : resolve(result?.secure_url || null));
    stream.end(file.buffer);
  });
};

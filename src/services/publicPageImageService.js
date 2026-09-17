import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';

const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, callback) => imageTypes.has(file.mimetype)
    ? callback(null, true)
    : callback(Object.assign(new Error('画像はJPEG、PNG、WebP、GIF、HEIC形式で選択してください。'), { status: 400 }))
}).fields(['photo0', 'photo1', 'photo2'].map(name => ({ name, maxCount: 1 })));

export const acceptPublicPhotos = (req, res, next) => upload(req, res, error => {
  if (error instanceof multer.MulterError) return next(Object.assign(new Error(error.code === 'LIMIT_FILE_SIZE' ? '画像は１枚15MB以下にしてください。' : '写真は３枚まで登録できます。'), { status: 400 }));
  return error ? next(error) : next();
});
const eventUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } }).single('eventImage');
export const acceptEventImage = (req, res, next) => eventUpload(req, res, error => error ? next(Object.assign(new Error('行事画像は15MB以下で選択してください。'), { status: 400 })) : next());
const symbolUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } }).single('symbolImage');
export const acceptSymbolImage = (req, res, next) => symbolUpload(req, res, error => error ? next(Object.assign(new Error('シンボル画像は15MB以下で選択してください。'), { status: 400 })) : next());

const configureCloudinary = () => {
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey = String(process.env.CLOUDINARY_KEY || process.env.CLOUDINARY_API_KEY || '').trim();
  const apiSecret = String(process.env.CLOUDINARY_SECRET || process.env.CLOUDINARY_API_SECRET || '').trim();
  if (!cloudName || !apiKey || !apiSecret) throw Object.assign(new Error('画像アップロードの設定が完了していません。'), { status: 503 });
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
};

export const uploadPublicPhoto = async (file, associationId, slot) => {
  configureCloudinary();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      folder: 'association_public_photos', public_id: `association_${associationId}_${slot}_${Date.now()}`, resource_type: 'image', overwrite: false,
      transformation: [{ width: 1800, height: 1100, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }]
    }, (error, result) => error ? reject(error) : resolve({ url: result.secure_url, publicId: result.public_id }));
    stream.end(file.buffer);
  });
};

export const deletePublicPhoto = async publicId => {
  if (!publicId) return;
  configureCloudinary();
  await cloudinary.uploader.destroy(publicId);
};

import crypto from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { uploadPublicPhoto, deletePublicPhoto } from './publicPageImageService.js';

export const uploadFaqImage = async (file, association) => {
  if (association) {
    const image = await uploadPublicPhoto(file, association);
    return { ...image, url: image.url.replace('/public-photos/', '/faq-images/') };
  }
  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  const api_key = process.env.CLOUDINARY_KEY || process.env.CLOUDINARY_API_KEY;
  const api_secret = process.env.CLOUDINARY_SECRET || process.env.CLOUDINARY_API_SECRET;
  if (!cloud_name || !api_key || !api_secret) throw Object.assign(new Error('画像アップロードの設定が完了していません。'), { status: 503 });
  cloudinary.config({ cloud_name, api_key, api_secret, secure: true });
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ resource_type: 'image', folder: 'faqs', public_id: crypto.randomUUID() }, (error, result) => {
      if (error) return reject(Object.assign(new Error('画像を保存できませんでした。'), { status: 502 }));
      resolve({ url: result.secure_url, publicId: result.public_id });
    });
    stream.end(file.buffer);
  });
};
export const faqImageSizes = body => Array.from({ length: 3 }, (_, slot) => {
  const size = body[`photoSize${slot}`];
  if (size !== undefined && !['large', 'medium', 'small'].includes(size)) {
    throw Object.assign(new Error('画像サイズは大・中・小から選択してください。'), { status: 400 });
  }
  return size;
});
export const deleteFaqImage = image => deletePublicPhoto(image?.publicId);
export const persistFaqImages = async ({ files = {}, body, previous = [], association, persist, upload = uploadFaqImage, remove = deleteFaqImage }) => {
  const sizes = faqImageSizes(body);
  const images = [...previous], added = [], removed = [];
  try {
    for (let slot = 0; slot < 3; slot++) {
      const file = files[`photo${slot}`]?.[0];
      if (!file && body[`removePhoto${slot}`] !== 'on') {
        if (images[slot] && sizes[slot]) images[slot] = { ...images[slot], size: sizes[slot] };
        continue;
      }
      if (images[slot]?.publicId) removed.push(images[slot]);
      images[slot] = file ? await upload(file, association) : null;
      if (images[slot]) {
        images[slot] = { ...images[slot], size: sizes[slot] || previous[slot]?.size || 'large' };
        added.push(images[slot]);
      }
    }
    await persist(images);
  } catch (error) {
    await Promise.allSettled(added.map(remove));
    throw error;
  }
  await Promise.allSettled(removed.map(remove));
};

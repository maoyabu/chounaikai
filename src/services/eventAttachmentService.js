import { uploadAnnouncementAttachment, deleteAnnouncementAttachment } from './announcementAttachmentService.js';
export const uploadEventImage = async (file, association) => {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'].includes(file.mimetype)) throw Object.assign(new Error('行事画像はJPEG、PNG、WebP、GIF、HEIC形式で選択してください。'), { status: 400 });
  const saved = await uploadAnnouncementAttachment(file, association);
  return { ...saved, url: `/associations/${association}/event-images/${saved.fileId}` };
};
export const deleteEventImage = (image, association) => image?.publicId ? deleteAnnouncementAttachment(image.publicId, 'image', association) : Promise.resolve();

// Save the database reference before deleting a replaced image. Roll back new
// uploads if the database write fails, keeping the previous image available.
export const persistEventImage = async ({ file, association, previousImage, persist }) => {
  const image = file ? await uploadEventImage(file, association) : null;
  let result;
  try { result = await persist(image); }
  catch (error) { if (image) await deleteEventImage(image, association).catch(() => {}); throw error; }
  if (image && previousImage) await deleteEventImage(previousImage, association).catch(() => {});
  return result;
};

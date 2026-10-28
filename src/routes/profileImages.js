import express from 'express';
import mongoose from 'mongoose';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { User } from '../models/user.js';
import { attachmentContext } from '../services/messageAttachmentService.js';
import { assertDriveItem, driveId } from '../services/driveService.js';

export const profileImagesRouter = express.Router();
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

// Photos also appear on public officer pages and in the shared account service.
// An unguessable URL keeps that behavior without making the Drive file public.
export const profileImageHandler = (dependencies = { User, attachmentContext, assertDriveItem }) => async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    if (!mongoose.isValidObjectId(req.params.userId) || !/^[a-f0-9]{64}$/.test(req.params.token)) return res.sendStatus(404);
    const user = await dependencies.User.findById(req.params.userId).select('avatar +avatarDriveImage').lean();
    const expectedPath = `/profile-images/${req.params.userId}/${req.params.token}`;
    if (!user?.avatarDriveImage?.fileId || !user.avatar || new URL(user.avatar).pathname !== expectedPath) return res.sendStatus(404);
    const image = user.avatarDriveImage;
    const context = await dependencies.attachmentContext(image.association);
    const item = await dependencies.assertDriveItem(context.client, context.root, image.fileId, { allowRoot: false });
    if (!imageTypes.has(item.mimeType) || item.capabilities?.canDownload === false) return res.sendStatus(404);
    const response = await context.client.request(`drive/v3/files/${driveId(image.fileId)}?alt=media&supportsAllDrives=true`);
    res.set({ 'Content-Type': item.mimeType, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) { next(error); }
};
profileImagesRouter.get('/profile-images/:userId/:token', profileImageHandler());

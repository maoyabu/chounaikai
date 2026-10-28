import mongoose from 'mongoose';
import { GoodPlace } from '../models/goodPlace.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { createDangerReportWithPhoto } from './dangerReportPhotoService.js';
import { queueDangerReportNotifications } from './dangerReportNotificationService.js';
import { deleteDangerReport } from './dangerReportDeletionService.js';
import { attachmentContext, saveMessageAttachments, removeMessageAttachments, PICTURE_FOLDER_NAME } from './messageAttachmentService.js';
import { loadQuestionBoxAccess } from './questionBoxService.js';

export async function loadGoodPlaceAssociation(id) {
  if (!mongoose.isValidObjectId(id)) throw Object.assign(new Error('町内会が見つかりません。'), { status: 404 });
  const association = await NeighborhoodAssociation.findOne({ _id: id, status: 'active', deletedAt: { $exists: false } }).lean();
  if (!association) throw Object.assign(new Error('町内会が見つかりません。'), { status: 404 });
  return association;
}
export const createGoodPlaceWithPhoto = input => createDangerReportWithPhoto({ ...input, photoPrefix: 'good_place' }, {
  model: GoodPlace, attachmentContext,
  saveMessageAttachments: (files, context) => saveMessageAttachments(files, { ...context, folderName: PICTURE_FOLDER_NAME }),
  removeMessageAttachments
});
export const queueGoodPlaceNotifications = report => queueDangerReportNotifications(report, { type: 'good_place', label: 'わがまちのいいところ', relatedType: 'GoodPlace' });
export const deleteGoodPlace = input => deleteDangerReport({ ...input, label: 'いいところ投稿', allowAuthor: true }, { model: GoodPlace, loadAccess: loadQuestionBoxAccess, attachmentContext, removeMessageAttachments });

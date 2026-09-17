import express from 'express';
import mongoose from 'mongoose';
import { requireLogin, requirePermission } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { AssociationEvent } from '../models/associationEvent.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { loadQuestionBoxAccess } from '../services/questionBoxService.js';
import { eventValues } from '../services/associationEventService.js';
import { loadAssociationPageData } from '../services/associationPublicPageService.js';
import { acceptPublicPhotos, acceptEventImage, uploadPublicPhoto, deletePublicPhoto } from '../services/publicPageImageService.js';

export const associationEventsRouter = express.Router();
const notFound = () => Object.assign(new Error('行事を確認できません。'), { status: 404 });
const officerAccess = async req => {
  const access = await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id });
  if (!access.canAnswer && !req.user.isAdmin) throw Object.assign(new Error('役員だけが行事を管理できます。'), { status: 403 });
  return access.association;
};

associationEventsRouter.get('/:associationId/public', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) throw notFound();
    const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
    if (!association) throw notFound();
    const pageData = await loadAssociationPageData(association, { month: req.query.month });
    return res.render('association-public-events', { title: `${association.name} 町内会について`, association, ...pageData });
  } catch (error) { return next(error); }
});

associationEventsRouter.get('/:associationId/public/edit', requireLogin, requirePermission('association.manage'), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) throw notFound();
    const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
    if (!association) throw notFound();
    return res.render('association-public-edit', { title: `${association.name} 公開ページ編集`, association });
  } catch (error) { return next(error); }
});

associationEventsRouter.post('/:associationId/public/edit', requireLogin, requirePermission('association.manage'), acceptPublicPhotos, verifyCsrfToken, async (req, res, next) => {
  const uploaded = [];
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) throw notFound();
    const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } });
    if (!association) throw notFound();
    const introduction = String(req.body.introduction || '').trim();
    if (introduction.length > 5000) throw Object.assign(new Error('基本情報は5000文字以内で入力してください。'), { status: 400 });
    const photos = Array.from({ length: 3 }, (_, slot) => association.publicPhotos?.[slot] || null);
    const replaced = [];
    for (let slot = 0; slot < 3; slot++) {
      const file = req.files?.[`photo${slot}`]?.[0];
      if (file) {
        const photo = await uploadPublicPhoto(file, association._id, slot);
        uploaded.push(photo);
        if (photos[slot]?.publicId) replaced.push(photos[slot].publicId);
        photos[slot] = photo;
      } else if (req.body[`remove${slot}`] === 'on') {
        if (photos[slot]?.publicId) replaced.push(photos[slot].publicId);
        photos[slot] = null;
      }
    }
    association.introduction = introduction;
    association.publicPhotos = photos;
    await association.save();
    await Promise.allSettled(replaced.map(deletePublicPhoto));
    req.session.notice = '公開ページを更新しました。';
    return res.redirect(`/associations/${association._id}/public/edit`);
  } catch (error) {
    await Promise.allSettled(uploaded.map(photo => deletePublicPhoto(photo.publicId)));
    return next(error);
  }
});

associationEventsRouter.get('/:associationId/events/manage', requireLogin, async (req, res, next) => {
  try {
    const association = await officerAccess(req);
    const events = await AssociationEvent.find({ association: association._id }).sort({ startDate: -1, startTime: -1 }).lean();
    const categories = [...new Set([...(association.eventCategories || []), ...events.map(event => event.category)])].sort((a, b) => a.localeCompare(b, 'ja'));
    return res.render('association-events-manage', { title: `${association.name} 町内会行事管理`, association, events, categories });
  } catch (error) { return next(error); }
});

associationEventsRouter.post('/:associationId/events', requireLogin, acceptEventImage, verifyCsrfToken, async (req, res, next) => {
  try {
    const association = await officerAccess(req);
    const values = eventValues(req.body);
    if (req.file) values.image = await uploadPublicPhoto(req.file, association._id, `event-${Date.now()}`);
    await AssociationEvent.create({ association: association._id, ...values });
    await NeighborhoodAssociation.updateOne({ _id: association._id }, { $addToSet: { eventCategories: values.category } });
    req.session.notice = '行事を登録しました。';
    return res.redirect(`/associations/${association._id}/events/manage`);
  } catch (error) { return next(error); }
});

associationEventsRouter.post('/:associationId/events/:eventId', requireLogin, acceptEventImage, verifyCsrfToken, async (req, res, next) => {
  try {
    const association = await officerAccess(req);
    if (!mongoose.isValidObjectId(req.params.eventId)) throw notFound();
    const values = eventValues(req.body);
    if (req.file) values.image = await uploadPublicPhoto(req.file, association._id, `event-${req.params.eventId}`);
    const event = await AssociationEvent.findOneAndUpdate({ _id: req.params.eventId, association: association._id }, { $set: values });
    if (!event) throw notFound();
    await NeighborhoodAssociation.updateOne({ _id: association._id }, { $addToSet: { eventCategories: values.category } });
    req.session.notice = '行事を更新しました。';
    return res.redirect(`/associations/${association._id}/events/manage`);
  } catch (error) { return next(error); }
});

associationEventsRouter.post('/:associationId/events/:eventId/complete', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try {
    const association = await officerAccess(req);
    if (!mongoose.isValidObjectId(req.params.eventId)) throw notFound();
    const event = await AssociationEvent.findOneAndUpdate({ _id: req.params.eventId, association: association._id }, { $set: { completed: req.body.completed === 'on' } });
    if (!event) throw notFound();
    req.session.notice = req.body.completed === 'on' ? '行事を完了にしました。' : '完了を取り消しました。';
    return res.redirect(`/associations/${association._id}/events/manage`);
  } catch (error) { return next(error); }
});

associationEventsRouter.post('/:associationId/events/:eventId/delete', requireLogin, verifyCsrfToken, async (req, res, next) => {
  try {
    const association = await officerAccess(req);
    if (!mongoose.isValidObjectId(req.params.eventId)) throw notFound();
    const result = await AssociationEvent.deleteOne({ _id: req.params.eventId, association: association._id });
    if (!result.deletedCount) throw notFound();
    req.session.notice = '行事を削除しました。';
    return res.redirect(`/associations/${association._id}/events/manage`);
  } catch (error) { return next(error); }
});

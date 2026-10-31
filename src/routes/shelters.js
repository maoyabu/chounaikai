import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { acceptPublicPhotos } from '../services/publicPageImageService.js';
import { requireShelterOfficer, saveShelter, removeShelter, saveShelterInformation } from '../services/shelterService.js';

export const sheltersRouter = express.Router();
sheltersRouter.use(requireLogin);
const officer = async (req, res, next) => {
  try { await requireShelterOfficer(req.params.associationId, req.user._id); return next(); }
  catch (error) { return next(error); }
};
const back = (res, id) => res.redirect(`/associations/${id}/alert-level?tab=shelters`);

sheltersRouter.get('/:associationId/shelters', async (req, res, next) => {
  try {
    const selected = req.query.selected ? `&selected=${encodeURIComponent(String(req.query.selected))}` : '';
    return res.redirect(`/associations/${req.params.associationId}/disaster?tab=shelters${selected}`);
  } catch (error) { return next(error); }
});

sheltersRouter.post('/:associationId/shelters/information', verifyCsrfToken, async (req, res, next) => {
  try {
    await saveShelterInformation(req.params.associationId, req.user._id, req.body);
    req.session.notice = '公共の指定避難所の情報ページを保存しました。';
    return back(res, req.params.associationId);
  } catch (error) { return next(error); }
});

for (const path of ['/:associationId/shelters', '/:associationId/shelters/:shelterId/update']) {
  sheltersRouter.post(path, officer, acceptPublicPhotos, verifyCsrfToken, async (req, res, next) => {
    try {
      await saveShelter({ ...req.params, userId: req.user._id, body: req.body, files: req.files });
      req.session.notice = req.params.shelterId ? '避難所を更新しました。' : '避難所を登録しました。';
      return back(res, req.params.associationId);
    } catch (error) { return next(error); }
  });
}
sheltersRouter.post('/:associationId/shelters/:shelterId/delete', verifyCsrfToken, async (req, res, next) => {
  try {
    await removeShelter(req.params.associationId, req.params.shelterId, req.user._id);
    req.session.notice = '避難所を一覧から削除しました。'; return back(res, req.params.associationId);
  } catch (error) { return next(error); }
});

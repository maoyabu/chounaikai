import crypto from 'node:crypto';
import express from 'express';
import mongoose from 'mongoose';
import { requireLogin, requirePermission } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { LocationLinkRequest } from '../models/locationLinkRequest.js';
import { loadLocationLink, applyLocationLink, locationLinkPresentation, locationId } from '../services/locationLinkService.js';
import { notifyResponsible, queueNotice } from '../services/notificationRecipients.js';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const backUrl = input => input.manager ? `/associations/${input.associationId}/manage/annual${input.target?.fiscalYear ? `?year=${input.target.fiscalYear}` : ''}` : `/associations/${input.associationId}/leader/fees`;
const issueConfirmation = (req, context, action) => {
  const token = crypto.randomBytes(24).toString('hex');
  const confirmations = req.session.locationLinkConfirmations ||= {};
  for (const [key, value] of Object.entries(confirmations)) if (value.expiresAt < Date.now()) delete confirmations[key];
  if (Object.keys(confirmations).length >= 20) delete confirmations[Object.keys(confirmations)[0]];
  confirmations[token] = { fingerprint: context.fingerprint, action, actor: locationId(req.user), userId: locationId(context.userId), recordId: locationId(context.recordId), kind: context.kind, expiresAt: Date.now() + 15 * 60000 };
  return token;
};
const consumeConfirmation = (req, context, action) => {
  const token = String(req.body.confirmationToken || ''), stored = req.session.locationLinkConfirmations?.[token];
  if (!stored || stored.expiresAt < Date.now() || stored.action !== action || stored.actor !== locationId(req.user) || stored.userId !== locationId(context.userId) || stored.recordId !== locationId(context.recordId) || stored.kind !== context.kind || stored.fingerprint !== context.fingerprint) throw fail('確認画面の有効期限が切れたか、情報が変更されました。紐付けをやり直してください。');
  delete req.session.locationLinkConfirmations[token];
};
const renderConfirmation = (req, res, context, action, extras = {}) => {
  res.set('Cache-Control', 'private, no-store');
  return res.render('location-link-confirm', { title: '地区・班の不一致を確認', ...locationLinkPresentation(context), action, userId: context.userId, householdId: context.kind === 'ledger' ? context.recordId : '', backUrl: backUrl(context), confirmationToken: issueConfirmation(req, context, action), requestedDistrict: '', ...extras });
};

// Called only after the existing manager/leader authentication middleware.
export const handleLocationLink = async (req, res, { kind, recordId, manager }) => {
  const input = { associationId: req.params.associationId, userId: req.body.userId, kind, recordId, actorId: req.user._id, manager };
  const context = await loadLocationLink(input);
  const action = req.originalUrl.split('?')[0];
  if (context.conflict || req.body.confirmationToken) {
    if (!req.body.confirmationToken) return renderConfirmation(req, res, context, action);
    consumeConfirmation(req, context, action);
    if (!context.choices.some(choice => choice.id === req.body.districtId)) throw fail('地区・班を選択してください。', 400);
    if (!manager) {
      if (await LocationLinkRequest.exists({ association: input.associationId, requestedBy: input.actorId, user: input.userId, household: input.recordId, status: 'pending' })) throw fail('この会員と世帯には管理者の確認待ちの依頼があります。管理者の確認をお待ちください。');
      const request = await LocationLinkRequest.create({ association: input.associationId, requestedBy: input.actorId, user: input.userId, household: input.recordId, districtGroup: req.body.districtId, fingerprint: context.fingerprint });
      await notifyResponsible({ association: input.associationId, type: 'location_link_requested', title: '地区・班の統一と会員紐付けの確認依頼が届きました', relatedId: request._id });
      req.session.notice = '管理者に地区・班の確認を依頼しました。承認まで会員の紐付けは保留になります。';
      return res.redirect(backUrl(input));
    }
  }
  const districtId = context.conflict ? req.body.districtId : context.choices[0]?.id;
  await applyLocationLink(input, { fingerprint: context.fingerprint, districtId });
  if (manager) await queueNotice({ association: input.associationId, recipients: [input.userId], type: kind === 'leader' ? 'district_leader_assigned' : 'officer_assigned', title: '地区・班を確認して会員を紐付けました', relatedId: input.recordId });
  req.session.notice = '地区・班を統一して会員を紐付けました。';
  return res.redirect(backUrl(context));
};

export const locationLinksRouter = express.Router();
locationLinksRouter.use(requireLogin);
locationLinksRouter.get('/:associationId/manage/location-links', requirePermission('role.manage'), async (req, res, next) => {
  try {
    const requests = await LocationLinkRequest.find({ association: req.params.associationId, status: 'pending' }).populate('requestedBy', 'displayname username').populate('user', 'displayname username').populate('districtGroup', 'name').sort({ createdAt: 1 }).lean();
    res.set('Cache-Control', 'private, no-store');
    return res.render('location-link-requests', { title: '地区・班の確認依頼', associationId: req.params.associationId, requests });
  } catch (error) { return next(error); }
});
const loadRequest = async req => {
  if (!mongoose.isValidObjectId(req.params.requestId)) throw fail('確認依頼を確認できません。', 404);
  const request = await LocationLinkRequest.findOne({ _id: req.params.requestId, association: req.params.associationId, status: 'pending' }).lean();
  if (!request) throw fail('処理待ちの確認依頼がありません。', 404);
  // The requester must still be an active leader of the source ledger.
  const input = { associationId: req.params.associationId, userId: request.user, kind: 'ledger', recordId: request.household, actorId: request.requestedBy, manager: false };
  const context = await loadLocationLink(input);
  if (context.fingerprint !== request.fingerprint) throw fail('申請後に情報が変更されました。この依頼を却下し、班長に再度紐付けを依頼してください。');
  return { request, input: { ...input, actorId: req.user._id, manager: true }, context: { ...context, manager: true } };
};
locationLinksRouter.get('/:associationId/manage/location-links/:requestId', requirePermission('role.manage'), async (req, res, next) => {
  try {
    const { request, context } = await loadRequest(req);
    const action = `/associations/${req.params.associationId}/manage/location-links/${request._id}/approve`;
    return renderConfirmation(req, res, context, action, { backUrl: `/associations/${req.params.associationId}/manage/location-links`, requestedDistrict: locationId(request.districtGroup) });
  } catch (error) { return next(error); }
});
locationLinksRouter.post('/:associationId/manage/location-links/:requestId/approve', requirePermission('role.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const { request, context, input } = await loadRequest(req);
    consumeConfirmation(req, context, req.originalUrl.split('?')[0]);
    await applyLocationLink(input, { fingerprint: request.fingerprint, districtId: req.body.districtId, approvedRequest: request });
    await queueNotice({ association: input.associationId, recipients: [request.requestedBy], type: 'location_link_decided', title: '地区・班を統一し、会員の紐付けを承認しました', relatedId: request._id });
    req.session.notice = '地区・班を統一し、会員を紐付けました。';
    return res.redirect(`/associations/${input.associationId}/manage/location-links`);
  } catch (error) { return next(error); }
});
locationLinksRouter.post('/:associationId/manage/location-links/:requestId/reject', requirePermission('role.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.requestId)) throw fail('確認依頼を確認してください。', 400);
    const request = await LocationLinkRequest.findOneAndUpdate({ _id: req.params.requestId, association: req.params.associationId, status: 'pending' }, { $set: { status: 'rejected', decidedBy: req.user._id, decidedAt: new Date() } }, { new: true });
    if (!request) throw fail('この確認依頼は処理済みです。');
    await queueNotice({ association: req.params.associationId, recipients: [request.requestedBy], type: 'location_link_decided', title: '地区・班の確認依頼が却下されました。登録情報をご確認ください', relatedId: request._id });
    req.session.notice = '確認依頼を却下しました。会員の紐付けは行っていません。';
    return res.redirect(`/associations/${req.params.associationId}/manage/location-links`);
  } catch (error) { return next(error); }
});

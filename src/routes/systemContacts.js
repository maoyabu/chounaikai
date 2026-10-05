import multer from 'multer';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { attachmentContext, saveMessageAttachments, removeMessageAttachments } from '../services/messageAttachmentService.js';
import { assertDriveItem, driveId, FOLDER_MIME } from '../services/driveService.js';
import express from 'express';
import mongoose from 'mongoose';
import { requireLogin, requirePermission, requireSystemAdmin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { SystemContact } from '../models/systemContact.js';
import { User } from '../models/user.js';
import { queueNotice, notifyResponsible } from '../services/notificationRecipients.js';

export const systemContactsRouter = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 3, fields: 5, fieldSize: 25000 } }).array('attachments', 3);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const contactText = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw fail('件名・本文の入力内容を確認してください。');
  return value.trim();
};
export const contactUrgency = value => {
  const urgency = Number(value);
  if (!Number.isInteger(urgency) || urgency < 1 || urgency > 5) throw fail('緊急度を1〜5で指定してください。');
  return urgency;
};
const notify = async (thread, system, actor) => {
  const options = { association: thread.association, type: 'system_contact', title: `システム管理者への連絡：${thread.title}`, relatedId: thread._id };
  if (system) await notifyResponsible({ ...options, exclude: [actor] });
  else {
    const recipients = await User.find({ isAdmin: true, unsubscribe_date: null, _id: { $ne: actor } }).distinct('_id');
    await queueNotice({ ...options, recipients });
  }
};
for (const system of [false, true]) {
  const base = system ? '/admin/system-contacts' : '/associations/:associationId/manage/system-contacts';
  const guard = system ? requireSystemAdmin : requirePermission('association.manage');
  const url = req => system ? base : `/associations/${req.params.associationId}/manage/system-contacts`;
  const scope = req => system ? {} : { association: req.params.associationId };
  const wrap = handler => async (req, res, next) => { try { await handler(req, res); } catch (error) { next(error instanceof multer.MulterError ? fail('添付ファイルは3個まで、1個15MB以下で選択してください。') : error); } };
  const association = async req => {
    if (system) return null;
    const result = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
    if (!result) throw fail('町内会を確認できません。', 404);
    return result;
  };
  const load = async req => {
    await association(req);
    if (!mongoose.isValidObjectId(req.params.contactId)) throw fail('連絡を確認できません。', 404);
    const thread = await SystemContact.findOne({ _id: req.params.contactId, ...scope(req) }).populate('association', 'name').populate('messages.sender', 'displayname username').lean();
    if (!thread) throw fail('連絡を確認できません。', 404);
    return thread;
  };
  systemContactsRouter.get(base, requireLogin, guard, wrap(async (req, res) => {
    const assoc = await association(req);
    const threads = await SystemContact.find(scope(req)).populate('association', 'name').sort({ updatedAt: -1 }).lean();
    res.render('system-contacts', { title: '町内会役員からシステム管理者への連絡', association: assoc, threads, system, baseUrl: url(req) });
  }));
  if (!system) systemContactsRouter.post(base, requireLogin, guard, wrap(async (req, res) => {
    await association(req);
    await new Promise((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
    let csrfValid = false;
    verifyCsrfToken(req, res, () => { csrfValid = true; });
    if (!csrfValid) return;
    const title = contactText(req.body.title, 120), body = contactText(req.body.body, 5000), urgency = contactUrgency(req.body.urgency);
    const files = req.files || [];
    const ctx = files.length ? await attachmentContext(req.params.associationId) : null;
    const attachments = ctx ? await saveMessageAttachments(files, ctx) : [];
    let thread;
    try {
      thread = await SystemContact.create({ association: req.params.associationId, title, urgency, associationReadAt: new Date(), messages: [{ sender: req.user._id, kind: 'association', body, attachments }] });
    } catch (error) {
      if (ctx) await removeMessageAttachments(attachments, ctx.client);
      throw error;
    }
    await notify(thread, false, req.user._id);
    req.session.notice = 'システム管理者へ連絡を送りました。';
    res.redirect(`${url(req)}/${thread._id}`);
  }));
  systemContactsRouter.get(`${base}/:contactId/attachments/:fileId`, requireLogin, guard, wrap(async (req, res) => {
    const thread = await load(req);
    const attachment = thread.messages.flatMap(message => message.attachments || []).find(item => item.fileId === req.params.fileId);
    if (!attachment || !thread.association?._id) throw fail('添付ファイルを確認できません。', 404);
    const ctx = await attachmentContext(thread.association._id);
    const item = await assertDriveItem(ctx.client, ctx.root, attachment.fileId, { allowRoot: false });
    if (item.mimeType === FOLDER_MIME) throw fail('添付ファイルを確認できません。', 404);
    const response = await ctx.client.request(`drive/v3/files/${driveId(attachment.fileId)}?alt=media&supportsAllDrives=true`);
    await req.auditPersonalData?.({ category: 'documents', resource: 'system-contact-attachment', action: 'download', data: { association: thread.association, thread }, targets: [`file:${attachment.fileId}`] });
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    await pipeline(Readable.fromWeb(response.body), res);
  }));
  systemContactsRouter.get(`${base}/:contactId`, requireLogin, guard, wrap(async (req, res) => {
    const thread = await load(req);
    // Viewing marks only the version displayed as read, preserving concurrent replies.
    const readField = system ? 'systemReadAt' : 'associationReadAt', readAt = new Date();
    await SystemContact.updateOne({ _id: thread._id, updatedAt: thread.updatedAt }, { $set: { [readField]: readAt } }, { timestamps: false });
    thread[readField] = readAt;
    res.render('system-contact', { title: thread.title, thread, system, baseUrl: url(req) });
  }));
  systemContactsRouter.post(`${base}/:contactId/replies`, requireLogin, guard, verifyCsrfToken, wrap(async (req, res) => {
    const thread = await load(req), body = contactText(req.body.body, 5000);
    await SystemContact.updateOne({ _id: thread._id }, { $push: { messages: { sender: req.user._id, kind: system ? 'system' : 'association', body } }, $set: { status: 'open', [system ? 'associationReadAt' : 'systemReadAt']: null } });
    await notify({ ...thread, association: thread.association._id }, system, req.user._id);
    req.session.notice = '返信を送りました。';
    res.redirect(`${url(req)}/${thread._id}`);
  }));
  systemContactsRouter.post(`${base}/:contactId/status`, requireLogin, guard, verifyCsrfToken, wrap(async (req, res) => {
    const thread = await load(req);
    if (!['open', 'resolved'].includes(req.body.status)) throw fail('対応状況を確認してください。');
    await SystemContact.updateOne({ _id: thread._id }, { $set: { status: req.body.status } });
    res.redirect(`${url(req)}/${thread._id}`);
  }));
}

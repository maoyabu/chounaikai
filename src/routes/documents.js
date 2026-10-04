import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ExcelJS from 'exceljs';
import { documentCellText } from '../services/documentPreviewService.js';
import { requireLogin, requirePermission } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { loadQuestionBoxAccess } from '../services/questionBoxService.js';
import { DriveConnection } from '../models/driveConnection.js';
import { DRIVE_SCOPE, FOLDER_MIME, driveError, driveId, folderIdFromInput, driveCallbackUrl, encryptDriveSecret, decryptDriveSecret, googleToken, driveClient, makeDriveClient, assertDriveItem, listDriveItems } from '../services/driveService.js';
export const documentsRouter = express.Router();
documentsRouter.use(requireLogin, provideCsrfToken);
const base = id => `/associations/${id}/documents`;
const handler = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { if (error instanceof multer.MulterError) error = driveError('ファイルは1件ずつ、20MB以下で選択してください。'); if (!res.headersSent && error.status && error.message) return res.status(error.status).render('error', { title: 'ドキュメント管理', message: error.message }); next(error); } };
const access = async req => { const result = await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id }); if (!result.canAnswer) throw driveError('町内会役員・管理者のみ利用できます。', 403); return result; };
const connectionFor = req => DriveConnection.findOne({ association: req.params.associationId }).select('+clientSecret +refreshToken');
const context = async req => { const result = await access(req), connection = await connectionFor(req), client = await driveClient(connection); return { ...result, connection, client }; };
const settingsRender = async (req, res, message = '') => { const { association } = await access(req), settings = await DriveConnection.findOne({ association: association._id }).lean(); res.render('documents-settings', { title: 'Google Drive連携設定', association, settings: settings || {}, callbackUrl: driveCallbackUrl(association._id), base: base(association._id), message }); };
documentsRouter.get('/:associationId/documents/settings', requirePermission('association.manage'), handler(async (req, res) => settingsRender(req, res)));
documentsRouter.post('/:associationId/documents/settings', verifyCsrfToken, requirePermission('association.manage'), handler(async (req, res) => {
  await access(req); const current = await connectionFor(req);
  const clientId = String(req.body.clientId || '').trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId) || clientId.length > 300) throw driveError('OAuthクライアントIDを確認してください。');
  const rootFolderId = folderIdFromInput(req.body.rootFolderId), secret = String(req.body.clientSecret || '').trim();
  if ((!secret && (!current?.clientSecret || clientId !== current.clientId)) || secret.length > 1000) throw driveError('クライアントシークレットを入力してください。');
  const changed = !current || clientId !== current.clientId || rootFolderId !== current.rootFolderId || Boolean(secret);
  const values = { clientId, rootFolderId };
  if (secret) values.clientSecret = encryptDriveSecret(secret, req.params.associationId);
  if (changed) Object.assign(values, { refreshToken: null, connectedAt: null, accountEmail: '' });
  await DriveConnection.findOneAndUpdate({ association: req.params.associationId }, { $set: values }, { upsert: true, runValidators: true });
  await settingsRender(req, res, '設定を保存しました。続いて「Googleアカウントで接続」を押してください。');
}));
documentsRouter.post('/:associationId/documents/oauth/start', verifyCsrfToken, requirePermission('association.manage'), handler(async (req, res) => {
  await access(req); const connection = await connectionFor(req);
  if (!connection?.clientSecret) throw driveError('先に連携設定を保存してください。');
  // Check encryption configuration before leaving the application.
  decryptDriveSecret(connection.clientSecret, connection.association);
  const state = crypto.randomBytes(32).toString('hex'), verifier = crypto.randomBytes(32).toString('base64url');
  req.session.driveOAuth = { state, verifier, association: req.params.associationId, user: String(req.user._id), configVersion: connection.updatedAt.toISOString(), expires: Date.now() + 600000 };
  const params = new URLSearchParams({ client_id: connection.clientId, redirect_uri: driveCallbackUrl(connection.association), response_type: 'code', scope: DRIVE_SCOPE, access_type: 'offline', prompt: 'consent', state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}));
documentsRouter.get('/:associationId/documents/oauth/callback', requirePermission('association.manage'), handler(async (req, res) => {
  res.set('Referrer-Policy', 'no-referrer'); res.set('Cache-Control', 'no-store');
  await access(req); const pending = req.session.driveOAuth; delete req.session.driveOAuth;
  const received = typeof req.query.state === 'string' ? req.query.state : '';
  if (!pending || pending.expires < Date.now() || pending.association !== req.params.associationId || pending.user !== String(req.user._id) || received.length !== pending.state.length || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(pending.state))) throw driveError('接続の有効期限が切れました。設定画面から再度接続してください。');
  if (req.query.error) return res.redirect(`${base(req.params.associationId)}/settings`);
  if (typeof req.query.code !== 'string' || req.query.code.length > 4096) throw driveError('Googleからの接続情報を確認できません。');
  const connection = await connectionFor(req);
  if (!connection || connection.updatedAt.toISOString() !== pending.configVersion) throw driveError('設定が変更されました。もう一度接続してください。');
  const tokens = await googleToken({ code: req.query.code, client_id: connection.clientId, client_secret: decryptDriveSecret(connection.clientSecret, connection.association), redirect_uri: driveCallbackUrl(connection.association), grant_type: 'authorization_code', code_verifier: pending.verifier });
  if (!tokens.refresh_token || !(tokens.scope || '').split(' ').includes(DRIVE_SCOPE)) throw driveError('Driveのアクセスを許可して、もう一度接続してください。');
  const client = makeDriveClient(tokens.access_token);
  const root = await client.meta(connection.rootFolderId);
  if (root.trashed || root.mimeType !== FOLDER_MIME || !root.capabilities?.canAddChildren) throw driveError('編集可能な共有フォルダを指定してください。');
  const about = await (await client.request('drive/v3/about?fields=user(emailAddress)')).json();
  const saved = await DriveConnection.updateOne({ _id: connection._id, updatedAt: connection.updatedAt }, { $set: { refreshToken: encryptDriveSecret(tokens.refresh_token, connection.association), connectedAt: new Date(), accountEmail: about.user?.emailAddress || '' } });
  if (!saved.modifiedCount) throw driveError('設定が変更されました。もう一度接続してください。');
  res.redirect(`${base(req.params.associationId)}/settings`);
}));
documentsRouter.post('/:associationId/documents/disconnect', verifyCsrfToken, requirePermission('association.manage'), handler(async (req, res) => {
  await access(req); await DriveConnection.updateOne({ association: req.params.associationId }, { $set: { refreshToken: null, connectedAt: null, accountEmail: '' } });
  delete req.session.driveOAuth; res.redirect(`${base(req.params.associationId)}/settings`);
}));
documentsRouter.get('/:associationId/documents', handler(async (req, res) => {
  const { association } = await access(req), connection = await connectionFor(req);
  if (!connection?.refreshToken) return res.render('documents-list', { title: '町内会ドキュメント管理', association, base: base(association._id), connected: false });
  const client = await driveClient(connection), folderId = req.query.folder || connection.rootFolderId;
  const folder = await assertDriveItem(client, connection.rootFolderId, folderId, { folder: true });
  const breadcrumbs = []; let cursor = folder;
  while (cursor.id !== connection.rootFolderId) { breadcrumbs.unshift(cursor); cursor = await client.meta(cursor.parents[0]); }
  breadcrumbs.unshift(cursor);
  const listing = await listDriveItems(client, folderId, req.query.page || '');
  res.render('documents-list', { title: '町内会ドキュメント管理', association, base: base(association._id), connected: true, folder, breadcrumbs, items: listing.files.filter(item => item.mimeType !== 'application/vnd.google-apps.shortcut'), nextPage: listing.nextPageToken || '' });
}));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 5 } }).single('file');
documentsRouter.post('/:associationId/documents/upload', handler(async (req, res) => {
  const ctx = await context(req); // Authorize before buffering multipart data.
  await new Promise((resolve, reject) => upload(req, res, err => err ? reject(err) : resolve()));
  let csrfValid = false; verifyCsrfToken(req, res, () => { csrfValid = true; }); if (!csrfValid) return;
  const folder = await assertDriveItem(ctx.client, ctx.connection.rootFolderId, req.body.folder, { folder: true });
  if (!folder.capabilities?.canAddChildren) throw driveError('このフォルダにはアップロードできません。', 403);
  const file = req.file; if (!file?.size) throw driveError('アップロードするファイルを選択してください。');
  const name = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[\x00-\x1f/\\]/g, '_').slice(0, 200);
  const ext = name.split('.').pop().toLowerCase();
  const mimes = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel' };
  if (!mimes[ext]) throw driveError('PDFまたはExcel（.xlsx・.xls）を選択してください。');
  const boundary = `drive_${crypto.randomBytes(16).toString('hex')}`;
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folder.id] })}\r\n--${boundary}\r\nContent-Type: ${mimes[ext]}\r\n\r\n`), file.buffer, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  await (await ctx.client.request('upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })).body?.cancel();
  req.session.notice = 'ファイルをアップロードしました。'; res.redirect(`${base(ctx.association._id)}?folder=${folder.id}`);
}));
const exports = { 'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'], 'application/vnd.google-apps.document': ['application/pdf', '.pdf'], 'application/vnd.google-apps.presentation': ['application/pdf', '.pdf'] };
const content = async (client, item) => {
  const format = exports[item.mimeType];
  if (item.mimeType.startsWith('application/vnd.google-apps.') && !format) throw driveError('この形式の閲覧・ダウンロードには対応していません。');
  if (item.capabilities?.canDownload === false) throw driveError('このファイルのダウンロードは許可されていません。', 403);
  const response = await client.request(format ? `drive/v3/files/${item.id}/export?mimeType=${encodeURIComponent(format[0])}` : `drive/v3/files/${item.id}?alt=media&supportsAllDrives=true`);
  return { response, mime: format?.[0] || item.mimeType, name: item.name + (format?.[1] || '') };
};
documentsRouter.get('/:associationId/documents/files/:fileId/download', handler(async (req, res) => {
  const ctx = await context(req), item = await assertDriveItem(ctx.client, ctx.connection.rootFolderId, req.params.fileId, { allowRoot: false });
  if (item.mimeType === FOLDER_MIME) throw driveError('フォルダはダウンロードできません。');
  const { response, mime, name } = await content(ctx.client, item);
  res.set({ 'Content-Type': mime, 'Content-Disposition': `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  try { await pipeline(Readable.fromWeb(response.body), res); } catch (error) { if (!res.headersSent) throw error; }
}));
const boundedContent = async response => {
  const chunks = []; let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) { size += chunk.length; if (size > 20 * 1024 * 1024) throw driveError('20MBを超えるファイルはダウンロードして閲覧してください。'); chunks.push(chunk); }
  return Buffer.concat(chunks);
};
documentsRouter.get('/:associationId/documents/files/:fileId/view', handler(async (req, res) => {
  const ctx = await context(req), item = await assertDriveItem(ctx.client, ctx.connection.rootFolderId, req.params.fileId, { allowRoot: false });
  const supported = ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ...Object.keys(exports)];
  const mode = supported.includes(item.mimeType) ? (item.mimeType.includes('spreadsheet') ? 'excel' : 'pdf') : 'download';
  res.set('Cache-Control', 'no-store');
  let sheets = [];
  if (mode === 'excel') {
    if (Number(item.size) > 20 * 1024 * 1024) throw driveError('20MBを超えるExcelはダウンロードして閲覧してください。');
    const { response } = await content(ctx.client, item), workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.load(await boundedContent(response)); } catch (error) { if (error.status) throw error; throw driveError('Excelを表示できません。ダウンロードして確認してください。'); }
    let cells = 0;
    sheets = workbook.worksheets.map(sheet => { const rows = []; for (let r = 1; r <= Math.min(sheet.rowCount, 200); r++) { const row = []; for (let c = 1; c <= Math.min(sheet.columnCount, 30); c++) { if (++cells > 30000) break; row.push(documentCellText(sheet.getCell(r, c))); } if (cells > 30000) break; rows.push(row); } return { name: sheet.name, rows }; });
  }
  res.render('documents-view', { title: item.name, association: ctx.association, item, base: base(ctx.association._id), mode, sheets });
}));
documentsRouter.get('/:associationId/documents/files/:fileId/pdf', handler(async (req, res) => {
  const ctx = await context(req), item = await assertDriveItem(ctx.client, ctx.connection.rootFolderId, req.params.fileId, { allowRoot: false });
  if (!['application/pdf', 'application/vnd.google-apps.document', 'application/vnd.google-apps.presentation'].includes(item.mimeType)) throw driveError('PDF形式で閲覧できません。');
  const { response } = await content(ctx.client, item);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="document.pdf"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; frame-ancestors 'self'" });
  try { await pipeline(Readable.fromWeb(response.body), res); } catch (error) { if (!res.headersSent) throw error; }
}));
documentsRouter.get('/:associationId/documents/files/:fileId/delete', handler(async (req, res) => {
  const ctx = await context(req), item = await assertDriveItem(ctx.client, ctx.connection.rootFolderId, req.params.fileId, { allowRoot: false });
  if (item.mimeType === FOLDER_MIME || !item.capabilities?.canTrash) throw driveError('このファイルはゴミ箱へ移動できません。', 403);
  res.render('documents-delete', { title: 'ファイルの削除確認', association: ctx.association, item, base: base(ctx.association._id) });
}));
documentsRouter.post('/:associationId/documents/files/:fileId/delete', verifyCsrfToken, handler(async (req, res) => {
  const ctx = await context(req), item = await assertDriveItem(ctx.client, ctx.connection.rootFolderId, req.params.fileId, { allowRoot: false });
  if (item.mimeType === FOLDER_MIME || !item.capabilities?.canTrash) throw driveError('このファイルはゴミ箱へ移動できません。', 403);
  await (await ctx.client.request(`drive/v3/files/${driveId(item.id)}?supportsAllDrives=true`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) })).body?.cancel();
  req.session.notice = 'ファイルをGoogle Driveのゴミ箱へ移しました。'; res.redirect(`${base(ctx.association._id)}?folder=${item.parents[0]}`);
}));

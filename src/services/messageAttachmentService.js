import crypto from 'node:crypto';
import { DriveConnection } from '../models/driveConnection.js';
import { driveClient, assertDriveItem, driveId, FOLDER_MIME, driveError } from './driveService.js';

export const MESSAGE_FOLDER_NAME = 'メッセージ添付フォルダ';
export const attachmentContext = async association => {
  const connection = await DriveConnection.findOne({ association }).select('+clientSecret +refreshToken');
  const client = await driveClient(connection);
  return { client, root: connection.rootFolderId };
};
export const validateMessageFiles = files => {
  if (files.length > 3 || files.some(file => !file.size || file.size > 15 * 1024 * 1024)) throw driveError('添付ファイルは3個まで、1個15MB以下で選択してください。');
};
export const saveMessageAttachments = async (files, { client, root }) => {
  validateMessageFiles(files);
  const rootItem = await assertDriveItem(client, root, root, { folder: true });
  if (!rootItem.capabilities?.canAddChildren) throw driveError('町内会のGoogle Driveフォルダに保存する権限がありません。', 403);
  const params = new URLSearchParams({ q: `'${driveId(root)}' in parents and trashed = false and mimeType = '${FOLDER_MIME}' and name = '${MESSAGE_FOLDER_NAME}'`, fields: 'files(id)', pageSize: '100', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
  const listing = await (await client.request(`drive/v3/files?${params}`)).json();
  let folder = listing.files?.[0];
  if (!folder) folder = await (await client.request('drive/v3/files?fields=id&supportsAllDrives=true', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: MESSAGE_FOLDER_NAME, mimeType: FOLDER_MIME, parents: [root] }) })).json();
  const folderItem = await assertDriveItem(client, root, folder.id, { folder: true });
  if (!folderItem.capabilities?.canAddChildren) throw driveError('メッセージ添付フォルダに保存する権限がありません。', 403);
  const attachments = [];
  try {
    for (const file of files) {
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[\x00-\x1f/\\]/g, '_').slice(0, 200) || 'attachment';
      const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(file.mimetype) ? file.mimetype : 'application/octet-stream';
      const boundary = `message_${crypto.randomBytes(16).toString('hex')}`;
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folder.id] })}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`), file.buffer, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const saved = await (await client.request('upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })).json();
      attachments.push({ fileId: driveId(saved.id), originalName: name, mimeType, bytes: file.size });
    }
    return attachments;
  } catch (error) {
    await removeMessageAttachments(attachments, client);
    throw error;
  }
};
export const removeMessageAttachments = async (attachments, client) => {
  await Promise.allSettled(attachments.map(async item => {
    const response = await client.request(`drive/v3/files/${driveId(item.fileId)}?supportsAllDrives=true`, { method: 'DELETE' });
    await response.body?.cancel();
  }));
};

import crypto from 'node:crypto';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const driveError = (message, status = 400) => Object.assign(new Error(message), { status });
const key = () => {
  const value = process.env.DRIVE_ENCRYPTION_KEY || '';
  if (!/^[a-f\d]{64}$/i.test(value)) throw driveError('システム管理者がDrive連携用の暗号化キーを設定してください。', 503);
  return Buffer.from(value, 'hex');
};
export const encryptDriveSecret = (value, association) => {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(String(association)));
  return [iv, Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]), cipher.getAuthTag()].map(b => b.toString('base64')).join('.');
};
export const decryptDriveSecret = (value, association) => {
  const [iv, encrypted, tag] = value.split('.').map(v => Buffer.from(v, 'base64'));
  const cipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(String(association))); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
};
export const driveId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw driveError('フォルダ・ファイルを確認してください。');
  return value;
};
export const folderIdFromInput = value => {
  const text = String(value || '').trim();
  if (text.startsWith('https://drive.google.com/')) {
    const url = new URL(text), match = url.pathname.match(/\/folders\/([\w-]+)$/);
    if (!match) throw driveError('Google DriveのフォルダURLを入力してください。');
    return driveId(match[1]);
  }
  return driveId(text);
};
export const driveCallbackUrl = association => {
  const url = new URL(process.env.PUBLIC_BASE_URL || 'http://localhost:3003');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw driveError('公開URLにはHTTPSを設定してください。');
  return `${url.origin}/associations/${association}/documents/oauth/callback`;
};
export const googleToken = async params => {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.timeout(20000) });
  const data = await response.json();
  if (!response.ok) throw driveError('Googleとの連携を確認してください。管理者設定から再接続が必要な場合があります。', 400);
  return data;
};
export const driveClient = async connection => {
  if (!connection?.refreshToken) throw driveError('町内会管理者がGoogle Driveとの連携を設定してください。', 409);
  const tokens = await googleToken({ client_id: connection.clientId, client_secret: decryptDriveSecret(connection.clientSecret, connection.association), refresh_token: decryptDriveSecret(connection.refreshToken, connection.association), grant_type: 'refresh_token' });
  return makeDriveClient(tokens.access_token);
};
export const makeDriveClient = token => {
  const request = async (endpoint, options = {}) => {
    const response = await fetch(`https://www.googleapis.com/${endpoint}`, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const reasons = [
        ...(Array.isArray(data?.error?.errors) ? data.error.errors.map(item => item.reason) : []),
        ...(Array.isArray(data?.error?.details) ? data.error.details.map(item => item.reason) : [])
      ];
      let message = response.status === 404 ? 'ファイルが見つかりません。移動・削除された可能性があります。' : response.status === 403 ? 'Google Driveの権限が不足しています。接続したアカウントが登録フォルダにアクセスできるか確認してください。' : 'Google Driveに接続できません。時間をおいてお試しください。';
      if (reasons.some(reason => ['accessNotConfigured', 'SERVICE_DISABLED'].includes(reason))) {
        message = '接続に使用しているGoogle CloudプロジェクトでGoogle Drive APIを有効にしてください。「APIとサービス」の「ライブラリ」から有効化後、もう一度接続してください。';
      } else if (reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'RATE_LIMIT_EXCEEDED'].includes(reason)) || response.status === 429) {
        message = 'Google Driveの利用制限に達しました。時間をおいて再度お試しください。';
      }
      // Never expose upstream messages, request URLs or OAuth credentials.
      throw driveError(message, response.status === 404 ? 404 : 400);
    }
    return response;
  };
  const meta = async id => (await request(`drive/v3/files/${driveId(id)}?${new URLSearchParams({ fields: 'id,name,mimeType,parents,trashed,size,capabilities,modifiedTime', supportsAllDrives: 'true' })}`)).json();
  return { request, meta };
};
// Never trust IDs supplied by the browser. Check ancestry on every operation.
export const assertDriveItem = async (client, root, id, { folder = false, allowRoot = true } = {}) => {
  driveId(root); driveId(id);
  if (!allowRoot && id === root) throw driveError('共有の起点フォルダは操作できません。', 403);
  const item = await client.meta(id);
  if (item.trashed || item.mimeType === 'application/vnd.google-apps.shortcut' || (folder && item.mimeType !== FOLDER_MIME)) throw driveError('対象を確認してください。', 404);
  let current = item; const seen = new Set();
  for (let depth = 0; depth < 100; depth++) {
    if (current.id === root) return item;
    if (seen.has(current.id) || !current.parents?.length) break;
    seen.add(current.id); current = await client.meta(current.parents[0]);
    if (current.trashed || current.mimeType !== FOLDER_MIME) break;
  }
  throw driveError('この町内会の共有フォルダ内だけ操作できます。', 403);
};
export const listDriveItems = async (client, folder, pageToken = '') => {
  if (typeof pageToken !== 'string' || pageToken.length > 2000) throw driveError('ページを確認してください。');
  const params = new URLSearchParams({ q: `'${driveId(folder)}' in parents and trashed = false`, fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,capabilities)', pageSize: '100', orderBy: 'folder,name', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
  if (pageToken) params.set('pageToken', pageToken);
  return (await client.request(`drive/v3/files?${params}`)).json();
};

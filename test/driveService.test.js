import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptDriveSecret, decryptDriveSecret, folderIdFromInput, driveId, assertDriveItem, listDriveItems, FOLDER_MIME, makeDriveClient, driveCallbackUrl } from '../src/services/driveService.js';
test('secrets use authenticated encryption bound to association', () => {
  const old = process.env.DRIVE_ENCRYPTION_KEY; process.env.DRIVE_ENCRYPTION_KEY = 'ab'.repeat(32);
  try { const encrypted = encryptDriveSecret('very-secret', 'tenant-a'); assert.equal(decryptDriveSecret(encrypted, 'tenant-a'), 'very-secret'); assert.ok(!encrypted.includes('very-secret')); assert.notEqual(encryptDriveSecret('very-secret', 'tenant-a'), encrypted); assert.throws(() => decryptDriveSecret(encrypted, 'tenant-b')); const parts = encrypted.split('.'); parts[2] = Buffer.alloc(16).toString('base64'); assert.throws(() => decryptDriveSecret(parts.join('.'), 'tenant-a')); } finally { if (old === undefined) delete process.env.DRIVE_ENCRYPTION_KEY; else process.env.DRIVE_ENCRYPTION_KEY = old; }
});
test('folder input accepts Google URLs and rejects query injection', () => {
  assert.equal(folderIdFromInput('https://drive.google.com/drive/u/0/folders/abc_123?usp=sharing'), 'abc_123');
  assert.equal(folderIdFromInput('abc_123'), 'abc_123');
  for (const value of ["abc' or true", '../secret', ['abc'], '', 'https://example.com/folders/a']) assert.throws(() => driveId(value));
});
const fixtures = {
 root: { id: 'root', mimeType: FOLDER_MIME }, child: { id: 'child', mimeType: FOLDER_MIME, parents: ['root'] },
 file: { id: 'file', mimeType: 'application/pdf', parents: ['child'] }, outside: { id: 'outside', mimeType: 'application/pdf', parents: ['other-root'] },
 'other-root': { id: 'other-root', mimeType: FOLDER_MIME }, shortcut: { id: 'shortcut', mimeType: 'application/vnd.google-apps.shortcut', parents: ['root'] },
 trashed: { id: 'trashed', mimeType: 'application/pdf', parents: ['root'], trashed: true },
 loop: { id: 'loop', mimeType: FOLDER_MIME, parents: ['loop'] }
};
const client = { meta: async id => fixtures[id] };
test('every operation is confined to configured root and nested folders', async () => {
 assert.equal((await assertDriveItem(client, 'root', 'file')).id, 'file');
 assert.equal((await assertDriveItem(client, 'root', 'child', { folder: true })).id, 'child');
 for (const id of ['outside', 'shortcut', 'trashed', 'loop']) await assert.rejects(assertDriveItem(client, 'root', id));
 await assert.rejects(assertDriveItem(client, 'root', 'root', { allowRoot: false }));
 await assert.rejects(assertDriveItem(client, 'root', 'file', { folder: true }));
});
test('list query supports shared drives and preserves pagination', async () => {
 let url; const fake = { request: async value => { url = new URL('https://www.googleapis.com/' + value); return { json: async () => ({ files: [], nextPageToken: 'next' }) }; } };
 assert.equal((await listDriveItems(fake, 'root', 'token')).nextPageToken, 'next'); assert.equal(url.searchParams.get('q'), "'root' in parents and trashed = false"); assert.equal(url.searchParams.get('pageToken'), 'token'); assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
});
test('callback uses configured public origin', () => {
 const old = process.env.PUBLIC_BASE_URL; try { process.env.PUBLIC_BASE_URL = 'https://town.example'; assert.equal(driveCallbackUrl('abc'), 'https://town.example/associations/abc/documents/oauth/callback'); process.env.PUBLIC_BASE_URL = 'http://town.example'; assert.throws(() => driveCallbackUrl('abc')); } finally { if (old === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = old; }
});
test('Google errors never expose upstream tokens or messages', async () => {
 const original = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ error: 'secret' }), { status: 403 });
 try { await assert.rejects(makeDriveClient('token').meta('root'), error => error.status === 400 && !error.message.includes('secret')); } finally { globalThis.fetch = original; }
});

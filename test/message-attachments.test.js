import test from 'node:test';
import assert from 'node:assert/strict';
import { saveMessageAttachments, validateMessageFiles, MESSAGE_FOLDER_NAME } from '../src/services/messageAttachmentService.js';
import { FOLDER_MIME } from '../src/services/driveService.js';
const file = { originalname: 'report.pdf', mimetype: 'application/pdf', size: 4, buffer: Buffer.from('test') };
const fixture = ({ existing = false, failSecond = false } = {}) => {
  const calls = []; let uploaded = 0;
  const client = {
    meta: async id => ({ id, mimeType: FOLDER_MIME, parents: id === 'root' ? [] : ['root'], capabilities: { canAddChildren: true } }),
    request: async (endpoint, options = {}) => {
      calls.push({ endpoint, options });
      if (endpoint.startsWith('drive/v3/files?') && !options.method) return { json: async () => ({ files: existing ? [{ id: 'folder' }] : [] }) };
      if (endpoint.startsWith('upload/')) {
        if (failSecond && ++uploaded === 2) throw new Error('upload failed');
        return { json: async () => ({ id: 'file1' }) };
      }
      return { json: async () => ({ id: 'folder' }) };
    }
  };
  return { client, root: 'root', calls };
};
test('creates named attachment folder under the association root and uploads file content', async () => {
  const ctx = fixture();
  const result = await saveMessageAttachments([file], ctx);
  const create = ctx.calls.find(call => call.options.method === 'POST' && !call.endpoint.startsWith('upload/'));
  assert.deepEqual(JSON.parse(create.options.body), { name: MESSAGE_FOLDER_NAME, mimeType: FOLDER_MIME, parents: ['root'] });
  const upload = ctx.calls.find(call => call.endpoint.startsWith('upload/'));
  assert.ok(upload.options.body.includes(Buffer.from('test')));
  assert.ok(upload.options.body.toString().includes('"parents":["folder"]'));
  assert.equal(result[0].fileId, 'file1');
});
test('reuses existing folder and removes uploaded files when another upload fails', async () => {
  const ctx = fixture({ existing: true, failSecond: true });
  await assert.rejects(saveMessageAttachments([file, file], ctx), /upload failed/);
  assert.equal(ctx.calls.filter(call => call.options.method === 'POST' && !call.endpoint.startsWith('upload/')).length, 0);
  assert.ok(ctx.calls.some(call => call.options.method === 'DELETE' && call.endpoint.includes('/file1?')));
});
test('rejects oversized, empty and too many attachments before Drive requests', () => {
  for (const files of [[file, file, file, file], [{ ...file, size: 0 }], [{ ...file, size: 15 * 1024 * 1024 + 1 }]]) assert.throws(() => validateMessageFiles(files), { status: 400 });
});
test('rejects folders outside the association root', async () => {
  const ctx = fixture({ existing: true });
  ctx.client.meta = async id => ({ id, mimeType: FOLDER_MIME, parents: [], capabilities: { canAddChildren: true } });
  await assert.rejects(saveMessageAttachments([file], ctx), { status: 403 });
  assert.equal(ctx.calls.some(call => call.endpoint.startsWith('upload/')), false);
});

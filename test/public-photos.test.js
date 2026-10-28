import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { publicPhotoHandler } from '../src/routes/profileImages.js';

const association = '507f1f77bcf86cd799439012';
const token = 'a'.repeat(64);
for (const source of ['association', 'group', 'removed', 'inactive', 'invalid-type']) {
  test(`public Drive photo delivery checks references and ancestry: ${source}`, async () => {
    const calls = [];
    const dependencies = {
      NeighborhoodAssociation: { exists: async filter => filter.$or ? source === 'association' || source === 'invalid-type' : source !== 'inactive' },
      AssociationGroup: { exists: async filter => { assert.equal(filter.association, association); return source === 'group'; } },
      attachmentContext: async () => ({ root: 'root', client: { request: async () => { calls.push('download'); return { body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('photo')); controller.close(); } }) }; } } }),
      assertDriveItem: async (client, root, id, options) => { calls.push('ancestry'); assert.equal(root, 'root'); assert.equal(id, 'photo'); assert.deepEqual(options, { allowRoot: false }); return { mimeType: source === 'invalid-type' ? 'text/html' : 'image/jpeg' }; }
    };
    const res = new PassThrough();
    res.set = () => res;
    res.sendStatus = status => { res.statusCode = status; res.end(); };
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    await publicPhotoHandler(dependencies)({ params: { association, fileId: 'photo', token } }, res, error => assert.ifError(error));
    if (['association', 'group'].includes(source)) {
      assert.equal(Buffer.concat(chunks).toString(), 'photo');
      assert.deepEqual(calls, ['ancestry', 'download']);
    } else {
      assert.equal(res.statusCode, 404);
      assert.ok(!calls.includes('download'));
    }
  });
}

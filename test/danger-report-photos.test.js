import test from 'node:test';
import assert from 'node:assert/strict';
import { createDangerReportWithPhoto, ensureDangerReportDrivePhoto } from '../src/services/dangerReportPhotoService.js';
const attachment = { fileId: 'drive-photo', originalName: 'photo.jpg', mimeType: 'image/jpeg', bytes: 4 };
const data = { title: '危険', photo: Buffer.from([255,216,255,224]), photoType: 'image/jpeg' };
function fixture() {
  const calls = [];
  const context = { client: {}, root: 'configured-root' };
  const deps = {
    attachmentContext: async association => { calls.push(['context',association]);return context; },
    saveMessageAttachments: async (files, ctx) => { assert.equal(ctx,context);assert.equal(files[0].buffer.length,4);assert.equal(files[0].mimetype,'image/jpeg');calls.push(['upload']);return [attachment]; },
    removeMessageAttachments: async files => { assert.deepEqual(files,[attachment]);calls.push(['cleanup']); },
    model: {
      create: async fields => {calls.push(['create',fields]);return fields;},
      updateOne: async (filter, update) => {calls.push(['update',filter,update]);return {modifiedCount:1};}
    }
  };
  return {deps,calls};
}
test('saves photo via configured message attachment storage and stores only the Drive reference', async () => {
  const {deps,calls} = fixture();
  const result = await createDangerReportWithPhoto({data, association:'association', author:'user'},deps);
  assert.equal(result.photo,undefined);assert.deepEqual(result.photoAttachment,attachment);
  assert.equal(result.author,'user');assert.deepEqual(calls.map(call=>call[0]),['context','upload','create']);
});
test('failed database persistence rolls back the uploaded Drive image', async () => {
  const {deps,calls} = fixture();
  deps.model.create = async () => { throw new Error('database failure'); };
  await assert.rejects(createDangerReportWithPhoto({data,association:'association',author:'user'},deps),/database failure/);
  assert.equal(calls.at(-1)[0],'cleanup');
});
test('unavailable Drive prevents creating a report', async () => {
  const {deps,calls} = fixture();
  deps.attachmentContext = async () => {throw new Error('Drive unavailable');};
  await assert.rejects(createDangerReportWithPhoto({data,association:'association',author:'user'},deps),/Drive unavailable/);
  assert.equal(calls.length,0);
});
test('existing Drive photo is reused without uploading again', async () => {
  const {deps,calls} = fixture();
  assert.equal(await ensureDangerReportDrivePhoto({photoAttachment:attachment},deps),attachment);
  assert.equal(calls.length,0);
});
test('legacy photo moves to Drive and binary is removed only in the same successful database update', async () => {
  const {deps,calls} = fixture();
  const result = await ensureDangerReportDrivePhoto({_id:'report',association:'association',...data},deps);
  assert.equal(result,attachment);
  const update = calls.find(call=>call[0]==='update');
  assert.deepEqual(update[1]['photoAttachment.fileId'],{$exists:false});
  assert.deepEqual(update[2],{$set:{photoAttachment:attachment},$unset:{photo:1}});
  assert.equal(calls.some(call=>call[0]==='cleanup'),false);
});
test('failed migration keeps legacy data and removes the unused upload', async () => {
  const {deps,calls} = fixture();deps.model.updateOne = async () => {throw new Error('write failed');};
  await assert.rejects(ensureDangerReportDrivePhoto({_id:'report',association:'association',...data},deps),/write failed/);
  assert.equal(calls.at(-1)[0],'cleanup');
});
test('concurrent migration discards duplicate upload and uses the winning reference', async () => {
  const {deps,calls} = fixture();const winner={...attachment,fileId:'winner'};
  deps.model.updateOne=async()=>({modifiedCount:0});
  deps.model.findOne=()=>({select:()=>({lean:async()=>({photoAttachment:winner})})});
  assert.equal(await ensureDangerReportDrivePhoto({_id:'report',association:'association',...data},deps),winner);
  assert.equal(calls.at(-1)[0],'cleanup');
});

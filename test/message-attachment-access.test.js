import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { AssociationEvent } from '../src/models/associationEvent.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { OfficerAnnouncement } from '../src/models/officerAnnouncement.js';
import { messageAttachmentsRouter, canReadMessageAttachment } from '../src/routes/messageAttachments.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { OfficerAnnouncementReceipt } from '../src/models/officerAnnouncement.js';
import { DriveConnection } from '../src/models/driveConnection.js';
import { encryptDriveSecret, FOLDER_MIME } from '../src/services/driveService.js';
import { uploadAnnouncementAttachment, deleteAnnouncementAttachment } from '../src/services/announcementAttachmentService.js';
import { persistEventImage } from '../src/services/eventAttachmentService.js';
const id = () => new mongoose.Types.ObjectId();
const association = id(), sender = id(), user = { _id: id() };
const query = value => ({ lean: async () => value });
test('attachments reject nonmembers even with stale receipts; active recipients can view', async t => {
  const message = { _id: id(), association, sender, channel: 'district' };
  t.mock.method(AssociationMembership, 'findOne', () => query(null));
  t.mock.method(OfficerAnnouncementReceipt, 'exists', async () => ({ _id: id() }));
  assert.equal(await canReadMessageAttachment(message, user), false);
  t.mock.method(AssociationMembership, 'findOne', () => query({ user: user._id }));
  assert.equal(await canReadMessageAttachment(message, user), true);
  t.mock.method(OfficerAnnouncementReceipt, 'exists', async () => null);
  assert.equal(await canReadMessageAttachment(message, user), false);
  assert.equal(await canReadMessageAttachment(message, { _id: sender }), true);
});
const setupDrive = t => {
  const old = process.env.DRIVE_ENCRYPTION_KEY;
  process.env.DRIVE_ENCRYPTION_KEY = 'a'.repeat(64);
  t.after(() => { if (old === undefined) delete process.env.DRIVE_ENCRYPTION_KEY; else process.env.DRIVE_ENCRYPTION_KEY = old; });
  const connection = { association, rootFolderId: 'root', clientId: 'client', clientSecret: encryptDriveSecret('secret', association), refreshToken: encryptDriveSecret('refresh', association) };
  t.mock.method(DriveConnection, 'findOne', criteria => { assert.equal(String(criteria.association), String(association)); return { select: async () => connection }; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url, options });
    let data;
    if (url.includes('oauth2')) data = { access_token: 'token' };
    else if (options.method === 'DELETE') return new Response(null, { status: 204 });
    else if (url.includes('/upload/')) data = { id: 'saved_file' };
    else if (url.includes('files?')) data = { files: [{ id: 'folder' }] };
    else { const itemId = new URL(url).pathname.split('/').pop(); data = { id: itemId, mimeType: itemId === 'saved_file' ? 'application/pdf' : FOLDER_MIME, parents: itemId === 'root' ? [] : ['root'], capabilities: { canAddChildren: true } }; }
    return new Response(JSON.stringify(data), { status: 200 });
  });
  return requests;
};
test('announcement upload stores Drive identity and authenticated local viewing URL; deletion uses same association', async t => {
  const requests = setupDrive(t);
  const file = { originalname: 'report.pdf', mimetype: 'application/pdf', size: 4, buffer: Buffer.from('test') };
  const saved = await uploadAnnouncementAttachment(file, association);
  assert.equal(saved.storage, 'drive');
  assert.equal(saved.publicId, 'drive:saved_file');
  assert.equal(saved.url, `/associations/${association}/message-attachments/saved_file`);
  await deleteAnnouncementAttachment(saved.publicId, saved.resourceType, association);
  assert.ok(requests.some(request => request.options.method === 'DELETE' && request.url.includes('/saved_file?')));
});
test('failed event database write removes the new Drive image', async t => {
  const requests = setupDrive(t);
  const file = { originalname: 'photo.png', mimetype: 'image/png', size: 4, buffer: Buffer.from('test') };
  await assert.rejects(persistEventImage({ file, association, persist: async image => { assert.equal(image.url, `/associations/${association}/event-images/saved_file`); throw new Error('db failed'); } }), /db failed/);
  assert.ok(requests.some(request => request.options.method === 'DELETE'));
});

const readRoute = path => {
  const layer = messageAttachmentsRouter.stack.find(layer => layer.route?.methods.get && layer.match(path.replace(/^\/associations/, '')));
  const req = { params: layer.params, originalUrl: path, user, isAuthenticated: () => true };
  return new Promise(resolve => {
    const res = { redirect: () => resolve(302) };
    let index = 0;
    const next = error => {
      if (error) return resolve(error.status || 500);
      Promise.resolve(layer.route.stack[index++].handle(req, res, next)).catch(next);
    };
    next();
  });
};
test('expired message attachments and hidden event images are blocked before Drive access', async t => {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: association }));
  t.mock.method(OfficerAnnouncement, 'findOne', () => query({ association, attachments: [{ fileId: 'file', expiresAt: new Date(0) }] }));
  assert.equal(await readRoute(`/associations/${association}/message-attachments/file`), 404);
  t.mock.method(AssociationEvent, 'findOne', () => query({ association, visible: false, open: true }));
  t.mock.method(AssociationMembership, 'findOne', () => query(null));
  assert.equal(await readRoute(`/associations/${association}/event-images/file`), 403);
});

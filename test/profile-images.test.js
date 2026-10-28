import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { persistProfileImage, profileImageUrl, PROFILE_PHOTO_FOLDER } from '../src/services/profileImageService.js';
import { profileImageHandler } from '../src/routes/profileImages.js';

const userId = '507f1f77bcf86cd799439011';
const association = '507f1f77bcf86cd799439012';
const file = { buffer: Buffer.from('photo'), mimetype: 'image/jpeg', originalname: 'photo.jpg', size: 5 };
const query = value => ({ select: () => ({ lean: async () => value }) });
const fixture = () => {
  const calls = [];
  const ctx = { client: {}, root: 'root' };
  const previous = { avatar: 'https://old.example/photo.jpg' };
  const dependencies = {
    AssociationMembership: { find: () => query([{ association }]) },
    NeighborhoodAssociation: { find: () => query([{ _id: association }]) },
    User: { findById: () => query(previous), updateOne: async (filter, update) => { calls.push(['persist', filter, update]); return { matchedCount: 1 }; } },
    attachmentContext: async id => { calls.push(['context', id]); return ctx; },
    saveMessageAttachments: async (files, context) => { calls.push(['upload', files, context]); return [{ fileId: 'new-photo', mimeType: 'image/jpeg', originalName: 'photo.jpg', bytes: 5 }]; },
    removeMessageAttachments: async (images, client) => { calls.push(['remove', images, client]); return []; }
  };
  return { calls, dependencies, previous, ctx };
};

test('new profile photo uses the selected membership Drive and saves a shared absolute URL', async () => {
  const { calls, dependencies } = fixture();
  const saved = await persistProfileImage({ file, userId, associationId: association, update: { displayname: '田中' } }, dependencies);
  assert.equal(saved.displayname, '田中');
  assert.match(saved.avatar, new RegExp(`/profile-images/${userId}/[a-f0-9]{64}$`));
  assert.ok(new URL(saved.avatar).origin);
  assert.equal(saved.avatarDriveImage.association, association);
  assert.equal(calls.find(call => call[0] === 'upload')[2].folderName, PROFILE_PHOTO_FOLDER);
  assert.equal(calls.some(call => call[0] === 'remove'), false);
});

test('text-only profile update does not need a membership or Drive connection', async () => {
  const { calls, dependencies } = fixture();
  dependencies.AssociationMembership.find = () => { throw new Error('must not query memberships'); };
  const update = { displayname: '田中' };
  assert.deepEqual(await persistProfileImage({ userId, update }, dependencies), update);
  assert.deepEqual(calls.map(call => call[0]), ['persist']);
});

test('another association, no membership and unsupported files cannot upload', async () => {
  for (const associationId of ['other', '$ne']) {
    const { calls, dependencies } = fixture();
    await assert.rejects(persistProfileImage({ file, userId, associationId, update: {} }, dependencies), { status: 400 });
    assert.equal(calls.length, 0);
  }
  const { calls, dependencies } = fixture();
  dependencies.NeighborhoodAssociation.find = () => query([]);
  await assert.rejects(persistProfileImage({ file, userId, update: {} }, dependencies), { status: 400 });
  assert.equal(calls.length, 0);
  await assert.rejects(persistProfileImage({ file: { ...file, mimetype: 'image/svg+xml' }, userId, update: {} }, dependencies), { status: 400 });
});

test('failed or concurrent database update removes new upload and retains old photo', async () => {
  for (const concurrent of [false, true]) {
    const { calls, dependencies, previous } = fixture();
    previous.avatarDriveImage = { fileId: 'old-photo', association };
    dependencies.User.updateOne = async () => { if (concurrent) return { matchedCount: 0 }; throw new Error('write failed'); };
    await assert.rejects(persistProfileImage({ file, userId, update: {} }, dependencies), concurrent ? { status: 409 } : /write failed/);
    assert.deepEqual(calls.filter(call => call[0] === 'remove').map(call => call[1][0].fileId), ['new-photo']);
  }
});

test('old Drive photo is removed only after successfully saving its replacement', async () => {
  const { calls, dependencies, previous } = fixture();
  previous.avatarDriveImage = { fileId: 'old-photo', association };
  await persistProfileImage({ file, userId, update: {} }, dependencies);
  assert.deepEqual(calls.map(call => call[0]), ['context', 'upload', 'persist', 'remove']);
  assert.equal(calls.at(-1)[1][0].fileId, 'old-photo');
});

test('Drive connection failure does not write any profile changes', async () => {
  const { calls, dependencies } = fixture();
  dependencies.attachmentContext = async () => { throw Object.assign(new Error('connect Drive'), { status: 409 }); };
  await assert.rejects(persistProfileImage({ file, userId, update: {} }, dependencies), { status: 409 });
  assert.equal(calls.length, 0);
});

test('shared image URLs use the configured origin and require HTTPS in production', () => {
  assert.equal(profileImageUrl(userId, 'token', 'https://example.com/'), `https://example.com/profile-images/${userId}/token`);
  assert.throws(() => profileImageUrl(userId, 'token', 'http://example.com'), { status: 503 });
});

const imageFixture = ({ match = true, mimeType = 'image/jpeg' } = {}) => {
  const token = 'a'.repeat(64);
  const calls = [];
  const dependencies = {
    User: { findById: () => query({ avatar: `https://example.com/profile-images/${userId}/${match ? token : 'b'.repeat(64)}`, avatarDriveImage: { association, fileId: 'photo' } }) },
    attachmentContext: async id => { calls.push(['context', id]); return { client: { request: async () => { calls.push(['download']); return { body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('photo')); controller.close(); } }) }; } }, root: 'root' }; },
    assertDriveItem: async (client, root, id, options) => { calls.push(['ancestry', root, id, options]); return { mimeType }; }
  };
  const res = new PassThrough();
  res.headers = {};
  res.set = (name, value) => { if (typeof name === 'string') res.headers[name] = value; else Object.assign(res.headers, name); return res; };
  res.sendStatus = status => { res.statusCode = status; res.end(); return res; };
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  return { token, calls, dependencies, res, chunks };
};

test('photo delivery validates current token, Drive ancestry and content type', async () => {
  for (const options of [{}, { match: false }, { mimeType: 'text/html' }]) {
    const { token, calls, dependencies, res, chunks } = imageFixture(options);
    await profileImageHandler(dependencies)({ params: { userId, token } }, res, error => { assert.ifError(error); });
    if (options.match === false || options.mimeType) {
      assert.equal(res.statusCode, 404);
      assert.equal(calls.some(call => call[0] === 'download'), false);
    } else {
      assert.equal(Buffer.concat(chunks).toString(), 'photo');
      assert.equal(res.headers['Content-Type'], 'image/jpeg');
      assert.deepEqual(calls.find(call => call[0] === 'ancestry'), ['ancestry', 'root', 'photo', { allowRoot: false }]);
    }
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
  }
});

test('profile form retains legacy pictures and lets members select their photo storage association', async () => {
  const { default: ejs } = await import('ejs');
  const html = await ejs.renderFile('src/views/profile.ejs', {
    assetVersion: 'test', showNotificationPrompt: false, title: 'プロフィール', currentUser: null, currentPath: '/profile', csrfToken: 'token', notice: null, formError: null,
    values: { displayname: '田中', avatar: 'https://old.example/photo.jpg' }, households: [], membersByHousehold: {}, availableHouseholdRegistrations: [],
    dangerMemberships: [{ association: { _id: association, name: '中央町内会' } }]
  });
  assert.match(html, /src="https:\/\/old.example\/photo.jpg"/);
  assert.match(html, new RegExp(`<option value="${association}">中央町内会</option>`));
  assert.match(html, /name="avatarAssociation"/);
  assert.match(html, /プロフィール写真/);
});

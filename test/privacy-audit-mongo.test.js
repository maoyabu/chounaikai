import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { PrivacyAccessLog } from '../src/models/privacyAccessLog.js';
import { buildPrivacyEvent } from '../src/services/privacyAuditService.js';
import { privacyAuditQuery } from '../src/services/privacyAuditQuery.js';
import { SiteSecuritySettings } from '../src/models/siteSecuritySettings.js';
import { createSiteSecurityService } from '../src/services/siteSecurityService.js';

const uri = process.env.PRIVACY_AUDIT_TEST_MONGODB_URI;
test('real MongoDB: append-only privacy records, search indexes and cursor pagination', { skip: !uri }, async t => {
  const options = new mongoose.mongo.MongoClient(uri).options;
  assert.equal(options.srvHost, undefined);
  assert.equal(options.hosts.length, 1);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(options.hosts[0].host));
  assert.equal(options.proxyHost, undefined);
  const dbName = `chounaikai_privacy_test_${crypto.randomBytes(8).toString('hex')}`;
  const connection = await mongoose.createConnection(uri, { dbName, serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const Log = connection.model('PrivacyAccessLog', PrivacyAccessLog.schema.clone());
    await Log.createCollection(); await Log.createIndexes();
    const actor = new mongoose.Types.ObjectId(), association = new mongoose.Types.ObjectId(), target = new mongoose.Types.ObjectId();
    const at = new Date('2026-10-05T00:00:00Z');
    const event = buildPrivacyEvent({ user: { _id: actor, username: 'audit-test', isAdmin: true, hash: 'never-save' }, method: 'GET', ip: '127.0.0.1', params: { associationId: String(association) }, route: { path: '/:associationId/manage/members' } }, { category: 'residents', resource: 'association-members', data: { members: [{ user: { _id: target, email: 'never-save@example.invalid' } }] } });
    await t.test('persists safe metadata and all affected association IDs', async () => {
      await Log.create({ ...event, createdAt: at });
      const stored = await Log.findOne().lean();
      assert.equal(String(stored.actor), String(actor)); assert.equal(String(stored.associations[0]), String(association));
      assert.ok(stored.targets.includes(`user:${target}`));
      assert.ok(!JSON.stringify(stored).includes('never-save'));
      const indexes = await Log.collection.indexes();
      assert.ok(indexes.some(index => index.key.targets)); assert.ok(indexes.some(index => index.key.associations));
      assert.ok(!indexes.some(index => index.expireAfterSeconds !== undefined));
    });
    await t.test('rejects edits and deletions through the application model', async () => {
      for (const action of [() => Log.updateOne({}, { $set: { actorName: 'tampered' } }), () => Log.deleteMany({}), () => Log.findOneAndUpdate({}, { $set: { actorName: 'tampered' } }), () => Log.bulkWrite([{ deleteOne: { filter: {} } }]), async () => (await Log.findOne()).deleteOne(), async () => { const row = await Log.findOne(); row.actorName = 'tampered'; await row.save(); }]) {
        await assert.rejects(action, /append_only/);
      }
      assert.equal(await Log.countDocuments(), 1);
    });
    await t.test('filters by actor, association and target, with no duplicate cursor rows', async () => {
      await Log.insertMany(Array.from({ length: 54 }, () => ({ ...event, requestId: crypto.randomUUID(), createdAt: at })));
      const query = { from: '2026-10-05', to: '2026-10-05', actor: String(actor), association: String(association), target: String(target) };
      const first = await Log.find(privacyAuditQuery(query).filter).sort({ createdAt: -1, _id: -1 }).limit(50).lean();
      assert.equal(first.length, 50);
      const last = first.at(-1);
      const cursor = Buffer.from(JSON.stringify({ at: last.createdAt.toISOString(), id: String(last._id) })).toString('base64url');
      const second = await Log.find(privacyAuditQuery({ ...query, cursor }).filter).sort({ createdAt: -1, _id: -1 }).lean();
      assert.equal(second.length, 5);
      const firstIds = new Set(first.map(log => String(log._id)));
      assert.ok(second.every(log => !firstIds.has(String(log._id))));
      assert.deepEqual(await connection.db.listCollections({}, { nameOnly: true }).toArray().then(rows => rows.map(row => row.name)), ['chounaikai_privacy_access_logs']);
    });
    await t.test('site MFA policy defaults on and changes once with an atomic history entry', async () => {
      const Settings = connection.model('SiteSecuritySettings', SiteSecuritySettings.schema.clone());
      await Settings.createCollection();
      const policy = createSiteSecurityService(Settings);
      assert.equal((await policy.get()).mfaEnabled, true);
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => policy.change({ enabled: false, revision: 'initial', actor: { _id: actor, username: 'test-admin' } })));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.status === 409));
      const disabled = await policy.get(); assert.equal(disabled.mfaEnabled, false); assert.equal(disabled.history.length, 1);
      const enabled = await policy.change({ enabled: true, revision: disabled.revision, actor: { _id: actor, username: 'test-admin' } });
      assert.equal(enabled.mfaEnabled, true); assert.equal(enabled.history.length, 2); assert.equal(String(enabled.history[0].actor), String(actor));
      assert.equal(await Settings.countDocuments(), 1);
    });
  } finally { await connection.dropDatabase(); await connection.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { generate } from 'otplib';
import { MfaCredential, MfaEvent } from '../src/models/mfaCredential.js';
import { RoleDefinition, RoleAssignment } from '../src/models/role.js';
import { createMfaService, decryptMfaSecret } from '../src/services/mfaService.js';

const uri = process.env.MFA_TEST_MONGODB_URI;
test('real MongoDB: MFA uniqueness, replay/recovery atomicity, persistence and role dates', { skip: !uri }, async t => {
  const parsed = new mongoose.mongo.MongoClient(uri).options;
  assert.ok(!parsed.srvHost && !parsed.proxyHost && parsed.hosts.length === 1 && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hosts[0].host), 'Integration tests only accept a loopback MongoDB server');
  const dbName = `chounaikai_mfa_test_${crypto.randomBytes(8).toString('hex')}`;
  const connection = await mongoose.createConnection(uri, { dbName, serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const Credential = connection.model('MfaCredential', MfaCredential.schema.clone());
    const Event = connection.model('MfaEvent', MfaEvent.schema.clone());
    const Roles = connection.model('RoleDefinition', RoleDefinition.schema.clone());
    const Assignments = connection.model('RoleAssignment', RoleAssignment.schema.clone());
    await Promise.all([Credential, Event, Roles, Assignments].map(model => model.createIndexes()));
    const key = crypto.randomBytes(32); let now = Date.now();
    const makeService = () => createMfaService({ key, Credential, Event, Roles, Assignments, now: () => now });
    const service = makeService();
    const makeUser = () => ({ _id: new mongoose.Types.ObjectId(), isAdmin: true, email: 'test@example.invalid', hash: 'test-hash' });
    const enroll = async user => {
      const setup = service.newSetup(user), details = await service.setupDetails(user, setup);
      const code = await generate({ secret: details.secret, epoch: Math.floor(now / 1000) });
      return { setup, details, code, ...(await service.confirmSetup(user, setup, code)) };
    };
    await t.test('only one concurrent enrollment wins the user unique index', async () => {
      const user = makeUser(), setup = service.newSetup(user), details = await service.setupDetails(user, setup);
      const code = await generate({ secret: details.secret, epoch: Math.floor(now / 1000) });
      const results = await Promise.allSettled([service.confirmSetup(user, setup, code), makeService().confirmSetup(user, setup, code)]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(await Credential.countDocuments({ user: user._id }), 1);
    });
    await t.test('TOTP replay is rejected across independent service instances and simultaneous requests', async () => {
      const user = makeUser(), initial = await enroll(user); now += 30000;
      const code = await generate({ secret: initial.details.secret, epoch: Math.floor(now / 1000) });
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => (i % 2 ? service : makeService()).prove(user, { code })));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      await assert.rejects(makeService().prove(user, { code }), /使用/);
    });
    await t.test('one recovery code can be consumed only once even concurrently', async () => {
      const user = makeUser(), initial = await enroll(user);
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => makeService().prove(user, { recoveryCode: initial.codes[0] })));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(await service.recoveryCount(user), 9);
      const regenerated = await makeService().regenerateRecovery(user, { recoveryCode: initial.codes[1] });
      await assert.rejects(service.prove(user, { recoveryCode: initial.codes[2] }));
      assert.equal(await service.recoveryCount(user), 10);
      assert.equal((await service.prove(user, { recoveryCode: regenerated.codes[0] })).recovered, true);
    });
    await t.test('stored data encrypts seeds and hashes recovery codes, without modifying shared users', async () => {
      const user = makeUser(), initial = await enroll(user);
      const stored = await Credential.findOne({ user: user._id }).select('+encryptedSecret +recoveryCodeDigests').lean();
      assert.equal(decryptMfaSecret(stored.encryptedSecret, user._id, key), initial.details.secret);
      assert.ok(!JSON.stringify(stored).includes(initial.details.secret));
      initial.codes.forEach(code => assert.ok(!JSON.stringify(stored).includes(code)));
      const events = await Event.find({ user: user._id }).lean();
      assert.ok(events.some(event => event.action === 'enrolled'));
      assert.ok(!JSON.stringify(events).includes(initial.details.secret));
      assert.equal((await connection.db.listCollections({ name: 'users' }).toArray()).length, 0);
    });
    await t.test('association administrators require an active role and a current assignment', async () => {
      const association = new mongoose.Types.ObjectId();
      const role = await Roles.create({ association, name: '町内会管理者', permissions: ['association.manage'], active: true });
      const user = { ...makeUser(), isAdmin: false };
      const assignment = await Assignments.create({ association, user: user._id, role: role._id, startsAt: new Date(now + 60000) });
      assert.equal(await service.isRequired(user), false);
      await Assignments.updateOne({ _id: assignment._id }, { $set: { startsAt: new Date(now - 60000) } });
      assert.equal(await service.isRequired(user), true);
      await Assignments.updateOne({ _id: assignment._id }, { $set: { endsAt: new Date(now - 1) } });
      assert.equal(await service.isRequired(user), false);
      await Assignments.updateOne({ _id: assignment._id }, { $unset: { endsAt: '' } });
      await Roles.updateOne({ _id: role._id }, { $set: { active: false } });
      assert.equal(await service.isRequired(user), false);
    });
  } finally {
    // This is a random test database on loopback, never an application database.
    await connection.dropDatabase(); await connection.close();
  }
});

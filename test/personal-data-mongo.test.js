import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import mongoose from 'mongoose';
import { Household } from '../src/models/organization.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { migratePersonalData } from '../src/security/personalDataMigration.js';
import { PERSONAL_DATA_FIELDS, decryptPersonalData, getPersonalDataPath, personalDataKeyring } from '../src/security/personalDataCrypto.js';

const uri = process.env.PERSONAL_DATA_TEST_MONGODB_URI;
test('isolated MongoDB: address/phone persistence, access, migration and key rotation', { skip: !uri }, async t => {
  const parsed = new mongoose.mongo.MongoClient(uri).options;
  assert.ok(!parsed.srvHost && !parsed.proxyHost && parsed.hosts.length === 1 && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hosts[0].host));
  const variables = ['PERSONAL_DATA_ENCRYPTION_KEY', 'PERSONAL_DATA_KEY_VERSION', 'PERSONAL_DATA_PREVIOUS_KEYS'];
  const saved = variables.map(key => process.env[key]);
  const oldKey = randomBytes(32).toString('hex');
  process.env.PERSONAL_DATA_ENCRYPTION_KEY = oldKey;
  process.env.PERSONAL_DATA_KEY_VERSION = '1'; delete process.env.PERSONAL_DATA_PREVIOUS_KEYS;
  const connection = await mongoose.createConnection(uri, { dbName: `chounaikai_pii_test_${randomBytes(8).toString('hex')}` }).asPromise();
  const Homes = connection.model('Household', Household.schema.clone());
  const Officers = connection.model('AnnualOfficer', AnnualOfficer.schema.clone());
  const Leaders = connection.model('AnnualLeaderAssignment', AnnualLeaderAssignment.schema.clone());
  const association = new mongoose.Types.ObjectId(), district = new mongoose.Types.ObjectId(), actor = new mongoose.Types.ObjectId();
  const homeData = () => ({ association, districtGroup: district, displayName: 'テスト世帯', address: { postalCode: '1234567', street: 'テスト住所', building: 'テスト建物' }, phone: '090-0000-0000', email: 'test@example.invalid' });
  const officerData = () => ({ association, fiscalYear: 2026, name: 'テスト役員', address: 'テスト役員住所', phone: '03-0000-0000', mobilePhone: '090-1111-1111', selectedBy: actor });
  const assertEncrypted = async (model, id) => {
    const raw = await model.collection.findOne({ _id: id });
    for (const field of PERSONAL_DATA_FIELDS[model.collection.name]) {
      const value = getPersonalDataPath(raw, field);
      if (value != null && value !== '') assert.ok(value.startsWith('pii:v1:'), field);
    }
    return raw;
  };
  try {
    let home, officer;
    await t.test('create/save and repeated edits store ciphertext, return plaintext and retain unchanged fields', async () => {
      home = await Homes.create(homeData()); officer = await Officers.create(officerData());
      assert.equal(home.phone, '090-0000-0000'); assert.equal(home.address.street, 'テスト住所');
      const raw = await assertEncrypted(Homes, home._id);
      assert.equal(raw.email, 'test@example.invalid');
      home.phone = '090-2222-2222'; await home.save();
      assert.equal(home.phone, '090-2222-2222');
      home.displayName = '変更世帯'; await home.save();
      assert.equal((await Homes.findById(home._id)).address.building, 'テスト建物');
      assert.equal((await Homes.findById(home._id).lean()).phone, '090-2222-2222');
      assert.equal((await Homes.findById(home._id).select('address').lean()).address.street, 'テスト住所');
      assert.equal((await Homes.findById(home._id).select('-address -phone').lean()).phone, undefined);
      await assertEncrypted(Homes, home._id); await assertEncrypted(Officers, officer._id);
      const leaders = await Leaders.create({ association, fiscalYear: 2026, districtGroup: district, name: '班長', address: '班長住所', phone: '03-1111-1111', mobilePhone: '090-3333-3333', assignedBy: actor });
      await assertEncrypted(Leaders, leaders._id);
    });
    await t.test('lean/non-lean populate decrypt the household reference', async () => {
      const Holder = connection.model('PiiHolder', new mongoose.Schema({ household: { type: mongoose.Schema.Types.ObjectId, ref: 'Household' } }));
      const holder = await Holder.create({ household: home._id });
      assert.equal((await Holder.findById(holder._id).populate('household')).household.phone, '090-2222-2222');
      assert.equal((await Holder.findById(holder._id).populate('household', 'address phone').lean()).household.address.street, 'テスト住所');
    });
    await t.test('failed saves restore plaintext in memory and leave stored records unchanged', async () => {
      await Homes.collection.createIndex({ displayName: 1 }, { unique: true });
      const duplicate = new Homes(homeData()); duplicate.displayName = home.displayName;
      await assert.rejects(duplicate.save(), error => error.code === 11000);
      assert.equal(duplicate.phone, '090-0000-0000'); assert.equal(duplicate.address.street, 'テスト住所');
      duplicate.displayName = '再試行世帯'; await duplicate.save();
      await assertEncrypted(Homes, duplicate._id);
      await Homes.collection.deleteOne({ _id: duplicate._id });
      await Homes.collection.dropIndex('displayName_1');
    });
    await t.test('single-record updates encrypt dot and whole address paths, unset works', async () => {
      await Homes.updateOne({ _id: home._id }, { $set: { 'address.street': '新住所', phone: '03-2222-2222' } });
      assert.equal((await Homes.findById(home._id)).address.street, '新住所');
      const changed = await Homes.findOneAndUpdate({ _id: home._id }, { $set: { address: { postalCode: '9999999', street: '更新住所' } } }, { new: true }).lean();
      assert.equal(changed.address.street, '更新住所');
      await Homes.updateOne({ _id: home._id }, { $unset: { phone: '' } });
      assert.equal((await Homes.findById(home._id).lean()).phone, undefined);
      await assertEncrypted(Homes, home._id);
    });
    await t.test('annual copy insertMany decrypts outputs and rebinds ciphertext to new IDs', async () => {
      const source = await Officers.findById(officer._id).lean();
      const { _id, createdAt, updatedAt, ...data } = source;
      const [copy] = await Officers.insertMany([{ ...data, fiscalYear: 2027 }]);
      assert.equal(copy.address, source.address);
      const sourceRaw = await assertEncrypted(Officers, _id), copyRaw = await assertEncrypted(Officers, copy._id);
      assert.notEqual(sourceRaw.address, copyRaw.address);
      assert.throws(() => decryptPersonalData(sourceRaw.address, 'annual_officers', copy._id, 'address'));
      assert.equal((await Officers.findById(copy._id)).mobilePhone, '090-1111-1111');
      copy.phone = '03-3333-3333'; await copy.save(); await assertEncrypted(Officers, copy._id);
    });
    await t.test('unsafe update/query APIs fail closed; unrelated updates still work', async () => {
      await assert.rejects(Homes.updateMany({}, { $set: { phone: 'x' } }), /personal_data/);
      await assert.rejects(Homes.updateOne({ displayName: '変更世帯' }, { $set: { phone: 'x' } }), /personal_data/);
      await assert.rejects(Homes.updateOne({ _id: home._id }, [{ $set: { phone: 'x' } }]), /personal_data/);
      await assert.rejects(Homes.replaceOne({ _id: home._id }, homeData()), /personal_data/);
      await assert.rejects(Homes.bulkWrite([{ updateOne: { filter: { _id: home._id }, update: { $set: { phone: 'x' } } } }]), /personal_data/);
      await assert.rejects(Homes.find({ phone: /090/ }), /personal_data/);
      await assert.rejects(Homes.find({}).sort('address.street'), /personal_data/);
      await assert.rejects(Homes.find({}).select('-_id'), /personal_data/);
      await assert.rejects(Homes.distinct('phone'), /personal_data/);
      await assert.rejects(Homes.aggregate([{ $match: {} }]), /personal_data/);
      await Homes.updateMany({ association }, { $set: { active: false } });
      assert.equal((await Homes.findById(home._id)).active, false);
    });
    await t.test('missing/wrong keys and tampering fail without returning ciphertext/plaintext', async () => {
      const value = process.env.PERSONAL_DATA_ENCRYPTION_KEY;
      delete process.env.PERSONAL_DATA_ENCRYPTION_KEY;
      await assert.rejects(Homes.create(homeData()), /PERSONAL_DATA_ENCRYPTION_KEY/);
      await assert.rejects(Homes.findById(home._id));
      process.env.PERSONAL_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
      await assert.rejects(Homes.findById(home._id));
      process.env.PERSONAL_DATA_ENCRYPTION_KEY = value;
      const raw = await Homes.collection.findOne({ _id: home._id });
      await Homes.collection.updateOne({ _id: home._id }, { $set: { 'address.street': 'pii:v1:broken' } });
      await assert.rejects(Homes.findById(home._id).lean(), /personal_data_encryption_failed/);
      await Homes.collection.updateOne({ _id: home._id }, { $set: { address: raw.address } });
    });
    await t.test('migration compare-and-set does not overwrite a concurrent change', async () => {
      const legacy = new mongoose.Types.ObjectId();
      await Homes.collection.insertOne({ _id: legacy, ...homeData() });
      let edited = false;
      const proxyDb = { collection(name) {
        const collection = connection.db.collection(name);
        return {
          find: (...args) => collection.find(...args),
          updateOne: async (...args) => {
            if (name === 'households' && !edited) {
              edited = true;
              await collection.updateOne({ _id: legacy }, { $set: { phone: '03-9999-9999' } });
            }
            return collection.updateOne(...args);
          }
        };
      } };
      const conflicted = await migratePersonalData(proxyDb, { apply: true });
      assert.equal(conflicted.households.conflicts, 1);
      assert.equal((await Homes.collection.findOne({ _id: legacy })).phone, '03-9999-9999');
      assert.equal((await migratePersonalData(connection.db, { apply: true })).households.updatedDocuments, 1);
      assert.equal((await Homes.findById(legacy)).phone, '03-9999-9999');
      await Homes.collection.deleteOne({ _id: legacy });
    });
    await t.test('migration dry-run, resume/re-run, invalid records and rotation preserve scope', async () => {
      const legacyId = new mongoose.Types.ObjectId();
      await Homes.collection.insertOne({ _id: legacyId, ...homeData(), active: false });
      await assert.rejects(Homes.findById(legacyId), /personal_data_encryption_failed/);
      await connection.db.collection('users').insertOne({ email: 'shared@example.invalid', address: '共有の対象外' });
      const dry = await migratePersonalData(connection.db);
      assert.equal(dry.households.legacyFields, 4); assert.equal(dry.households.updatedDocuments, 0);
      const done = await migratePersonalData(connection.db, { apply: true });
      assert.equal(done.households.updatedDocuments, 1);
      assert.equal((await Homes.findById(legacyId)).phone, '090-0000-0000');
      assert.equal((await migratePersonalData(connection.db, { apply: true })).households.pendingDocuments, 0);
      process.env.PERSONAL_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
      process.env.PERSONAL_DATA_KEY_VERSION = '2';
      process.env.PERSONAL_DATA_PREVIOUS_KEYS = JSON.stringify({ 1: oldKey });
      const rotation = await migratePersonalData(connection.db, { apply: true, rotate: true });
      assert.ok(rotation.households.updatedDocuments > 0);
      delete process.env.PERSONAL_DATA_PREVIOUS_KEYS;
      assert.equal((await Homes.findById(legacyId).lean()).address.street, 'テスト住所');
      assert.equal((await connection.db.collection('users').findOne({})).address, '共有の対象外');
      const invalidId = new mongoose.Types.ObjectId();
      await Homes.collection.insertOne({ _id: invalidId, ...homeData(), phone: 'pii:v1:broken' });
      const invalid = await migratePersonalData(connection.db, { apply: true });
      assert.equal(invalid.households.invalidFields, 1);
      assert.equal((await Homes.collection.findOne({ _id: invalidId })).address.street, 'テスト住所');
      await Homes.collection.deleteOne({ _id: invalidId });
      // A backup restored into the same collection/ID decrypts with its original key.
      const backup = await Homes.collection.findOne({ _id: legacyId });
      await Homes.collection.deleteOne({ _id: legacyId }); await Homes.collection.insertOne(backup);
      assert.equal((await Homes.findById(legacyId)).address.street, 'テスト住所');
      assert.ok(personalDataKeyring());
    });
    await t.test('migration CLI defaults to dry-run, requires maintenance flag and never prints personal values', async () => {
      const databaseUri = new URL(uri); databaseUri.pathname = `/${connection.db.databaseName}`;
      const run = args => spawnSync(process.execPath, ['scripts/migratePersonalData.js', ...args], {
        cwd: new URL('..', import.meta.url).pathname,
        env: { ...process.env, MONGODB_URI: databaseUri.toString(), NODE_ENV: 'development', MONGODB_SOCKS_PROXY_URL: '', FIXIE_SOCKS_HOST: '', MONGODB_TLS_CA_FILE: '', MONGODB_ALLOWED_HOSTS: '' }, encoding: 'utf8', timeout: 10000
      });
      assert.equal(run(['--apply']).status, 1);
      const legacy = new mongoose.Types.ObjectId();
      await Homes.collection.insertOne({ _id: legacy, ...homeData() });
      const dry = run([]); assert.equal(dry.status, 0, dry.stderr);
      assert.equal((await Homes.collection.findOne({ _id: legacy })).address.street, 'テスト住所');
      const apply = run(['--apply', '--maintenance-confirmed']); assert.equal(apply.status, 0, apply.stderr);
      for (const result of [dry, apply]) {
        assert.ok(!`${result.stdout}${result.stderr}`.includes('テスト住所'));
        assert.ok(!`${result.stdout}${result.stderr}`.includes(process.env.PERSONAL_DATA_ENCRYPTION_KEY));
      }
      assert.equal((await Homes.findById(legacy)).address.street, 'テスト住所');
      const bad = new mongoose.Types.ObjectId(), pending = new mongoose.Types.ObjectId();
      await Homes.collection.insertMany([{ _id: bad, ...homeData(), phone: 'pii:v1:broken' }, { _id: pending, ...homeData() }]);
      assert.equal(run(['--apply', '--maintenance-confirmed']).status, 1);
      assert.equal((await Homes.collection.findOne({ _id: pending })).address.street, 'テスト住所');
      const malformed = new mongoose.Types.ObjectId();
      await Homes.collection.insertOne({ _id: malformed, ...homeData(), address: '旧形式の住所文字列' });
      await assert.rejects(Homes.findById(malformed).lean(), /personal_data_encryption_failed/);
      const inspected = await migratePersonalData(connection.db);
      assert.equal(inspected.households.invalidFields, 2);
    });
  } finally {
    await connection.dropDatabase(); await connection.close();
    variables.forEach((key, index) => saved[index] === undefined ? delete process.env[key] : process.env[key] = saved[index]);
  }
});

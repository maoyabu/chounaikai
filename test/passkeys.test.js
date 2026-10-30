import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { encodeCBOR } from '@levischuck/tiny-cbor';
import { passkeyConfig, createPasskeyService } from '../src/services/passkeyService.js';
import { PasskeyAccount, PasskeyCredential, PasskeyFlow } from '../src/models/passkey.js';

test('passkey origin is pinned to the configured HTTPS host or development localhost', () => {
  assert.deepEqual(passkeyConfig({ publicBaseUrl: 'https://example.com', nodeEnv: 'production' }),
    { rpId: 'example.com', origin: 'https://example.com', rpName: 'まちの伝言板' });
  assert.equal(passkeyConfig({ publicBaseUrl: 'http://localhost:3003' }).rpId, 'localhost');
  for (const value of ['http://example.com', 'https://example.com/path', 'https://user:password@example.com', 'https://example.com?x=1']) {
    assert.throws(() => passkeyConfig({ publicBaseUrl: value, nodeEnv: 'production' }));
  }
  assert.throws(() => passkeyConfig({ publicBaseUrl: 'http://127.0.0.1:3003' }));
});

test('registration options require discoverable, user-verified keys and flows cannot be reused', async () => {
  const accounts = new Map(), flows = new Map();
  const Accounts = {
    async findOne({ user }) { return accounts.get(String(user)); },
    async create(value) { const account = { ...value }; accounts.set(String(value.user), account); return account; }
  };
  const Credentials = {
    async countDocuments() { return 0; },
    find() { return { select() { return { lean: async () => [] }; } }; }
  };
  const Flows = {
    async create(value) { flows.set(value.flowId, value); },
    async findOneAndDelete(query) {
      const row = flows.get(query.flowId);
      if (!row || row.bindingHash !== query.bindingHash || row.mode !== query.mode || row.rpId !== query.rpId || row.expiresAt <= query.expiresAt.$gt) return null;
      flows.delete(query.flowId); return row;
    }
  };
  const service = createPasskeyService({ config: passkeyConfig(), Accounts, Credentials, Flows });
  const user = { _id: 'abc', username: 'resident', displayname: '住民', hash: 'password-hash' };
  const { options, flowId } = await service.startRegistration(user, 'browser-one');
  assert.equal(options.rp.id, 'localhost');
  assert.equal(options.authenticatorSelection.residentKey, 'required');
  assert.equal(options.authenticatorSelection.userVerification, 'required');
  assert.equal(options.attestation, 'none');
  await assert.rejects(service.finishRegistration({ user, binding: 'other-browser', flowId, response: {} }), /パスキー/);
  await assert.rejects(service.finishRegistration({ user: { ...user, hash: 'changed' }, binding: 'browser-one', flowId, response: {} }), /パスキー/);
  await assert.rejects(service.finishRegistration({ user, binding: 'browser-one', flowId, response: {} }), /パスキー/);
  const auth = await service.startAuthentication('browser-one');
  assert.equal(auth.options.userVerification, 'required');
  assert.deepEqual(auth.options.allowCredentials, []);
  await assert.rejects(service.finishAuthentication({ binding: 'other-browser', flowId: auth.flowId, response: {} }), /パスキー/);
  await assert.rejects(service.finishAuthentication({ binding: 'browser-one', flowId: auth.flowId, response: {} }), /パスキー/);
  await assert.rejects(service.finishAuthentication({ binding: 'browser-one', flowId: auth.flowId, response: {} }), /パスキー/);
});

test('passkey data is isolated from shared users and has unique credential and expiring flow indexes', () => {
  assert.equal(PasskeyAccount.collection.name, 'chounaikai_passkey_accounts');
  assert.equal(PasskeyCredential.collection.name, 'chounaikai_passkey_credentials');
  assert.equal(PasskeyFlow.collection.name, 'chounaikai_passkey_flows');
  assert.ok(PasskeyCredential.schema.indexes().some(([fields, options]) => fields.rpId === 1 && fields.credentialId === 1 && options.unique));
  assert.ok(PasskeyFlow.schema.indexes().some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0));
});

test('real WebAuthn attestation and signed assertion register and authenticate once', async () => {
  const user = { _id: 'abc', username: 'resident', displayname: '住民', hash: 'password-hash' };
  let account, credential;
  const flows = new Map();
  const Accounts = {
    async findOne() { return account; },
    async create(data) { account = data; return data; }
  };
  const Credentials = {
    async countDocuments() { return credential ? 1 : 0; },
    find() { return { select() { return { lean: async () => [] }; } }; },
    async create(data) { credential = { _id: '507f1f77bcf86cd799439011', version: 0, ...data }; return credential; },
    async findOne({ credentialId }) { return credential?.credentialId === credentialId ? credential : null; },
    async findOneAndUpdate(query, update) {
      if (!credential || credential.version !== query.version) return null;
      Object.assign(credential, update.$set); credential.version += update.$inc.version; return credential;
    }
  };
  const Flows = {
    async create(data) { flows.set(data.flowId, data); },
    async findOneAndDelete(query) {
      const flow = flows.get(query.flowId);
      if (!flow || flow.bindingHash !== query.bindingHash || flow.mode !== query.mode || flow.expiresAt <= query.expiresAt.$gt) return null;
      flows.delete(query.flowId); return flow;
    }
  };
  const Users = { findById() { return { select: async () => user }; } };
  const service = createPasskeyService({ config: passkeyConfig(), Accounts, Credentials, Flows, Users });
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = keyPair.publicKey.export({ format: 'jwk' });
  const toBuffer = value => Buffer.from(value, 'base64url');
  const b64 = value => Buffer.from(value).toString('base64url');
  const id = randomBytes(32);
  const rpHash = createHash('sha256').update('localhost').digest();
  const registration = await service.startRegistration(user, 'browser');
  const cose = encodeCBOR(new Map([[1, 2], [3, -7], [-1, 1], [-2, toBuffer(jwk.x)], [-3, toBuffer(jwk.y)]]));
  const regAuth = Buffer.concat([rpHash, Buffer.from([0x45, 0, 0, 0, 0]), Buffer.alloc(16),
    Buffer.from([0, id.length]), id, Buffer.from(cose)]);
  const client = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin: 'http://localhost:3003', crossOrigin: false }));
  const regResponse = { id: b64(id), rawId: b64(id), type: 'public-key', response: {
    clientDataJSON: b64(client('webauthn.create', registration.options.challenge)),
    attestationObject: b64(encodeCBOR(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', regAuth]]))),
    transports: ['internal'] } };
  const saved = await service.finishRegistration({ user, binding: 'browser', flowId: registration.flowId, response: regResponse });
  assert.equal(saved.id, credential._id);
  const authentication = await service.startAuthentication('browser');
  const authData = Buffer.concat([rpHash, Buffer.from([0x05, 0, 0, 0, 1])]);
  const authClient = client('webauthn.get', authentication.options.challenge);
  const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(authClient).digest()]), keyPair.privateKey);
  const authResponse = { id: b64(id), rawId: b64(id), type: 'public-key', response: {
    authenticatorData: b64(authData), clientDataJSON: b64(authClient), signature: b64(signature), userHandle: account.userHandle } };
  const result = await service.finishAuthentication({ binding: 'browser', flowId: authentication.flowId, response: authResponse });
  assert.equal(result.user, user);
  assert.equal(credential.counter, 1);
  await assert.rejects(service.finishAuthentication({ binding: 'browser', flowId: authentication.flowId, response: authResponse }), /パスキー/);
});

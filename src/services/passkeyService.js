import { createHash, randomBytes } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { PasskeyAccount, PasskeyCredential, PasskeyFlow } from '../models/passkey.js';
import { User } from '../models/user.js';
import { eligibleLineUser } from './lineLoginService.js';
import { passwordFingerprint } from './mfaService.js';

const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const invalid = () => Object.assign(new Error('パスキーを確認できませんでした。最初からやり直してください。'), { status: 400 });

export const passkeyConfig = ({ publicBaseUrl, nodeEnv = 'development' } = {}) => {
  const url = new URL(publicBaseUrl || (nodeEnv === 'production' ? 'https://invalid.invalid' : 'http://localhost:3003'));
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(nodeEnv !== 'production' && url.protocol === 'http:' && url.hostname === 'localhost'))) {
    throw new Error('Passkeys require a valid PUBLIC_BASE_URL origin (HTTPS or localhost)');
  }
  if (nodeEnv === 'production' && !publicBaseUrl) throw new Error('Passkeys require PUBLIC_BASE_URL in production');
  return { rpId: url.hostname, origin: url.origin, rpName: 'まちの伝言板' };
};

export const createPasskeyService = ({ config, Accounts = PasskeyAccount, Credentials = PasskeyCredential, Flows = PasskeyFlow, Users = User, now = Date.now } = {}) => {
  const enabled = Boolean(config);
  const ensure = () => { if (!enabled) throw invalid(); };
  const createFlow = async (data, binding) => {
    const flowId = random();
    await Flows.create({ ...data, flowId, bindingHash: hash(binding), rpId: config.rpId, expiresAt: new Date(now() + 5 * 60_000) });
    return flowId;
  };
  const consume = async ({ flowId, binding, mode }) => {
    if (typeof flowId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(flowId) || typeof binding !== 'string') throw invalid();
    const flow = await Flows.findOneAndDelete({ flowId, bindingHash: hash(binding), mode, rpId: config.rpId, expiresAt: { $gt: new Date(now()) } });
    if (!flow) throw invalid();
    return flow;
  };
  return {
    enabled,
    async list(user) {
      ensure();
      return Credentials.find({ user, rpId: config.rpId }).sort({ createdAt: -1 }).select('_id name createdAt lastUsedAt backedUp').lean();
    },
    async startRegistration(user, binding) {
      ensure();
      if (!eligibleLineUser(user)) throw invalid();
      const count = await Credentials.countDocuments({ user: user._id, rpId: config.rpId });
      if (count >= 10) throw Object.assign(new Error('登録できるパスキーは10件までです。'), { status: 409 });
      let account = await Accounts.findOne({ user: user._id, rpId: config.rpId });
      if (!account) {
        try { account = await Accounts.create({ user: user._id, rpId: config.rpId, userHandle: random() }); }
        catch (error) { if (error.code !== 11000) throw error; account = await Accounts.findOne({ user: user._id, rpId: config.rpId }); }
      }
      const existing = await Credentials.find({ user: user._id, rpId: config.rpId }).select('credentialId transports').lean();
      const options = await generateRegistrationOptions({ rpName: config.rpName, rpID: config.rpId,
        userID: Buffer.from(account.userHandle, 'base64url'), userName: user.username || user.email || '利用者',
        userDisplayName: user.displayname || user.username || '利用者', attestationType: 'none',
        excludeCredentials: existing.map(item => ({ id: item.credentialId, transports: item.transports })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        supportedAlgorithmIDs: [-7, -257], preferredAuthenticatorType: 'localDevice' });
      const flowId = await createFlow({ mode: 'register', challenge: options.challenge, user: user._id,
        fingerprint: passwordFingerprint(user), userHandle: account.userHandle }, binding);
      return { flowId, options };
    },
    async finishRegistration({ user, binding, flowId, response }) {
      ensure();
      const flow = await consume({ flowId, binding, mode: 'register' });
      if (!eligibleLineUser(user) || String(flow.user) !== String(user._id) || flow.fingerprint !== passwordFingerprint(user)) throw invalid();
      const account = await Accounts.findOne({ user: user._id, rpId: config.rpId, userHandle: flow.userHandle });
      if (!account || await Credentials.countDocuments({ user: user._id, rpId: config.rpId }) >= 10) throw invalid();
      const result = await verifyRegistrationResponse({ response, expectedChallenge: flow.challenge,
        expectedOrigin: config.origin, expectedRPID: config.rpId, requireUserPresence: true, requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257] });
      if (!result.verified || !result.registrationInfo?.userVerified) throw invalid();
      const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
      const item = await Credentials.create({ user: user._id, rpId: config.rpId, credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey), counter: credential.counter, transports: credential.transports || [],
        deviceType: credentialDeviceType, backedUp: credentialBackedUp, name: 'パスキー' });
      return { id: String(item._id), name: item.name };
    },
    async startAuthentication(binding) {
      ensure();
      const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', allowCredentials: [] });
      const flowId = await createFlow({ mode: 'authenticate', challenge: options.challenge }, binding);
      return { flowId, options };
    },
    async finishAuthentication({ binding, flowId, response }) {
      ensure();
      const flow = await consume({ flowId, binding, mode: 'authenticate' });
      if (!response || typeof response.id !== 'string' || !response.response?.userHandle) throw invalid();
      const item = await Credentials.findOne({ rpId: config.rpId, credentialId: response.id });
      if (!item) throw invalid();
      const account = await Accounts.findOne({ user: item.user, rpId: config.rpId });
      if (!account || account.userHandle !== response.response.userHandle) throw invalid();
      const result = await verifyAuthenticationResponse({ response, expectedChallenge: flow.challenge,
        expectedOrigin: config.origin, expectedRPID: config.rpId, requireUserVerification: true,
        credential: { id: item.credentialId, publicKey: new Uint8Array(item.publicKey), counter: item.counter, transports: item.transports } });
      if (!result.verified || !result.authenticationInfo.userVerified) throw invalid();
      const updated = await Credentials.findOneAndUpdate({ _id: item._id, version: item.version },
        { $set: { counter: result.authenticationInfo.newCounter, lastUsedAt: new Date(now()), backedUp: result.authenticationInfo.credentialBackedUp }, $inc: { version: 1 } }, { new: true });
      if (!updated) throw invalid();
      const user = await Users.findById(item.user).select('+hash');
      if (!eligibleLineUser(user)) throw invalid();
      return { user, credential: updated };
    },
    async remove(user, id) {
      ensure();
      return Credentials.findOneAndDelete({ _id: id, user, rpId: config.rpId });
    },
    async validSession(user, marker) {
      if (!enabled || !marker || marker.fingerprint !== passwordFingerprint(user)) return false;
      return Boolean(await Credentials.exists({ _id: marker.credentialId, user: user._id, rpId: config.rpId }));
    }
  };
};

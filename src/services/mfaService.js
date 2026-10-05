import crypto from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { MfaCredential, MfaEvent } from '../models/mfaCredential.js';
import { RoleDefinition, RoleAssignment } from '../models/role.js';

export const MFA_PENDING_MS = 10 * 60 * 1000;
export const MFA_SESSION_MS = 12 * 60 * 60 * 1000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const passwordFingerprint = user => crypto.createHash('sha256').update(String(user.hash || '')).digest('hex');
export const recoveryDigest = (userId, code) => crypto.createHash('sha256').update(`${userId}:${code.replace(/[\s-]/g, '').toUpperCase()}`).digest('hex');
export const makeRecoveryCodes = () => Array.from({ length: 10 }, () => crypto.randomBytes(16).toString('hex').toUpperCase().match(/.{8}/g).join('-'));

export const encryptMfaSecret = (secret, userId, key) => {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`chounaikai-mfa:${userId}`));
  return [iv, Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]), cipher.getAuthTag()].map(value => value.toString('base64')).join('.');
};
export const decryptMfaSecret = (encrypted, userId, key) => {
  try {
    const [iv, ciphertext, tag] = encrypted.split('.').map(value => Buffer.from(value, 'base64'));
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`chounaikai-mfa:${userId}`)); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8');
  } catch { throw fail('多要素認証の設定を読み込めません。システム管理者へお問い合わせください。', 503); }
};

export const createMfaService = ({ key, Credential = MfaCredential, Event = MfaEvent, Roles = RoleDefinition, Assignments = RoleAssignment, now = Date.now }) => {
  const event = (user, action) => Event.create({ user: user._id, action });
  const isRequired = async user => {
    if (user.isAdmin) return true;
    const roleIds = await Roles.distinct('_id', { active: true, permissions: 'association.manage' });
    if (!roleIds.length) return false;
    const date = new Date(now());
    return Boolean(await Assignments.exists({ user: user._id, role: { $in: roleIds }, startsAt: { $lte: date },
      $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: date } }] }));
  };
  const getState = async user => ({
    required: await isRequired(user),
    credential: await Credential.findOne({ user: user._id }).select('user enabledAt revision').lean()
  });
  const read = user => Credential.findOne({ user: user._id }).select('+encryptedSecret +recoveryCodeDigests').lean();
  const checkTotp = async (secret, code, lastUsedStep) => {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return { valid: false };
    return verify({ secret, token: code.trim(), epoch: Math.floor(now() / 1000), epochTolerance: 30, afterTimeStep: lastUsedStep });
  };
  const newSetup = (user, revision = null) => ({ userId: String(user._id), revision,
    encryptedSecret: encryptMfaSecret(generateSecret(), user._id, key), expiresAt: now() + MFA_PENDING_MS });
  const setupDetails = async (user, setup) => {
    if (!setup || setup.userId !== String(user._id) || setup.expiresAt <= now()) throw fail('設定の有効期限が切れました。もう一度設定を開始してください。');
    const secret = decryptMfaSecret(setup.encryptedSecret, user._id, key);
    const uri = generateURI({ issuer: '町内会管理', label: user.email || user.username, secret });
    return { secret, qrCode: await QRCode.toDataURL(uri, { width: 256, margin: 2 }), expiresAt: setup.expiresAt };
  };
  const confirmSetup = async (user, setup, code) => {
    await setupDetails(user, setup);
    const result = await checkTotp(decryptMfaSecret(setup.encryptedSecret, user._id, key), code);
    if (!result.valid) { await event(user, 'verification_failed'); throw fail('認証コードを確認してください。アプリの新しい6桁コードを入力してください。'); }
    const codes = makeRecoveryCodes();
    const values = { encryptedSecret: setup.encryptedSecret, enabledAt: new Date(now()), revision: crypto.randomUUID(),
      lastUsedStep: result.timeStep, recoveryCodeDigests: codes.map(code => recoveryDigest(user._id, code)) };
    let credential;
    if (setup.revision) {
      credential = await Credential.findOneAndUpdate({ user: user._id, revision: setup.revision }, { $set: values }, { new: true }).lean();
      if (!credential) throw fail('認証設定が変更されました。もう一度ログインしてください。', 409);
    } else {
      try { credential = await Credential.create({ user: user._id, ...values }); }
      catch (error) { if (error.code === 11000) throw fail('多要素認証はすでに設定されています。ログインをやり直してください。', 409); throw error; }
    }
    await event(user, setup.revision ? 'authenticator_changed' : 'enrolled');
    return { credential, codes };
  };
  const prove = async (user, { code, recoveryCode }) => {
    const credential = await read(user);
    if (!credential?.enabledAt) throw fail('先に多要素認証を設定してください。');
    let updated;
    let recovered = false;
    if (typeof recoveryCode === 'string' && recoveryCode.trim()) {
      if (code || !/^[A-F0-9]{32}$/.test(recoveryCode.replace(/[\s-]/g, '').toUpperCase())) throw fail('復旧コードを確認してください。');
      const digest = recoveryDigest(user._id, recoveryCode);
      updated = await Credential.findOneAndUpdate({ user: user._id, revision: credential.revision, recoveryCodeDigests: digest },
        { $pull: { recoveryCodeDigests: digest } }, { new: true }).lean();
      recovered = true;
    } else {
      const result = await checkTotp(decryptMfaSecret(credential.encryptedSecret, user._id, key), code, credential.lastUsedStep);
      if (result.valid) updated = await Credential.findOneAndUpdate({ user: user._id, revision: credential.revision, lastUsedStep: { $lt: result.timeStep } },
        { $set: { lastUsedStep: result.timeStep } }, { new: true }).lean();
    }
    if (!updated) { await event(user, 'verification_failed'); throw fail('コードが正しくないか、すでに使用されています。新しいコードを入力してください。'); }
    await event(user, recovered ? 'recovery_used' : 'verified');
    return { credential: updated, recovered };
  };
  const regenerateRecovery = async (user, proof) => {
    const { credential } = await prove(user, proof);
    const codes = makeRecoveryCodes();
    const updated = await Credential.findOneAndUpdate({ user: user._id, revision: credential.revision },
      { $set: { revision: crypto.randomUUID(), recoveryCodeDigests: codes.map(code => recoveryDigest(user._id, code)) } }, { new: true }).lean();
    if (!updated) throw fail('認証設定が変更されました。もう一度ログインしてください。', 409);
    await event(user, 'recovery_regenerated');
    return { credential: updated, codes };
  };
  const checkPassword = async (user, password) => {
    if (typeof password !== 'string' || !password || password.length > 1024 || !(await user.authenticate(password)).user) throw fail('現在のパスワードを確認してください。');
  };
  const recoveryCount = async user => (await read(user))?.recoveryCodeDigests?.length || 0;
  return { getState, isRequired, newSetup, setupDetails, confirmSetup, prove, regenerateRecovery, checkPassword, recoveryCount };
};

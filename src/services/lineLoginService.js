import { randomBytes, createHash } from 'node:crypto';
import { LineIdentity, LineFlow } from '../models/lineIdentity.js';
import { User } from '../models/user.js';
import { passwordFingerprint } from './mfaService.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const fail = message => Object.assign(new Error(message), { status: 400 });
export const eligibleLineUser = user => Boolean(user && !user.unsubscribe_date && (!user.emailVerificationRequired || user.emailVerifiedAt));

export const lineLoginConfig = ({ env = process.env, publicBaseUrl = env.PUBLIC_BASE_URL, nodeEnv = env.NODE_ENV } = {}) => {
  const channelId = String(env.LINE_LOGIN_CHANNEL_ID || '').trim();
  const channelSecret = String(env.LINE_LOGIN_CHANNEL_SECRET || '').trim();
  if (!channelId && !channelSecret) return null;
  if (!/^\d+$/.test(channelId) || !channelSecret) throw new Error('LINE_LOGIN_CHANNEL_ID and LINE_LOGIN_CHANNEL_SECRET are required together');
  const url = new URL(publicBaseUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(nodeEnv !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('LINE login requires a valid PUBLIC_BASE_URL origin (HTTPS in production)');
  }
  return { channelId, channelSecret, callbackUrl: `${url.origin}/auth/line/callback` };
};

export const createLineLoginService = ({ config, Identity = LineIdentity, Flow = LineFlow, Users = User, fetchImpl = fetch, now = Date.now } = {}) => {
  const enabled = Boolean(config);
  const ensureEnabled = () => { if (!enabled) throw fail('LINEログインは現在準備中です。'); };
  const post = async (endpoint, values) => {
    try {
      const response = await fetchImpl(`https://api.line.me/oauth2/v2.1/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values), signal: AbortSignal.timeout(10000), redirect: 'error'
      });
      if (!response.ok) throw new Error('line_rejected');
      return await response.json();
    } catch { throw fail('LINEでの確認に失敗しました。時間をおいて、最初からやり直してください。'); }
  };
  return {
    enabled,
    async status(user) { return enabled ? Identity.findOne({ channelId: config.channelId, user, subject: { $exists: true } }).lean() : null; },
    async start({ binding, mode, user }) {
      ensureEnabled();
      const state = random(), nonce = random(), verifier = random();
      let identityId;
      if (mode === 'link') {
        const slot = await Identity.findOneAndUpdate({ channelId: config.channelId, user: user._id },
          { $setOnInsert: { channelId: config.channelId, user: user._id } }, { upsert: true, new: true }).lean();
        if (slot.subject) throw fail('すでにLINEと連携されています。');
        identityId = slot._id;
      }
      await Flow.create({ stateHash: hash(state), bindingHash: hash(binding), channelId: config.channelId,
        mode, user: user?._id, fingerprint: user ? passwordFingerprint(user) : undefined,
        identityId, nonce, verifier, expiresAt: new Date(now() + 10 * 60 * 1000) });
      const url = new URL('https://access.line.me/oauth2/v2.1/authorize');
      url.search = new URLSearchParams({ response_type: 'code', client_id: config.channelId,
        redirect_uri: config.callbackUrl, scope: 'openid', state, nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      return url.toString();
    },
    async consume({ state, binding }) {
      ensureEnabled();
      if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state) || typeof binding !== 'string' || !binding) throw fail('ログイン操作を確認できません。最初からやり直してください。');
      // Atomic deletion prevents replay even with simultaneous callback requests.
      const flow = await Flow.findOneAndDelete({ stateHash: hash(state), bindingHash: hash(binding), channelId: config.channelId, expiresAt: { $gt: new Date(now()) } }).lean();
      if (!flow) throw fail('ログイン操作の有効期限が切れたか、すでに使用されています。最初からやり直してください。');
      return flow;
    },
    async authenticate(code, flow) {
      ensureEnabled();
      if (typeof code !== 'string' || !code || code.length > 2048) throw fail('LINEでの認証が完了しませんでした。');
      const tokens = await post('token', { grant_type: 'authorization_code', code, redirect_uri: config.callbackUrl,
        client_id: config.channelId, client_secret: config.channelSecret, code_verifier: flow.verifier });
      if (typeof tokens.id_token !== 'string' || !tokens.id_token) throw fail('LINEからの応答を確認できません。');
      // Use LINE's server-side ID-token verification, never trust a decoded JWT.
      const claims = await post('verify', { id_token: tokens.id_token, client_id: config.channelId, nonce: flow.nonce });
      if (claims.iss !== 'https://access.line.me' || claims.aud !== config.channelId || claims.nonce !== flow.nonce ||
          typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 ||
          !Number.isFinite(claims.exp) || claims.exp * 1000 <= now()) throw fail('LINEからの応答を確認できません。');
      return claims.sub;
    },
    async link(subject, flow, currentUser) {
      if (!eligibleLineUser(currentUser) || String(flow.user) !== String(currentUser._id) || flow.fingerprint !== passwordFingerprint(currentUser)) throw fail('アカウントの状態が変わりました。最初から連携してください。');
      try {
        // Unlink deletes this slot, so an in-flight callback cannot recreate it.
        const linked = await Identity.findOneAndUpdate({ _id: flow.identityId, channelId: config.channelId, user: currentUser._id, subject: { $exists: false } },
          { $set: { subject } }, { new: true }).lean();
        if (!linked) throw fail('連携操作が取り消されたか、すでに完了しています。最初からやり直してください。');
        return linked;
      }
      catch (error) { if (error.code === 11000) throw fail('このLINEまたは会員アカウントはすでに連携されています。既存の連携を確認してください。'); throw error; }
    },
    async resolve(subject) {
      const identity = await Identity.findOne({ channelId: config.channelId, subject }).lean();
      const user = identity ? await Users.findById(identity.user).select('+hash') : null;
      if (!eligibleLineUser(user)) throw fail('ログインできません。ID・パスワードでログインし、プロフィールでLINE連携を確認してください。');
      return { user, identity };
    },
    async unlink(user) {
      ensureEnabled();
      await Flow.deleteMany({ channelId: config.channelId, user });
      await Identity.deleteOne({ channelId: config.channelId, user });
    },
    async validSession(user, marker) {
      if (!enabled || marker.fingerprint !== passwordFingerprint(user)) return false;
      return Boolean(await Identity.exists({ _id: marker.identityId, user: user._id, channelId: config.channelId, subject: { $exists: true } }));
    }
  };
};

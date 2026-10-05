import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import mongoose from 'mongoose';
import ipaddr from 'ipaddr.js';

export const RATE_LIMIT_COLLECTION = 'chounaikai_auth_rate_limits';
const minute = 60 * 1000;
const policies = {
  login: { windowMs: 15 * minute, ip: 30, account: 15 },
  resetEmail: { windowMs: 60 * minute, ip: 10, account: 3 },
  reset: { windowMs: 15 * minute, ip: 20 },
  register: { windowMs: 60 * minute, ip: 10, account: 3 },
  invitationSend: { windowMs: 60 * minute, ip: 20, user: 10, account: 3 },
  token: { windowMs: 15 * minute, ip: 30 },
  password: { windowMs: 15 * minute, ip: 10, user: 5 }
};

export const authRatePolicy = req => {
  // Match case-insensitive and optional trailing slashes, like Express routes.
  const path = req.path.toLowerCase().replace(/\/+$/, '') || '/';
  if (req.method === 'POST') {
    if (['/login', '/api/auth/login'].includes(path)) return 'login';
    if (['/forgot-password', '/verification-email/resend'].includes(path)) return 'resetEmail';
    if (path === '/reset-password') return 'reset';
    if (path === '/register') return 'register';
    if (path === '/profile/password') return 'password';
    if (/^\/associations\/[^/]+\/household\/[^/]+\/members\/[^/]+\/invite$/.test(path)) return 'invitationSend';
    if (/^\/household-invitations\/[^/]+\/accept$/.test(path)) return 'token';
  }
  if (req.method === 'GET' && ['/reset-password', '/household-invitations', '/verify-email'].includes(path)) return 'token';
  return null;
};

export const rateLimitIpKey = value => {
  if (typeof value !== 'string' || !isIP(value)) return 'unknown';
  const address = ipaddr.process(value);
  if (address.kind() === 'ipv4') return address.toString();
  // One bucket per IPv6 /64, preventing unlimited attempts by rotating addresses.
  return address.parts.slice(0, 4).map(part => part.toString(16)).join(':') + '::/64';
};

export const createMongoRateStore = (connection = mongoose.connection) => ({
  async increment(key, expiresAt) {
    if (connection.readyState !== 1) throw new Error('rate_limit_store_unavailable');
    const collection = connection.collection(RATE_LIMIT_COLLECTION);
    const update = { $inc: { count: 1 }, $setOnInsert: { expiresAt } };
    try {
      const row = await collection.findOneAndUpdate({ _id: key }, update, {
        upsert: true, returnDocument: 'after', includeResultMetadata: false
      });
      return row.count;
    } catch (error) {
      // Two workers may try to insert the same first bucket simultaneously.
      if (error.code !== 11000) throw error;
      const row = await collection.findOneAndUpdate({ _id: key }, { $inc: { count: 1 } }, {
        returnDocument: 'after', includeResultMetadata: false
      });
      if (!row) throw new Error('rate_limit_store_unavailable');
      return row.count;
    }
  }
});

export const createMemoryRateStore = () => {
  const entries = new Map();
  return {
    async increment(key, expiresAt) {
      const now = Date.now();
      for (const [id, entry] of entries) if (entry.expiresAt <= now) entries.delete(id);
      if (!entries.has(key) && entries.size >= 10000) throw new Error('rate_limit_store_full');
      const count = (entries.get(key)?.count || 0) + 1;
      entries.set(key, { count, expiresAt });
      return count;
    }
  };
};

export const createAuthRateLimiter = ({ store, secret, authenticated = false, now = Date.now }) => async (req, res, next) => {
  const name = authRatePolicy(req);
  if (!name) return next();
  const policy = policies[name];
  const expiresAt = new Date((Math.floor(now() / policy.windowMs) + 1) * policy.windowMs);
  const buckets = [];
  if (authenticated) {
    if (policy.user && req.user?._id) buckets.push(['user', String(req.user._id), policy.user]);
  } else {
    buckets.push(['ip', rateLimitIpKey(req.ip || req.socket?.remoteAddress), policy.ip]);
    // Match the auth services' String conversion, including JSON arrays.
    const account = String((name === 'login' ? req.body?.identifier : req.body?.email) ?? '').trim().toLowerCase();
    if (policy.account && account) {
      buckets.push(['account', account, policy.account]);
    }
  }
  if (!buckets.length) return next();
  try {
    for (const [kind, identifier, limit] of buckets) {
      const digest = createHmac('sha256', secret).update(`${name}:${kind}:${identifier}`).digest('hex');
      const count = await store.increment(`${digest}:${expiresAt.getTime()}`, expiresAt);
      if (count > limit) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((expiresAt.getTime() - now()) / 1000))));
        res.set('Cache-Control', 'no-store');
        const message = '操作回数の上限に達しました。時間をおいて再度お試しください。';
        return req.originalUrl.toLowerCase().startsWith('/api/')
          ? res.status(429).json({ error: 'too_many_requests', message })
          : res.status(429).render('error', { title: 'しばらくお待ちください', message });
      }
    }
    return next();
  } catch {
    // Production must not silently bypass protection when the shared store fails.
    const error = new Error('現在この操作を利用できません。時間をおいて再度お試しください。');
    error.status = 503;
    return next(error);
  }
};

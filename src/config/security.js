import mongoose from 'mongoose';

export const parseTrustProxy = value => {
  const setting = String(value ?? '').trim();
  if (!setting || setting === 'false' || setting === '0') return false;
  // Never trust every sender: only explicit proxy addresses/CIDRs or hop counts.
  if (setting === 'true') throw new Error('TRUST_PROXY must be a hop count or trusted proxy addresses/CIDRs');
  if (/^[1-9]\d*$/.test(setting)) return Number(setting);
  return setting.split(',').map(entry => entry.trim()).filter(Boolean);
};

export const publicHttpsOrigin = value => {
  let url;
  try { url = new URL(value); } catch { throw new Error('PUBLIC_BASE_URL must be an HTTPS origin in production'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS origin in production');
  }
  return url.origin;
};

export const mongoSecurityOptions = (mongoUri, nodeEnv, { caFile, allowedHosts } = {}) => {
  const options = caFile ? { tlsCAFile: caFile } : {};
  if (nodeEnv !== 'production') return options;
  let parsed;
  try { parsed = new mongoose.mongo.MongoClient(mongoUri, options).options; }
  catch { throw new Error('Invalid MongoDB connection configuration'); }
  if (!parsed.credentials?.username || !parsed.credentials?.password) {
    throw new Error('Production MongoDB requires a dedicated authenticated database user');
  }
  if (!parsed.tls || parsed.tlsInsecure || parsed.tlsAllowInvalidCertificates || parsed.tlsAllowInvalidHostnames || parsed.rejectUnauthorized === false || parsed.checkServerIdentity) {
    throw new Error('Production MongoDB requires TLS with certificate and hostname verification');
  }
  const allowed = String(allowedHosts || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  const hosts = parsed.srvHost ? [parsed.srvHost] : parsed.hosts.map(host => host.host);
  if (!allowed.length || hosts.some(host => !allowed.includes(host.toLowerCase()))) {
    throw new Error('Production MongoDB hosts must be explicitly listed in MONGODB_ALLOWED_HOSTS');
  }
  return { ...options, tls: true, tlsAllowInvalidCertificates: false, tlsAllowInvalidHostnames: false };
};

// Fixie Socks supplies user:password@host:port. A full socks5:// URL is
// also accepted so other fixed-egress SOCKS5 services can use the same path.
export const mongoProxyOptions = value => {
  if (!value) return {};
  try {
    const raw = String(value).trim();
    const url = new URL(raw.includes('://') ? raw : `socks5://${raw}`);
    const port = Number(url.port || 1080);
    if (url.protocol !== 'socks5:' || !url.hostname || !url.username || !url.password
      || (url.pathname && url.pathname !== '/') || url.search || url.hash
      || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    return {
      proxyHost: url.hostname.replace(/^\[|\]$/g, ''), proxyPort: port,
      proxyUsername: decodeURIComponent(url.username), proxyPassword: decodeURIComponent(url.password)
    };
  } catch {
    // Never include credentials in the error text.
    throw new Error('MongoDB SOCKS5 proxy configuration is invalid');
  }
};

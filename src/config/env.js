import { mongoProxyOptions, mongoSecurityOptions, parseTrustProxy, publicHttpsOrigin } from './security.js';

const required = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export const loadConfig = () => {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const mongoUri = required('MONGODB_URI');
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:3003';
  if (nodeEnv === 'production') publicHttpsOrigin(publicBaseUrl);
  return {
    mongoUri,
    sessionSecret: required('CHOUNAIKAI_SESSION_SECRET'),
    port: Number(process.env.PORT || 3003),
    nodeEnv,
    publicBaseUrl,
    // Heroku terminates TLS at its router; direct deployments should use false
    // or an explicit list of reverse-proxy addresses instead.
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY ?? (nodeEnv === 'production' ? '1' : 'false')),
    mongoOptions: {
      ...mongoSecurityOptions(mongoUri, nodeEnv, {
        caFile: process.env.MONGODB_TLS_CA_FILE,
        allowedHosts: process.env.MONGODB_ALLOWED_HOSTS
      }),
      ...mongoProxyOptions(process.env.MONGODB_SOCKS_PROXY_URL || process.env.FIXIE_SOCKS_HOST)
    }
  };
};

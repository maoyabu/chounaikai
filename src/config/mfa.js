import { createHash } from 'node:crypto';

export const mfaEncryptionKey = (value, sessionSecret, nodeEnv) => {
  if (value) {
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('MFA_ENCRYPTION_KEY must be 64 hexadecimal characters');
    return Buffer.from(value, 'hex');
  }
  if (nodeEnv === 'production') throw new Error('MFA_ENCRYPTION_KEY is required in production');
  // Development only. Production always needs a separate, persistent key.
  return createHash('sha256').update(`chounaikai-development-mfa:${sessionSecret}`).digest();
};

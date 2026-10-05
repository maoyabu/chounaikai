import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const PERSONAL_DATA_FIELDS = Object.freeze({
  households: ['address.postalCode', 'address.street', 'address.building', 'phone'],
  annual_officers: ['address', 'phone', 'mobilePhone'],
  annual_leader_assignments: ['address', 'phone', 'mobilePhone']
});
const prefix = 'pii:v1:';
const fail = () => new Error('personal_data_encryption_failed');
export const isPersonalDataCiphertext = value => typeof value === 'string' && value.startsWith('pii:');

export const personalDataKeyring = (env = process.env) => {
  const version = env.PERSONAL_DATA_KEY_VERSION || '1';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(version)) throw new Error('PERSONAL_DATA_KEY_VERSION is invalid');
  if (!/^[a-f\d]{64}$/i.test(env.PERSONAL_DATA_ENCRYPTION_KEY || '')) throw new Error('PERSONAL_DATA_ENCRYPTION_KEY must be 64 hexadecimal characters');
  let old;
  try { old = JSON.parse(env.PERSONAL_DATA_PREVIOUS_KEYS || '{}'); } catch { throw new Error('PERSONAL_DATA_PREVIOUS_KEYS is invalid'); }
  if (!old || typeof old !== 'object' || Array.isArray(old)) throw new Error('PERSONAL_DATA_PREVIOUS_KEYS is invalid');
  const keys = new Map();
  for (const [id, value] of Object.entries(old)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || !/^[a-f\d]{64}$/i.test(value) || id === version) throw new Error('PERSONAL_DATA_PREVIOUS_KEYS is invalid');
    keys.set(id, Buffer.from(value, 'hex'));
  }
  keys.set(version, Buffer.from(env.PERSONAL_DATA_ENCRYPTION_KEY, 'hex'));
  if (env.MFA_ENCRYPTION_KEY && [...keys.values()].some(key => key.toString('hex') === env.MFA_ENCRYPTION_KEY.toLowerCase())) throw new Error('PERSONAL_DATA_ENCRYPTION_KEY must be separate from MFA_ENCRYPTION_KEY');
  return { version, keys };
};
const context = (collection, id, field) => {
  if (!PERSONAL_DATA_FIELDS[collection]?.includes(field) || !/^[a-f\d]{24}$/i.test(String(id))) throw fail();
  return Buffer.from(JSON.stringify(['chounaikai-personal-data', collection, String(id).toLowerCase(), field]));
};
export const encryptPersonalData = (value, collection, id, field, ring = personalDataKeyring()) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string' || isPersonalDataCiphertext(value)) throw fail();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.keys.get(ring.version), iv);
  cipher.setAAD(Buffer.concat([context(collection, id, field), Buffer.from(`:${ring.version}`)]));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${prefix}${ring.version}:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
};
export const decryptPersonalData = (value, collection, id, field, ring = personalDataKeyring()) => {
  if (value === null || value === undefined) return value;
  // Empty legacy fields contain no personal information; nonempty plaintext is rejected.
  if (value === '') return value;
  try {
    if (typeof value !== 'string' || !value.startsWith(prefix)) throw fail();
    const parts = value.slice(prefix.length).split(':');
    if (parts.length !== 4) throw fail();
    const [version, ivText, tagText, dataText] = parts;
    const decode = text => {
      const bytes = Buffer.from(text, 'base64url');
      if (bytes.toString('base64url') !== text) throw fail();
      return bytes;
    };
    const iv = decode(ivText), tag = decode(tagText), data = decode(dataText);
    if (iv.length !== 12 || tag.length !== 16 || !ring.keys.has(version)) throw fail();
    const decipher = createDecipheriv('aes-256-gcm', ring.keys.get(version), iv);
    decipher.setAAD(Buffer.concat([context(collection, id, field), Buffer.from(`:${version}`)]));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch { throw fail(); }
};

export const getPersonalDataPath = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
export const setPersonalDataPath = (object, path, value) => {
  const parts = path.split('.'); let target = object;
  for (const key of parts.slice(0, -1)) target = target[key] ||= {};
  target[parts.at(-1)] = value;
};

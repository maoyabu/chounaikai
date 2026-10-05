import { PERSONAL_DATA_FIELDS, personalDataKeyring, getPersonalDataPath, isPersonalDataCiphertext, encryptPersonalData, decryptPersonalData } from './personalDataCrypto.js';

// Raw driver access is intentional: model hooks reject unencrypted legacy reads.
// CAS compares the full set of inspected fields to avoid overwriting concurrent edits.
export const migratePersonalData = async (db, { apply = false, rotate = false, batchSize = 100, ring = personalDataKeyring() } = {}) => {
  const totals = {};
  for (const [name, fields] of Object.entries(PERSONAL_DATA_FIELDS)) {
    const stats = totals[name] = { scanned: 0, legacyFields: 0, encryptedFields: 0, emptyFields: 0, invalidFields: 0, pendingDocuments: 0, updatedDocuments: 0, conflicts: 0 };
    const collection = db.collection(name);
    // Project the full address object so a malformed legacy string isn't hidden
    // by MongoDB's dotted-field projection.
    const cursor = collection.find({}, { projection: { _id: 1, ...Object.fromEntries(fields.map(field => [field.split('.')[0], 1])) }, sort: { _id: 1 }, batchSize });
    try {
      for await (const document of cursor) {
        stats.scanned++;
        const set = {}, checks = []; let invalid = false;
        if (name === 'households' && document.address != null && (typeof document.address !== 'object' || Array.isArray(document.address) || document.address instanceof Date)) {
          stats.invalidFields++; continue;
        }
        for (const field of fields) {
          const value = getPersonalDataPath(document, field);
          checks.push(value === undefined ? { [field]: { $exists: false } } : { [field]: { $eq: value } });
          if (value === undefined || value === null || value === '') { stats.emptyFields++; continue; }
          try {
            if (isPersonalDataCiphertext(value)) {
              const plain = decryptPersonalData(value, name, document._id, field, ring);
              stats.encryptedFields++;
              if (rotate && value.split(':')[2] !== ring.version) set[field] = encryptPersonalData(plain, name, document._id, field, ring);
            } else {
              if (typeof value !== 'string') throw new Error('invalid');
              stats.legacyFields++;
              set[field] = encryptPersonalData(value, name, document._id, field, ring);
            }
          } catch { stats.invalidFields++; invalid = true; }
        }
        if (invalid || !Object.keys(set).length) continue;
        stats.pendingDocuments++;
        if (apply) {
          const result = await collection.updateOne({ _id: document._id, $and: checks }, { $set: set }, { writeConcern: { w: 'majority' } });
          if (result.matchedCount === 1) stats.updatedDocuments++;
          else stats.conflicts++;
        }
      }
    } finally { await cursor.close(); }
  }
  return totals;
};

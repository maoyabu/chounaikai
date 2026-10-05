import mongoose from 'mongoose';
import { PERSONAL_DATA_FIELDS, personalDataKeyring, encryptPersonalData, decryptPersonalData, getPersonalDataPath, setPersonalDataPath } from './personalDataCrypto.js';

// Application-facing documents are plaintext. Only the storage boundary encrypts.
// Raw collection calls deliberately bypass this boundary and are reserved for migration.
export const personalDataPlugin = (schema, { collection }) => {
  const paths = PERSONAL_DATA_FIELDS[collection];
  const originals = Symbol('personal-data-save-originals');
  const protectedPath = name => paths.some(path => name === path || path.startsWith(`${name}.`) || name.startsWith(`${path}.`));
  const transform = (object, operation) => {
    const ring = personalDataKeyring();
    if (collection === 'households' && object.address != null && (typeof object.address !== 'object' || Array.isArray(object.address) || object.address instanceof Date)) throw new Error('personal_data_encryption_failed');
    const converted = paths.map(path => [path, getPersonalDataPath(object, path)])
      .filter(([, value]) => value !== undefined)
      .map(([path, value]) => [path, operation(value, collection, object._id, path, ring)]);
    for (const [path, value] of converted) setPersonalDataPath(object, path, value);
  };
  const restore = doc => {
    if (!doc?.[originals]) return;
    for (const [path, value] of doc[originals]) doc.$__setValue(path, value);
    delete doc[originals];
  };
  schema.pre('init', function(raw) { transform(raw, decryptPersonalData); });
  schema.pre('save', function() {
    const raw = this.toObject({ getters: false, virtuals: false, transform: false });
    const saved = paths.map(path => [path, getPersonalDataPath(raw, path)]).filter(([, value]) => value !== undefined);
    transform(raw, encryptPersonalData);
    this[originals] = saved;
    for (const [path] of saved) this.$__setValue(path, getPersonalDataPath(raw, path));
  });
  schema.post('save', function(doc) { restore(doc); });
  schema.post('save', function(error, doc, next) { restore(doc || this); next(error); });

  const decryptResult = result => {
    for (const value of Array.isArray(result) ? result : [result]) {
      if (value && !(value instanceof mongoose.Document)) transform(value, decryptPersonalData);
    }
  };
  for (const operation of ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete']) {
    schema.post(operation, function(result) { decryptResult(result); });
  }
  const assertFilter = filter => {
    for (const [key, value] of Object.entries(filter || {})) {
      if (protectedPath(key) || ['$expr', '$where', '$jsonSchema'].includes(key)) throw new Error('personal_data_search_not_supported');
      if (key.startsWith('$') && value && typeof value === 'object') {
        for (const child of Array.isArray(value) ? value : [value]) assertFilter(child);
      }
    }
  };
  const encryptUpdate = (update, filter, many = false) => {
    personalDataKeyring();
    if (Array.isArray(update)) throw new Error('personal_data_update_pipeline_not_supported');
    for (const [operator, payload] of Object.entries(update || {})) {
      if (!operator.startsWith('$')) throw new Error('personal_data_replacement_not_supported');
      for (const [path, value] of Object.entries(payload || {})) {
        if (operator === '$rename' && (protectedPath(path) || protectedPath(String(value)))) throw new Error('personal_data_update_not_supported');
        if (!protectedPath(path)) continue;
        if (operator === '$unset') continue;
        if (!['$set', '$setOnInsert'].includes(operator) || many || !/^[a-f\d]{24}$/i.test(String(filter?._id))) throw new Error('personal_data_update_requires_single_id');
        if (paths.includes(path)) payload[path] = encryptPersonalData(value, collection, filter._id, path);
        else {
          if (paths.some(candidate => path.startsWith(`${candidate}.`))) throw new Error('personal_data_update_not_supported');
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('personal_data_update_not_supported');
          for (const child of paths.filter(candidate => candidate.startsWith(`${path}.`))) {
            const relative = child.slice(path.length + 1), item = getPersonalDataPath(value, relative);
            if (item !== undefined) setPersonalDataPath(value, relative, encryptPersonalData(item, collection, filter._id, child));
          }
        }
      }
    }
  };
  for (const operation of ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'countDocuments', 'distinct']) {
    schema.pre(operation, function() {
      personalDataKeyring(); assertFilter(this.getFilter());
      if (this.projection()?._id === 0 || this.projection()?._id === false) throw new Error('personal_data_projection_requires_id');
      if (Object.keys(this.getOptions().sort || {}).some(protectedPath) || (this.op === 'distinct' && protectedPath(this._distinct))) throw new Error('personal_data_search_not_supported');
      if (['updateOne', 'updateMany', 'findOneAndUpdate'].includes(operation)) encryptUpdate(this.getUpdate(), this.getFilter(), operation === 'updateMany');
    });
  }
  for (const operation of ['replaceOne', 'findOneAndReplace', 'aggregate']) schema.pre(operation, function() { throw new Error('personal_data_operation_not_supported'); });
  schema.pre('insertMany', function(next, documents, options) {
    try {
      if (options?.rawResult || options?.lean) throw new Error('personal_data_insert_options_not_supported');
      for (const document of documents) {
        if (document instanceof mongoose.Document) throw new Error('personal_data_insert_requires_plain_objects');
        document._id ||= new mongoose.Types.ObjectId();
        transform(document, encryptPersonalData);
      }
      next();
    } catch (error) { next(error); }
  });
  schema.post('insertMany', function(documents) {
    for (const document of documents) {
      const raw = document.toObject({ transform: false }); transform(raw, decryptPersonalData);
      for (const path of paths) if (getPersonalDataPath(raw, path) !== undefined) document.$__setValue(path, getPersonalDataPath(raw, path));
    }
  });
  // bulkWrite doesn't run query/save hooks. Require callers to use the covered APIs.
  schema.pre('bulkWrite', function() { throw new Error('personal_data_bulk_write_not_supported'); });
};

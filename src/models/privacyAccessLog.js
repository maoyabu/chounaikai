import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  requestId: { type: String, required: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  actorName: { type: String, maxlength: 160 },
  actorKind: { type: String, enum: ['system_admin', 'user', 'anonymous'], required: true },
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', default: null },
  associations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation' }],
  action: { type: String, enum: ['view', 'download', 'export'], required: true },
  category: { type: String, required: true },
  resource: { type: String, required: true },
  route: { type: String, required: true },
  method: { type: String, required: true },
  ip: { type: String, maxlength: 64 },
  // Identifiers only: never duplicate the underlying personal information.
  targets: [{ type: String, maxlength: 180 }],
  targetCount: { type: Number, required: true },
  targetsTruncated: { type: Boolean, default: false }
}, { collection: 'chounaikai_privacy_access_logs', timestamps: { createdAt: true, updatedAt: false }, writeConcern: { w: 'majority', wtimeout: 5000 } });
schema.index({ createdAt: -1, _id: -1 });
schema.index({ actor: 1, createdAt: -1, _id: -1 });
schema.index({ associations: 1, createdAt: -1, _id: -1 });
schema.index({ category: 1, createdAt: -1, _id: -1 });
schema.index({ targets: 1, createdAt: -1, _id: -1 });
// This application's audit history is append-only. Database administrators can
// still alter it; external immutable storage is a separate operational concern.
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  schema.pre(operation, function () { throw new Error('privacy_access_log_is_append_only'); });
}
schema.pre('save', function () { if (!this.isNew) throw new Error('privacy_access_log_is_append_only'); });
for (const operation of ['deleteOne', 'updateOne']) {
  schema.pre(operation, { document: true, query: false }, function () { throw new Error('privacy_access_log_is_append_only'); });
}
schema.pre('bulkWrite', function (next, operations) {
  if (operations.some(operation => !operation.insertOne)) return next(new Error('privacy_access_log_is_append_only'));
  next();
});
export const PrivacyAccessLog = mongoose.models.PrivacyAccessLog || mongoose.model('PrivacyAccessLog', schema);

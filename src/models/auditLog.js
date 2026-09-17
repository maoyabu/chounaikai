import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true, index: true },
  targetType: { type: String, required: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  before: mongoose.Schema.Types.Mixed,
  after: mongoose.Schema.Types.Mixed,
  requestId: String,
  ip: String
}, { timestamps: { createdAt: true, updatedAt: false }, collection: 'association_audit_logs' });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);

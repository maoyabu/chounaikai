import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  encryptedSecret: { type: String, required: true, select: false },
  recoveryCodeDigests: { type: [String], select: false },
  enabledAt: { type: Date, required: true },
  revision: { type: String, required: true },
  lastUsedStep: { type: Number, required: true }
}, { timestamps: true, collection: 'chounaikai_mfa_credentials' });

const eventSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  action: { type: String, required: true, enum: ['enrolled', 'verified', 'recovery_used', 'authenticator_changed', 'recovery_regenerated', 'verification_failed'] }
}, { timestamps: { createdAt: true, updatedAt: false }, collection: 'chounaikai_mfa_events' });

export const MfaCredential = mongoose.model('MfaCredential', schema);
export const MfaEvent = mongoose.model('MfaEvent', eventSchema);

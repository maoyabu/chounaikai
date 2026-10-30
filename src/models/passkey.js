import mongoose from 'mongoose';

const accountSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  rpId: { type: String, required: true },
  userHandle: { type: String, required: true }
}, { timestamps: true, collection: 'chounaikai_passkey_accounts' });
accountSchema.index({ user: 1, rpId: 1 }, { unique: true });
accountSchema.index({ userHandle: 1, rpId: 1 }, { unique: true });

const credentialSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  rpId: { type: String, required: true },
  credentialId: { type: String, required: true },
  publicKey: { type: Buffer, required: true },
  counter: { type: Number, required: true, default: 0 },
  version: { type: Number, required: true, default: 0 },
  transports: [{ type: String }],
  deviceType: String,
  backedUp: Boolean,
  name: { type: String, default: 'パスキー' },
  lastUsedAt: Date
}, { timestamps: true, collection: 'chounaikai_passkey_credentials' });
credentialSchema.index({ rpId: 1, credentialId: 1 }, { unique: true });
credentialSchema.index({ user: 1, rpId: 1 });

export const PasskeyAccount = mongoose.models.PasskeyAccount || mongoose.model('PasskeyAccount', accountSchema);
export const PasskeyCredential = mongoose.models.PasskeyCredential || mongoose.model('PasskeyCredential', credentialSchema);

const flowSchema = new mongoose.Schema({
  flowId: { type: String, required: true, unique: true },
  bindingHash: { type: String, required: true },
  rpId: { type: String, required: true },
  mode: { type: String, enum: ['register', 'authenticate'], required: true },
  challenge: { type: String, required: true },
  user: mongoose.Schema.Types.ObjectId,
  fingerprint: String,
  userHandle: String,
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } }
}, { collection: 'chounaikai_passkey_flows' });
export const PasskeyFlow = mongoose.models.PasskeyFlow || mongoose.model('PasskeyFlow', flowSchema);

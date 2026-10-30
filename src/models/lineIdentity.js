import mongoose from 'mongoose';

const identity = new mongoose.Schema({
  channelId: { type: String, required: true },
  subject: String,
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true, collection: 'chounaikai_line_identities' });
identity.index({ channelId: 1, subject: 1 }, { unique: true, partialFilterExpression: { subject: { $type: 'string' } } });
identity.index({ channelId: 1, user: 1 }, { unique: true });

const flow = new mongoose.Schema({
  stateHash: { type: String, required: true, unique: true },
  bindingHash: { type: String, required: true },
  channelId: { type: String, required: true },
  mode: { type: String, enum: ['login', 'link'], required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  fingerprint: String,
  identityId: mongoose.Schema.Types.ObjectId,
  nonce: { type: String, required: true },
  verifier: { type: String, required: true },
  expiresAt: { type: Date, required: true }
}, { collection: 'chounaikai_line_flows' });
flow.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LineIdentity = mongoose.model('LineIdentity', identity);
export const LineFlow = mongoose.model('LineFlow', flow);

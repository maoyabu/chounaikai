import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  token: { type: String, required: true },
  environment: { type: String, enum: ['development', 'production'], required: true },
  topic: { type: String, required: true },
  sessionKey: { type: String, required: true, index: true },
  sessionId: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  disabledAt: Date
}, { timestamps: true });
schema.index({ token: 1, environment: 1, topic: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const ApnsSubscription = mongoose.models.ApnsSubscription || mongoose.model('ApnsSubscription', schema);

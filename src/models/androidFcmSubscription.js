import mongoose from 'mongoose';

// Android (Firebase Cloud Messaging) device registrations. Mirrors ApnsSubscription:
// a token belongs to one account and one login session, and expires with it.
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  token: { type: String, required: true },
  packageName: { type: String, required: true },
  sessionKey: { type: String, required: true, index: true },
  sessionId: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  disabledAt: Date
}, { timestamps: true });
schema.index({ token: 1, packageName: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AndroidFcmSubscription = mongoose.models.AndroidFcmSubscription || mongoose.model('AndroidFcmSubscription', schema);

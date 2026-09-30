import mongoose from 'mongoose';

const pushSubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  endpoint: { type: String, required: true },
  keys: { p256dh: String, auth: String },
  userAgent: String,
  lastUsedAt: { type: Date, default: Date.now },
  disabledAt: Date
}, { timestamps: true, collection: 'push_subscriptions' });

pushSubscriptionSchema.index({ user: 1, endpoint: 1 }, { unique: true });

export const PushSubscription = mongoose.models.PushSubscription || mongoose.model('PushSubscription', pushSubscriptionSchema);

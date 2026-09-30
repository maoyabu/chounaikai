import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // Keep legacy values because existing records and route logic use them.
  // New code should use the dot-separated event IDs documented in the notification spec.
  type: { type: String, required: true, index: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  relatedType: String,
  relatedId: mongoose.Schema.Types.ObjectId,
  readAt: Date,
  queuedAt: { type: Date, default: Date.now },
  deliveryClaimedAt: Date,
  delivery: {
    push: { status: { type: String, enum: ['pending', 'sent', 'skipped', 'failed'], default: 'pending' }, sentAt: Date, error: String },
    email: { status: { type: String, enum: ['pending', 'sent', 'skipped', 'failed'], default: 'pending' }, sentAt: Date, error: String }
  },
  deliveryKey: { type: String, index: true }
}, { timestamps: true, collection: 'notifications' });

export const Notification = mongoose.model('Notification', notificationSchema);

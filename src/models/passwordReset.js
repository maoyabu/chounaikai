import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  tokenDigest: { type: String, required: true, unique: true, select: false },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  sentAt: { type: Date, required: true }
}, { collection: 'password_resets' });

export const PasswordReset = mongoose.model('PasswordReset', schema);

import mongoose from 'mongoose';

const pendingUserRegistrationSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  displayname: { type: String, trim: true },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  salt: { type: String, required: true, select: false },
  hash: { type: String, required: true, select: false },
  tokenDigest: { type: String, required: true, unique: true, select: false },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  verificationSentAt: { type: Date, required: true },
  residentMode: { type: String, enum: ['representative', 'general'], default: 'representative' },
  householdHeadEmail: { type: String, trim: true, lowercase: true },
  householdInvitation: { type: mongoose.Schema.Types.ObjectId, ref: 'Invitation' },
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation' },
  registrationPurpose: { type: String, enum: ['join', 'create'] }
}, { timestamps: true, collection: 'pending_user_registrations' });

export const PendingUserRegistration = mongoose.model('PendingUserRegistration', pendingUserRegistrationSchema);
